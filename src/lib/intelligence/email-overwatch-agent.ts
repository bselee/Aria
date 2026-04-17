import { gmail as GmailApi } from "@googleapis/gmail";
import { z } from "zod";
import { unifiedObjectGeneration } from "./llm";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { enqueueDefaultInboxInvoice } from "./nightshift-agent";
import { upsertShipmentEvidence } from "../tracking/shipment-intelligence";
import { VendorCommsAgent, type VendorCommContext } from "./vendor-comms-agent";
import { recordOverwatchArchive, recordOverwatchDraftCreated, recordOverwatchHeld } from "./email-feedback";

type OverwatchIntent = "PROMOTIONAL" | "INLINE_INVOICE" | "ROUTINE_INFO" | "REQUIRES_HUMAN";
type OverwatchState =
    | "po_sent_waiting_for_reply"
    | "vendor_acknowledged_waiting_for_eta"
    | "eta_received_waiting_for_ship_or_tracking"
    | "tracking_received"
    | "bol_or_pro_received"
    | "paid_invoice_routed_waiting_for_reconcile"
    | "reconcile_verified"
    | "human_review_required"
    | "closed_confident";

type QueueRow = {
    id: string | number;
    gmail_message_id: string;
    thread_id?: string | null;
    from_email?: string | null;
    subject?: string | null;
    body_snippet?: string | null;
    body_text?: string | null;
    has_pdf?: boolean | null;
    source_inbox?: string | null;
};

type ThreadStateRow = {
    thread_id: string;
    gmail_message_id?: string | null;
    source_inbox?: string | null;
    intent?: string | null;
    po_number?: string | null;
    vendor_email?: string | null;
    vendor_name?: string | null;
    state?: OverwatchState | null;
    confidence?: number | null;
    uncertain_reason?: string | null;
    last_vendor_reply_at?: string | null;
    last_bill_reply_at?: string | null;
    eta_text?: string | null;
    eta_resolved_at?: string | null;
    tracking_numbers?: string[] | null;
    bol_or_pro_numbers?: string[] | null;
    next_follow_up_at?: string | null;
    follow_up_count?: number | null;
    last_draft_id?: string | null;
    downstream_status?: string | null;
    resolved_at?: string | null;
    updated_at?: string | null;
};

type POConversation = {
    poNumber: string;
    vendorName: string;
    vendorEmail: string;
    threadId: string;
    messageId: string;
    sentAt: Date;
    lastBillReplyAt: Date | null;
    lastVendorReplyAt: Date | null;
    latestEtaText: string | null;
    trackingNumbers: string[];
    bolOrProNumbers: string[];
    hasVendorReply: boolean;
    subject: string;
};

const INTENT_SCHEMA = z.object({
    intent: z.enum(["PROMOTIONAL", "INLINE_INVOICE", "ROUTINE_INFO", "REQUIRES_HUMAN"]),
    reasoning: z.string().optional(),
});

const SUCCESSFUL_INVOICE_OUTCOMES = new Set(["reconciled", "already_processed"]);
const KNOWN_TRACKING_WORDS = /(tracking|tracking number|shipment|shipped|delivered|in transit)/i;
const KNOWN_BOL_WORDS = /\b(?:bol|b\/l|bill of lading|pro(?: number)?|freight bill)\b/i;
const ETA_PATTERNS = [
    /\bnext week\b/i,
    /\btomorrow\b/i,
    /\bearly next week\b/i,
    /\blate next week\b/i,
    /\bthis week\b/i,
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
];

export class EmailOverwatchAgent {
    private tokenIdentifier: string;
    private gmail: any | null = null;
    private vendorComms: VendorCommsAgent | null = null;
    private labelCache = new Map<string, string>();

    constructor(tokenIdentifier: string = "default") {
        this.tokenIdentifier = tokenIdentifier;
    }

    async processInboxQueue(maxResults: number = 25): Promise<void> {
        const supabase = createClient();
        if (!supabase) {
            console.warn("[email-overwatch] Supabase unavailable during inbox processing");
            return;
        }

        const { data: messages, error } = await supabase
            .from("email_inbox_queue")
            .select("*")
            .eq("processed_by_overwatch", false)
            .eq("source_inbox", this.tokenIdentifier)
            .limit(maxResults);

        if (error || !messages?.length) {
            return;
        }

        for (const row of messages as QueueRow[]) {
            const intent = await this.classifyIntent(row);
            try {
                if (intent === "PROMOTIONAL") {
                    await this.archiveMessage(row.gmail_message_id);
                    await this.upsertThreadState({
                        thread_id: row.thread_id || row.gmail_message_id,
                        gmail_message_id: row.gmail_message_id,
                        source_inbox: this.tokenIdentifier,
                        intent,
                        state: "closed_confident",
                        confidence: 0.98,
                        uncertain_reason: null,
                        downstream_status: null,
                        resolved_at: new Date().toISOString(),
                    });
                    await recordOverwatchArchive({
                        gmailMessageId: row.gmail_message_id,
                        threadId: row.thread_id || row.gmail_message_id,
                        fromEmail: row.from_email || "",
                        subject: row.subject || "",
                        intent,
                        reason: "confident_promotional_archive",
                        state: "closed_confident",
                    });
                } else if (intent === "INLINE_INVOICE") {
                    await enqueueDefaultInboxInvoice(
                        row.gmail_message_id,
                        row.from_email || "",
                        row.subject || "",
                        row.body_text || row.body_snippet || "",
                    );
                    await this.upsertThreadState({
                        thread_id: row.thread_id || row.gmail_message_id,
                        gmail_message_id: row.gmail_message_id,
                        source_inbox: this.tokenIdentifier,
                        intent,
                        state: "paid_invoice_routed_waiting_for_reconcile",
                        confidence: 0.95,
                        uncertain_reason: null,
                        downstream_status: "queued_for_nightshift",
                    });
                } else {
                    await this.upsertThreadState({
                        thread_id: row.thread_id || row.gmail_message_id,
                        gmail_message_id: row.gmail_message_id,
                        source_inbox: this.tokenIdentifier,
                        intent,
                        state: "human_review_required",
                        confidence: 0.4,
                        uncertain_reason: "needs_human_triage",
                    });
                    await recordOverwatchHeld({
                        gmailMessageId: row.gmail_message_id,
                        threadId: row.thread_id || row.gmail_message_id,
                        fromEmail: row.from_email || "",
                        subject: row.subject || "",
                        state: "human_review_required",
                        reason: "needs_human_triage",
                    });
                }

                await supabase
                    .from("email_inbox_queue")
                    .update({
                        processed_by_overwatch: true,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", row.id);
            } catch (err: any) {
                console.error(`[email-overwatch] Failed processing ${row.gmail_message_id}:`, err?.message ?? err);
            }
        }
    }

    async runReminderSweep(): Promise<void> {
        await this.verifyDownstreamInvoices();
        await this.evaluatePOSends();
    }

    private async getGmail() {
        if (this.gmail) return this.gmail;
        const auth = await getAuthenticatedClient(this.tokenIdentifier);
        this.gmail = GmailApi({ version: "v1", auth });
        return this.gmail;
    }

    private async getVendorComms() {
        if (this.vendorComms) return this.vendorComms;
        this.vendorComms = new VendorCommsAgent(await this.getGmail());
        return this.vendorComms;
    }

    private async classifyIntent(row: QueueRow): Promise<OverwatchIntent> {
        const subject = row.subject || "";
        const text = `${subject}\n${row.body_text || row.body_snippet || ""}`;

        if (this.looksPromotional(subject, text)) return "PROMOTIONAL";
        if (this.looksInlineInvoice(subject, text, !!row.has_pdf)) return "INLINE_INVOICE";

        try {
            const result = await unifiedObjectGeneration({
                system: "Classify bill.selee inbox email intent. Use REQUIRES_HUMAN if uncertain.",
                prompt: `From: ${row.from_email || ""}\nSubject: ${subject}\nBody: ${text}\nReturn the safest intent.`,
                schema: INTENT_SCHEMA,
                schemaName: "EmailOverwatchIntent",
            }) as { intent?: OverwatchIntent };
            return result.intent || "REQUIRES_HUMAN";
        } catch {
            return "REQUIRES_HUMAN";
        }
    }

    private looksPromotional(subject: string, text: string): boolean {
        return /(sale|newsletter|promo|promotion|marketing|save \d+%|special offer)/i.test(`${subject}\n${text}`);
    }

    private looksInlineInvoice(subject: string, text: string, hasPdf: boolean): boolean {
        if (hasPdf) return false;
        const haystack = `${subject}\n${text}`;
        const hasPO = /\bpo\s*#?\s*\d{4,}\b/i.test(haystack);
        const hasMoney = /\$\s*\d[\d,]*(?:\.\d{2})?/.test(text) || /\b\d[\d,]*\.\d{2}\b/.test(text);
        const hasInvoiceSignals = /\b(total|invoice|freight|subtotal|amount due|paid|charges?)\b/i.test(text);
        return hasPO && hasMoney && hasInvoiceSignals;
    }

    private async verifyDownstreamInvoices(): Promise<void> {
        const supabase = createClient();
        if (!supabase) return;

        const { data } = await supabase
            .from("email_overwatch_threads")
            .select("*")
            .in("state", ["paid_invoice_routed_waiting_for_reconcile"])
            .limit(200);

        for (const row of (data || []) as ThreadStateRow[]) {
            const { data: task } = await supabase
                .from("nightshift_queue")
                .select("status, result, error")
                .eq("gmail_message_id", row.gmail_message_id)
                .eq("task_type", "default_inbox_invoice")
                .maybeSingle();

            if (!task) continue;

            const outcome = task.result?.outcome || task.status || task.error || "unknown";

            if (task.status === "completed" && SUCCESSFUL_INVOICE_OUTCOMES.has(outcome)) {
                const labelId = await this.ensureLabel("Invoices");
                await this.archiveMessage(row.gmail_message_id!, labelId ? [labelId] : []);
                await this.updateThreadState(row.thread_id, {
                    state: "closed_confident",
                    downstream_status: outcome,
                    uncertain_reason: null,
                    resolved_at: new Date().toISOString(),
                });
                await recordOverwatchArchive({
                    gmailMessageId: row.gmail_message_id!,
                    threadId: row.thread_id,
                    fromEmail: row.vendor_email || "",
                    subject: row.po_number ? `PO #${row.po_number} paid invoice` : "Paid invoice",
                    intent: "INLINE_INVOICE",
                    reason: "downstream_reconcile_verified",
                    state: "closed_confident",
                });
            } else if (task.status === "failed" || !SUCCESSFUL_INVOICE_OUTCOMES.has(outcome)) {
                await this.updateThreadState(row.thread_id, {
                    state: "human_review_required",
                    uncertain_reason: "downstream_reconcile_failed",
                    downstream_status: outcome,
                });
                await recordOverwatchHeld({
                    gmailMessageId: row.gmail_message_id!,
                    threadId: row.thread_id,
                    fromEmail: row.vendor_email || "",
                    subject: row.po_number ? `PO #${row.po_number} paid invoice` : "Paid invoice",
                    state: "human_review_required",
                    reason: "downstream_reconcile_failed",
                    poNumber: row.po_number || null,
                    downstreamStatus: outcome,
                });
            }
        }
    }

    private async evaluatePOSends(): Promise<void> {
        const supabase = createClient();
        if (!supabase) return;

        const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
        const { data: poSends } = await supabase
            .from("po_sends")
            .select("*")
            .is("completed_at", null)
            .gte("sent_at", since)
            .limit(250);

        for (const row of (poSends || []) as Array<Record<string, any>>) {
            const gmail = await this.getGmail();
            const msgRes = await gmail.users.messages.get({ userId: "me", id: row.gmail_message_id });
            const threadId = msgRes.data.threadId || row.gmail_message_id;
            const threadRes = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
            const existingState = await this.getThreadState(threadId);
            const conversation = this.summarizePOThread({
                poNumber: row.po_number,
                vendorName: row.vendor_name || this.extractVendorName(threadRes.data.messages?.[0]),
                vendorEmail: row.sent_to_email || "",
                threadId,
                messageId: row.gmail_message_id,
                sentAt: new Date(row.sent_at),
                subject: this.extractSubject(threadRes.data.messages?.[0]) || `BuildASoil PO # ${row.po_number}`,
                messages: threadRes.data.messages || [],
            });

            const now = Date.now();

            if (conversation.trackingNumbers.length > 0 || conversation.bolOrProNumbers.length > 0) {
                await upsertShipmentEvidence({
                    poNumber: conversation.poNumber,
                    trackingNumbers: conversation.trackingNumbers,
                    bolNumbers: conversation.bolOrProNumbers,
                    source: "email_overwatch",
                    rawEvidence: conversation.subject,
                });

                await this.upsertThreadState({
                    thread_id: threadId,
                    gmail_message_id: row.gmail_message_id,
                    source_inbox: this.tokenIdentifier,
                    intent: "PO_THREAD",
                    po_number: conversation.poNumber,
                    vendor_email: conversation.vendorEmail,
                    vendor_name: conversation.vendorName,
                    state: conversation.bolOrProNumbers.length > 0 ? "bol_or_pro_received" : "tracking_received",
                    confidence: 0.97,
                    uncertain_reason: null,
                    last_vendor_reply_at: conversation.lastVendorReplyAt?.toISOString() || null,
                    last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                    tracking_numbers: conversation.trackingNumbers,
                    bol_or_pro_numbers: conversation.bolOrProNumbers,
                    resolved_at: new Date().toISOString(),
                });
                continue;
            }

            if (conversation.latestEtaText) {
                await this.upsertThreadState({
                    thread_id: threadId,
                    gmail_message_id: row.gmail_message_id,
                    source_inbox: this.tokenIdentifier,
                    intent: "PO_THREAD",
                    po_number: conversation.poNumber,
                    vendor_email: conversation.vendorEmail,
                    vendor_name: conversation.vendorName,
                    state: "eta_received_waiting_for_ship_or_tracking",
                    confidence: 0.9,
                    uncertain_reason: null,
                    last_vendor_reply_at: conversation.lastVendorReplyAt?.toISOString() || null,
                    last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                    eta_text: conversation.latestEtaText,
                    eta_resolved_at: conversation.lastVendorReplyAt?.toISOString() || null,
                    next_follow_up_at: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(),
                    follow_up_count: existingState?.follow_up_count || 0,
                    tracking_numbers: conversation.trackingNumbers,
                    bol_or_pro_numbers: conversation.bolOrProNumbers,
                });
                continue;
            }

            if (conversation.hasVendorReply) {
                const currentCount = existingState?.follow_up_count || 0;
                const due = !existingState?.next_follow_up_at || new Date(existingState.next_follow_up_at).getTime() <= now;
                if (due) {
                    const draft = await this.createDraft(conversation, currentCount + 1, "eta_request");
                    await this.upsertThreadState({
                        thread_id: threadId,
                        gmail_message_id: row.gmail_message_id,
                        source_inbox: this.tokenIdentifier,
                        intent: "PO_THREAD",
                        po_number: conversation.poNumber,
                        vendor_email: conversation.vendorEmail,
                        vendor_name: conversation.vendorName,
                        state: "vendor_acknowledged_waiting_for_eta",
                        confidence: 0.88,
                        uncertain_reason: null,
                        last_vendor_reply_at: conversation.lastVendorReplyAt?.toISOString() || null,
                        last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                        next_follow_up_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
                        follow_up_count: currentCount + 1,
                        last_draft_id: draft.draftId,
                    });
                } else {
                    await this.upsertThreadState({
                        thread_id: threadId,
                        gmail_message_id: row.gmail_message_id,
                        source_inbox: this.tokenIdentifier,
                        intent: "PO_THREAD",
                        po_number: conversation.poNumber,
                        vendor_email: conversation.vendorEmail,
                        vendor_name: conversation.vendorName,
                        state: "vendor_acknowledged_waiting_for_eta",
                        confidence: 0.82,
                        uncertain_reason: null,
                        last_vendor_reply_at: conversation.lastVendorReplyAt?.toISOString() || null,
                        last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                    });
                }
                continue;
            }

            const followUpCount = existingState?.follow_up_count || 0;
            const ageMs = now - conversation.sentAt.getTime();
            const thresholdMs = followUpCount === 0 ? 2 * 24 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
            const draftDue = ageMs >= thresholdMs && (!existingState?.next_follow_up_at || new Date(existingState.next_follow_up_at).getTime() <= now);

            if (draftDue) {
                const nextCount = followUpCount + 1;
                const draft = await this.createDraft(conversation, nextCount, "reply");
                await this.upsertThreadState({
                    thread_id: threadId,
                    gmail_message_id: row.gmail_message_id,
                    source_inbox: this.tokenIdentifier,
                    intent: "PO_THREAD",
                    po_number: conversation.poNumber,
                    vendor_email: conversation.vendorEmail,
                    vendor_name: conversation.vendorName,
                    state: "po_sent_waiting_for_reply",
                    confidence: 0.9,
                    uncertain_reason: null,
                    last_vendor_reply_at: null,
                    last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                    next_follow_up_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
                    follow_up_count: nextCount,
                    last_draft_id: draft.draftId,
                });
            } else {
                await this.upsertThreadState({
                    thread_id: threadId,
                    gmail_message_id: row.gmail_message_id,
                    source_inbox: this.tokenIdentifier,
                    intent: "PO_THREAD",
                    po_number: conversation.poNumber,
                    vendor_email: conversation.vendorEmail,
                    vendor_name: conversation.vendorName,
                    state: "po_sent_waiting_for_reply",
                    confidence: 0.82,
                    uncertain_reason: null,
                    last_vendor_reply_at: null,
                    last_bill_reply_at: conversation.lastBillReplyAt?.toISOString() || null,
                    follow_up_count: followUpCount,
                });
            }
        }
    }

    private async createDraft(conversation: POConversation, followUpCount: number, mode: "reply" | "eta_request") {
        const comms = await this.getVendorComms();
        const context: VendorCommContext = {
            poNumber: conversation.poNumber,
            vendorEmail: conversation.vendorEmail,
            vendorName: conversation.vendorName,
            subject: conversation.subject,
            threadId: conversation.threadId,
            messageId: conversation.messageId,
            sentAt: conversation.sentAt,
            hasTracking: conversation.trackingNumbers.length > 0 || conversation.bolOrProNumbers.length > 0,
            trackingQuality: "none",
            responseType: mode === "eta_request" ? "clarify" : followUpCount > 1 ? "follow_up_l2" : "follow_up_l1",
        };

        const draft = await comms.createFollowUpDraft(context, followUpCount, mode);
        await recordOverwatchDraftCreated({
            gmailMessageId: conversation.messageId,
            threadId: conversation.threadId,
            fromEmail: conversation.vendorEmail,
            subject: conversation.subject,
            poNumber: conversation.poNumber,
            vendorName: conversation.vendorName,
            draftId: draft.draftId,
            followUpCount,
            mode,
        });
        return draft;
    }

    private summarizePOThread(input: {
        poNumber: string;
        vendorName: string;
        vendorEmail: string;
        threadId: string;
        messageId: string;
        sentAt: Date;
        subject: string;
        messages: any[];
    }): POConversation {
        let lastBillReplyAt: Date | null = null;
        let lastVendorReplyAt: Date | null = null;
        let latestEtaText: string | null = null;
        const trackingNumbers = new Set<string>();
        const bolOrProNumbers = new Set<string>();

        for (const message of input.messages || []) {
            const from = this.extractHeader(message, "From");
            const date = this.parseInternalDate(message.internalDate);
            const body = this.extractBodyText(message);
            const combined = `${this.extractHeader(message, "Subject")}\n${body}`;
            const isBill = /buildasoil\.com/i.test(from);

            if (isBill) {
                if (!lastBillReplyAt || date > lastBillReplyAt) lastBillReplyAt = date;
                continue;
            }

            if (!lastVendorReplyAt || date > lastVendorReplyAt) lastVendorReplyAt = date;

            const eta = this.extractEtaText(combined);
            if (eta) latestEtaText = eta;

            for (const tracking of this.extractTrackingNumbers(combined)) {
                trackingNumbers.add(tracking);
            }
            for (const bol of this.extractBolOrProNumbers(combined)) {
                bolOrProNumbers.add(bol);
            }
        }

        return {
            poNumber: input.poNumber,
            vendorName: input.vendorName,
            vendorEmail: input.vendorEmail,
            threadId: input.threadId,
            messageId: input.messageId,
            sentAt: input.sentAt,
            lastBillReplyAt,
            lastVendorReplyAt,
            latestEtaText,
            trackingNumbers: [...trackingNumbers],
            bolOrProNumbers: [...bolOrProNumbers],
            hasVendorReply: !!lastVendorReplyAt,
            subject: input.subject,
        };
    }

    private extractTrackingNumbers(text: string): string[] {
        if (!KNOWN_TRACKING_WORDS.test(text)) return [];
        const matches = text.match(/\b[A-Z0-9]{8,22}\b/g) || [];
        return matches.filter((value) => /\d/.test(value)).slice(0, 5);
    }

    private extractBolOrProNumbers(text: string): string[] {
        if (!KNOWN_BOL_WORDS.test(text)) return [];
        const matches = text.match(/\b(?:PRO|BOL)?[-:\s#]*([A-Z0-9]{5,20})\b/gi) || [];
        return matches
            .map((value) => value.replace(/^(?:PRO|BOL)[-:\s#]*/i, "").trim())
            .filter((value) => /\d/.test(value))
            .slice(0, 5);
    }

    private extractEtaText(text: string): string | null {
        for (const pattern of ETA_PATTERNS) {
            const match = text.match(pattern);
            if (match) return match[0].toLowerCase();
        }
        return null;
    }

    private async archiveMessage(gmailMessageId: string, addLabelIds: string[] = []) {
        const gmail = await this.getGmail();
        const requestBody: Record<string, unknown> = {
            removeLabelIds: ["INBOX", "UNREAD"],
        };
        if (addLabelIds.length > 0) {
            requestBody.addLabelIds = addLabelIds;
        }
        await gmail.users.messages.modify({
            userId: "me",
            id: gmailMessageId,
            requestBody,
        });
    }

    private async ensureLabel(name: string): Promise<string | null> {
        if (this.labelCache.has(name)) {
            return this.labelCache.get(name)!;
        }

        const gmail = await this.getGmail();
        const listRes = await gmail.users.labels.list({ userId: "me" });
        const existing = (listRes.data.labels || []).find((label: any) => label.name === name);
        if (existing?.id) {
            this.labelCache.set(name, existing.id);
            return existing.id;
        }

        const createRes = await gmail.users.labels.create({
            userId: "me",
            requestBody: {
                name,
                labelListVisibility: "labelShow",
                messageListVisibility: "show",
            },
        });

        const id = createRes.data.id || null;
        if (id) this.labelCache.set(name, id);
        return id;
    }

    private async getThreadState(threadId: string): Promise<ThreadStateRow | null> {
        const supabase = createClient();
        if (!supabase) return null;
        const { data } = await supabase
            .from("email_overwatch_threads")
            .select("*")
            .eq("thread_id", threadId)
            .maybeSingle();
        return (data as ThreadStateRow | null) || null;
    }

    private async upsertThreadState(values: ThreadStateRow): Promise<void> {
        const supabase = createClient();
        if (!supabase) return;
        await supabase
            .from("email_overwatch_threads")
            .upsert({
                ...values,
                updated_at: new Date().toISOString(),
            });
    }

    private async updateThreadState(threadId: string, values: Partial<ThreadStateRow>): Promise<void> {
        const supabase = createClient();
        if (!supabase) return;
        await supabase
            .from("email_overwatch_threads")
            .update({
                ...values,
                updated_at: new Date().toISOString(),
            })
            .eq("thread_id", threadId);
    }

    private extractHeader(message: any, name: string): string {
        return message?.payload?.headers?.find((header: any) => String(header.name).toLowerCase() === name.toLowerCase())?.value || "";
    }

    private extractSubject(message: any): string {
        return this.extractHeader(message, "Subject");
    }

    private extractVendorName(message: any): string {
        const subject = this.extractSubject(message);
        const match = subject.match(/BuildASoil PO #\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+/i);
        return match?.[1]?.trim() || subject || "Unknown Vendor";
    }

    private extractBodyText(message: any): string {
        const payload = message?.payload;
        const parts: string[] = [];
        if (payload?.body?.data) parts.push(this.decodeBase64(payload.body.data));
        const walk = (children: any[]) => {
            for (const child of children || []) {
                if (child.body?.data) parts.push(this.decodeBase64(child.body.data));
                if (child.parts?.length) walk(child.parts);
            }
        };
        if (payload?.parts?.length) walk(payload.parts);
        return parts.join("\n");
    }

    private decodeBase64(data: string): string {
        return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    }

    private parseInternalDate(value: string | number | undefined): Date {
        const numeric = typeof value === "string" ? Number(value) : value || Date.now();
        return new Date(numeric);
    }
}
