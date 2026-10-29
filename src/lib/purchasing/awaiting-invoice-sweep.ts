/**
 * @file    src/lib/purchasing/awaiting-invoice-sweep.ts
 * @purpose Splits the Receivings panel's single "awaiting invoice" state into
 *          the two things it actually means:
 *
 *            awaiting_vendor      the vendor has not billed yet — normal, wait.
 *            in_gmail_unmatched   the bill IS in Gmail but was never ingested
 *                                 (sender domain does not map to the vendor),
 *                                 so it will never appear on its own — act.
 *
 *          Gap 17 canonical case: Rootwise bills from kevindirk29@gmail.com
 *          with subject "Rootwise Invoices" and PDFs named
 *          "BAS PO<num>-<k>-PDF.pdf". A `from:<vendor>` search finds nothing,
 *          but a PO-NUMBER search finds the thread instantly. So this sweep
 *          queries Gmail by PO NUMBER (bare number, "PO-<num>" and "PO<num>" —
 *          the last one is how the attachment filename "BAS PO125393-1-PDF"
 *          matches) in BOTH inboxes, never by vendor.
 *
 *          Writes only purchase_orders.invoice_state (+ the email that proved
 *          it). No email, no Slack, no Telegram, no Bill.com, no Finale.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    @/config/paid-in-advance-vendors, ./invoice-pool, @/lib/db,
 *          @/lib/gmail/auth, @googleapis/gmail
 */

import { isPaidInAdvanceVendor } from "@/config/paid-in-advance-vendors";
import { isCarrierFreightArchive, isPhantomInvoiceRow } from "./invoice-pool";

// ── Invoice state vocabulary ──────────────────────────────────────────────

/**
 * The only two states this sweep writes. `null` means "not swept yet" — the
 * panel keeps its historical wording until the first sweep touches the PO.
 * A PO with a matched invoice needs no state: matchedInvoice already answers.
 */
export const INVOICE_STATE = {
    /** No bill found anywhere. The vendor simply has not billed yet. */
    AWAITING_VENDOR: "awaiting_vendor",
    /** A bill-bearing thread with this PO number sits in Gmail, uningested. */
    IN_GMAIL_UNMATCHED: "in_gmail_unmatched",
} as const;

export type InvoiceState = (typeof INVOICE_STATE)[keyof typeof INVOICE_STATE];

export function isInvoiceState(value: unknown): value is InvoiceState {
    return value === INVOICE_STATE.AWAITING_VENDOR || value === INVOICE_STATE.IN_GMAIL_UNMATCHED;
}

// ── Config ────────────────────────────────────────────────────────────────

/** Both inboxes. `default` = bill.selee@, `ap` = ap@ — same ids the Gmail auth module uses. */
export const GMAIL_ACCOUNTS = ["default", "ap"] as const;
export type GmailAccountId = (typeof GMAIL_ACCOUNTS)[number];

/** Gmail window. Wide enough for a PO received months ago and billed late. */
export const DEFAULT_LOOKBACK_DAYS = 120;
/** purchase_orders.receive_date window — older receipts are not this sweep's problem. */
export const RECEIVED_LOOKBACK_DAYS = 90;
/** Gmail calls per PO = accounts × 1, so this cap bounds a run at ~60 searches. */
export const MAX_POS_PER_SWEEP = 30;
/** Rows read from purchase_orders before the invoice leg is applied. */
export const MAX_CANDIDATE_SCAN = 400;
/** Messages examined per PO per account. */
export const MAX_HITS_PER_QUERY = 5;

/**
 * Subject shapes that mean "this message is a bill". The PO number alone is
 * not enough evidence: shipping confirmations quote it too, and a UPS notice
 * must never be mistaken for a bill.
 */
const BILL_SUBJECT_RE =
    /\b(invoices?|invoic(?:ing|ed)|bills?|bill(?:ing|ed)|statement|remittance|amount\s+due|balance\s+due|receipt)\b/i;

/** Dropship POs never carry a vendor invoice from us. */
const DROPSHIP_PO_RE = /dropship/i;

// ── Types ─────────────────────────────────────────────────────────────────

/** A received PO with no bill recorded against it. */
export interface AwaitingInvoiceCandidate {
    poNumber: string;
    vendorName: string | null;
    receiveDate: string | null;
    /** Persisted state from the previous sweep, or null when never swept. */
    invoiceState: InvoiceState | null;
}

/** One Gmail message the search adapter found. */
export interface GmailHit {
    threadId: string;
    subject: string;
    messageId?: string;
    /** True when the message carries a real attachment (e.g. the invoice PDF). */
    hasAttachment?: boolean;
}

/** Injected so tests never touch live Gmail. */
export type GmailSearch = (query: string, accountId: GmailAccountId) => Promise<GmailHit[]>;

/** The finding the badge/parent reads. Persisted onto purchase_orders. */
export interface AwaitingInvoiceFinding {
    poNumber: string;
    gmailThreadId: string;
    subject: string;
    account: GmailAccountId;
    /** The exact Gmail query that hit — kept for auditability. */
    query: string;
    messageId?: string;
}

export interface SweepDeps {
    listCandidates?: (opts: { nowMs?: number }) => Promise<AwaitingInvoiceCandidate[]>;
    searchGmail?: GmailSearch;
    markInvoiceState?: (
        poNumber: string,
        state: InvoiceState,
        finding: AwaitingInvoiceFinding | null,
    ) => Promise<void>;
    accounts?: readonly GmailAccountId[];
    /** Re-search POs already flagged (default false — the flag is the answer). */
    skipAlreadyFlagged?: boolean;
    nowMs?: number;
}

export interface AwaitingInvoiceSweepReport {
    candidates: number;
    /** POs actually searched (Gmail calls made). */
    searched: number;
    findings: AwaitingInvoiceFinding[];
    markedInGmail: number;
    markedAwaitingVendor: number;
    unchanged: number;
    alreadyFlagged: number;
    skippedPaidInAdvance: string[];
    skippedNotPoNumber: string[];
    /** Candidates beyond MAX_POS_PER_SWEEP, left for the next run. */
    truncated: number;
    errors: string[];
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * The Gmail query for one PO. Deliberately NOT `from:<vendor>`: the bill's
 * sender domain frequently does not match the vendor (Rootwise →
 * kevindirk29@gmail.com), which is the whole reason this sweep exists.
 *
 * Three number variants:
 *   "125393"     bare number (invoice body/line text)
 *   "PO-125393"  the hyphenated form vendors type
 *   PO125393     the glued form — Gmail indexes attachment filenames as text
 *                and Rootwise's PDF is "BAS PO125393-1-PDF.pdf"
 *
 * `-in:sent -from:buildasoil.com` drops our OWN outbound PO email, which
 * always contains the PO number and would otherwise flag every PO as billed.
 * `-from:finaleinventory.com` drops Finale's own notifications.
 */
export function buildPoSearchQuery(poNumber: string, lookbackDays: number = DEFAULT_LOOKBACK_DAYS): string {
    const digits = String(poNumber ?? "").replace(/\D/g, "");
    if (!digits) return "";
    const variants = [`"${digits}"`, `"PO-${digits}"`, `PO${digits}`];
    return [
        `newer_than:${lookbackDays}d`,
        "-in:sent",
        "-from:buildasoil.com",
        "-from:finaleinventory.com",
        `(${variants.join(" OR ")})`,
    ].join(" ");
}

/** Six-digit Finale PO numbers (with or without a PO prefix), never dropships. */
export function isSearchablePoNumber(poNumber: string | null | undefined): boolean {
    const raw = String(poNumber ?? "").trim();
    if (!raw || DROPSHIP_PO_RE.test(raw)) return false;
    return /^(po-?)?\d{6}$/i.test(raw);
}

/**
 * True when a hit is bill-shaped: invoice-ish subject OR a real attachment.
 * A PO number in a shipping notice is not a bill.
 */
export function isBillLikeHit(hit: GmailHit | null | undefined): boolean {
    if (!hit) return false;
    if (hit.hasAttachment === true) return true;
    return BILL_SUBJECT_RE.test(String(hit.subject ?? ""));
}

/**
 * True when a vendor_invoices row is a bill that satisfies the invoice leg.
 * Mirrors the Receivings route: a phantom (OCR "error" identity, empty
 * document) or a carrier freight archive is not a goods bill, and a $0 total
 * is an unreadable amount, not proof the vendor billed.
 */
export function hasRecordedBill(
    rows: Array<{ vendor_name?: string | null; invoice_number?: string | null; source_ref?: string | null; total?: number | string | null; line_items?: unknown }> | null | undefined,
): boolean {
    return (rows ?? []).some(
        (row) =>
            !isPhantomInvoiceRow(row) &&
            !isCarrierFreightArchive(row) &&
            Number(row.total ?? 0) > 0,
    );
}

// ── Main sweep ────────────────────────────────────────────────────────────

/**
 * Sweep every received PO that has no recorded bill: search Gmail by PO
 * number in both inboxes and stamp the PO's invoice_state.
 *
 * Pure-ish: every side effect (candidate scan, Gmail search, DB write) is
 * injectable, so tests run with a fake Gmail and a fake PostgREST.
 *
 * @returns counts + findings for the cron log
 */
export async function sweepAwaitingInvoices(deps: SweepDeps = {}): Promise<AwaitingInvoiceSweepReport> {
    const accounts = deps.accounts ?? GMAIL_ACCOUNTS;
    const search = deps.searchGmail ?? defaultSearchGmail;
    const mark = deps.markInvoiceState ?? defaultMarkInvoiceState;
    const skipFlagged = deps.skipAlreadyFlagged ?? true;

    const report: AwaitingInvoiceSweepReport = {
        candidates: 0,
        searched: 0,
        findings: [],
        markedInGmail: 0,
        markedAwaitingVendor: 0,
        unchanged: 0,
        alreadyFlagged: 0,
        skippedPaidInAdvance: [],
        skippedNotPoNumber: [],
        truncated: 0,
        errors: [],
    };

    let candidates: AwaitingInvoiceCandidate[] = [];
    try {
        candidates = await (deps.listCandidates ?? defaultListCandidates)({ nowMs: deps.nowMs });
    } catch (err: unknown) {
        report.errors.push(`candidate scan failed: ${message(err)}`);
        return report;
    }

    report.candidates = candidates.length;
    // Oldest receipt first: the long-unbilled POs are the ones worth the
    // Gmail budget when the queue is larger than the cap.
    const queue = [...candidates]
        .sort((a, b) => timeOf(a.receiveDate) - timeOf(b.receiveDate))
        .slice(0, MAX_POS_PER_SWEEP);
    report.truncated = Math.max(0, candidates.length - queue.length);

    for (const po of queue) {
        if (!isSearchablePoNumber(po.poNumber)) {
            report.skippedNotPoNumber.push(String(po.poNumber ?? ""));
            continue;
        }

        // Paid-in-advance vendors never send an AP invoice (see
        // src/config/paid-in-advance-vendors.ts). Searching for one burns
        // Gmail quota and produces a permanent false "bill is in Gmail".
        if (isPaidInAdvanceVendor(po.vendorName)) {
            report.skippedPaidInAdvance.push(po.poNumber);
            continue;
        }

        // Already flagged and still un-billed (else it would not be a
        // candidate): the flag is the answer, do not re-query Gmail daily.
        if (skipFlagged && po.invoiceState === INVOICE_STATE.IN_GMAIL_UNMATCHED) {
            report.alreadyFlagged++;
            continue;
        }

        const query = buildPoSearchQuery(po.poNumber);
        let finding: AwaitingInvoiceFinding | null = null;
        let failedAccounts = 0;

        for (const account of accounts) {
            let hits: GmailHit[] = [];
            try {
                hits = await search(query, account);
            } catch (err: unknown) {
                failedAccounts++;
                report.errors.push(`${po.poNumber} search failed on ${account}: ${message(err)}`);
                continue;
            }
            const hit = hits.find(isBillLikeHit);
            if (hit) {
                finding = {
                    poNumber: po.poNumber,
                    gmailThreadId: hit.threadId,
                    subject: hit.subject,
                    account,
                    query,
                    ...(hit.messageId ? { messageId: hit.messageId } : {}),
                };
                break;
            }
        }

        report.searched++;

        if (finding) {
            report.findings.push(finding);
            try {
                await mark(po.poNumber, INVOICE_STATE.IN_GMAIL_UNMATCHED, finding);
                report.markedInGmail++;
            } catch (err: unknown) {
                report.errors.push(`${po.poNumber} state write failed: ${message(err)}`);
            }
            continue;
        }

        // No hit — but "no hit" only means "vendor has not billed" if the
        // search actually ran. A dead inbox must not excuse the PO.
        if (failedAccounts >= accounts.length) {
            report.errors.push(
                `${po.poNumber} left unchanged: every Gmail account failed, so "not billed" is unproven`,
            );
            continue;
        }

        if (po.invoiceState === INVOICE_STATE.AWAITING_VENDOR) {
            report.unchanged++;
            continue;
        }

        try {
            await mark(po.poNumber, INVOICE_STATE.AWAITING_VENDOR, null);
            report.markedAwaitingVendor++;
        } catch (err: unknown) {
            report.errors.push(`${po.poNumber} state write failed: ${message(err)}`);
        }
    }

    return report;
}

// ── Default adapters (live path) ──────────────────────────────────────────

interface PurchaseOrderRow {
    po_number: string;
    vendor_name: string | null;
    status: string | null;
    receive_date: string | null;
    invoice_state: string | null;
}

/**
 * Received POs from the purchase_orders mirror with no recorded bill. Finale
 * is never called: the mirror already carries receive_date, and PostgREST is
 * the only source this sweep needs.
 */
async function defaultListCandidates(opts: { nowMs?: number } = {}): Promise<AwaitingInvoiceCandidate[]> {
    const { createClient } = await import("@/lib/db");
    const db = createClient();
    // HERMIA(2026-10-29): a silent `[]` here is the swallowed-read anti-pattern —
    // the sweep would report "0 candidates, all clear" with no explanation. Throw
    // so the caller's try/catch records WHY the run was empty.
    if (!db) throw new Error("no database client available (createClient returned null)");

    const now = opts.nowMs ?? Date.now();
    const cutoff = new Date(now - RECEIVED_LOOKBACK_DAYS * 86_400_000).toISOString();

    let rows: PurchaseOrderRow[] = [];
    try {
        const { data, error } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, status, receive_date, invoice_state")
            .not("receive_date", "is", null)
            .gte("receive_date", cutoff)
            .order("receive_date", { ascending: true })
            .limit(MAX_CANDIDATE_SCAN);
        if (error) {
            throw new Error(`purchase_orders read failed: ${errorMessage(error)}`);
        }
        rows = (data ?? []) as PurchaseOrderRow[];
    } catch (err: unknown) {
        throw new Error(`purchase_orders read failed: ${message(err)}`);
    }

    const received = rows
        .filter((r) => r?.po_number && isSearchablePoNumber(r.po_number))
        .map<AwaitingInvoiceCandidate>((r) => ({
            poNumber: r.po_number,
            vendorName: r.vendor_name ?? null,
            receiveDate: r.receive_date ?? null,
            invoiceState: isInvoiceState(r.invoice_state) ? r.invoice_state : null,
        }));
    if (received.length === 0) return [];

    const billed = await loadBilledPos(db, received.map((c) => c.poNumber));
    return received.filter((c) => !billed.has(c.poNumber));
}

/** PO numbers that already have a bill row worth counting. */
async function loadBilledPos(db: DbClient, poNumbers: string[]): Promise<Set<string>> {
    const billed = new Set<string>();
    for (let i = 0; i < poNumbers.length; i += 100) {
        const chunk = poNumbers.slice(i, i + 100);
        try {
            const { data, error } = await db
                .from("vendor_invoices")
                .select("po_number, vendor_name, invoice_number, source_ref, total, line_items")
                .in("po_number", chunk);
            if (error) {
                console.warn("[awaiting-invoice-sweep] vendor_invoices read failed:", errorMessage(error));
                continue;
            }
            const byPo = new Map<string, InvoiceLegRow[]>();
            for (const row of (data ?? []) as InvoiceLegRow[]) {
                if (!row?.po_number) continue;
                if (!byPo.has(row.po_number)) byPo.set(row.po_number, []);
                byPo.get(row.po_number)!.push(row);
            }
            for (const [po, invRows] of byPo) {
                if (hasRecordedBill(invRows)) billed.add(po);
            }
        } catch (err: unknown) {
            console.warn("[awaiting-invoice-sweep] vendor_invoices read threw:", message(err));
        }
    }
    return billed;
}

interface InvoiceLegRow {
    po_number: string;
    vendor_name: string | null;
    invoice_number: string | null;
    source_ref: string | null;
    total: number | string | null;
    line_items: unknown;
}

/**
 * Live Gmail search — same client construction as
 * src/lib/tracking/email-tracking-ingest.ts (getAuthenticatedClient + the
 * @googleapis/gmail factory). Imported lazily so a unit test that injects its
 * own search never loads the Google SDK or a token file.
 */
async function defaultSearchGmail(query: string, accountId: GmailAccountId): Promise<GmailHit[]> {
    const [{ getAuthenticatedClient }, { gmail: GmailApi }] = await Promise.all([
        import("@/lib/gmail/auth"),
        import("@googleapis/gmail"),
    ]);
    const auth = await getAuthenticatedClient(accountId);
    const gmail = GmailApi({ version: "v1", auth });

    const list = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: MAX_HITS_PER_QUERY,
    });

    const hits: GmailHit[] = [];
    for (const msg of list.data.messages ?? []) {
        if (!msg.id) continue;
        try {
            const full = await gmail.users.messages.get({
                userId: "me",
                id: msg.id,
                format: "metadata",
                metadataHeaders: ["Subject"],
            });
            const headers = full.data.payload?.headers ?? [];
            const subject =
                headers.find((h) => String(h.name ?? "").toLowerCase() === "subject")?.value ?? "";
            const parts = full.data.payload?.parts ?? [];
            hits.push({
                messageId: msg.id,
                threadId: full.data.threadId ?? msg.threadId ?? msg.id,
                subject,
                hasAttachment: parts.some((p) => !!p.filename),
            });
        } catch (err: unknown) {
            // One unreadable message must not sink the PO's search.
            console.warn(`[awaiting-invoice-sweep] message ${msg.id} read failed:`, message(err));
        }
    }
    return hits;
}

/** Persist the state (plus the evidence, so a human can click through). */
async function defaultMarkInvoiceState(
    poNumber: string,
    state: InvoiceState,
    finding: AwaitingInvoiceFinding | null,
): Promise<void> {
    const { createClient } = await import("@/lib/db");
    const db = createClient();
    if (!db) throw new Error("no PostgREST client available");

    const payload: Record<string, string | null> = { invoice_state: state };
    if (state === INVOICE_STATE.IN_GMAIL_UNMATCHED && finding) {
        payload.invoice_email_thread_id = finding.gmailThreadId;
        payload.invoice_email_subject = finding.subject.slice(0, 300);
        payload.invoice_email_found_at = new Date().toISOString();
    } else {
        // Leaving a stale thread id on a PO that no longer has a hit would
        // point the panel at a message that is not a bill.
        payload.invoice_email_thread_id = null;
        payload.invoice_email_subject = null;
        payload.invoice_email_found_at = null;
    }

    const { error } = await db
        .from("purchase_orders")
        .update(payload)
        .eq("po_number", poNumber);
    if (error) throw new Error(`purchase_orders update failed: ${errorMessage(error)}`);
}

// ── Small utilities ───────────────────────────────────────────────────────

/** The project's PostgREST client — imported for typing only. */
type DbClient = import("@/lib/db").DbClient;

function message(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function errorMessage(err: unknown): string {
    if (err && typeof err === "object" && "message" in err) {
        return String((err as { message?: unknown }).message ?? "");
    }
    return message(err);
}

function timeOf(iso: string | null | undefined): number {
    if (!iso) return Number.MAX_SAFE_INTEGER;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}
