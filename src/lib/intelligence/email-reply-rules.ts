/**
 * @file    src/lib/intelligence/email-reply-rules.ts
 * @purpose Store + apply learned vendor reply corrections. When Bill edits a
 *          draft before sending, or deletes it unsent, the delta is ground
 *          truth for how he writes. This module keys that learning by
 *          (vendor, context) so future drafts reuse his phrasing.
 *
 *          Rule types:
 *            template  — Bill's sent body, with {name} substituted for the
 *                        recipient first name.
 *            no_reply  — Bill deleted the draft unsent → do not draft again
 *                        for this vendor+context.
 *
 * @author  Hermia
 * @created 2026-08-11
 * @deps    ../db
 */

import { createClient } from "../db";

export type ReplyRuleType = "template" | "no_reply";

export interface ReplyRule {
    vendorKey: string;
    context: string;
    ruleType: ReplyRuleType;
    template: string | null;
}

/** Draft contexts we key learning by. Order matters for inference below. */
export const REPLY_CONTEXTS = [
    "po_ack",
    "tracking",
    "invoice",
    "routine",
    "simple_confirm",
    "human_question",
    "opportunity",
    "generic",
] as const;

export type ReplyContext = (typeof REPLY_CONTEXTS)[number];

/**
 * Normalize a From address into a stable vendor key.
 * "Donna Padilla <donna@crminerals.com>" → "crminerals.com"
 * "donna@crminerals.com" → "crminerals.com"
 */
export function normalizeVendorKey(from: string): string {
    const m = from.match(/<([^>]+)>/);
    const addr = (m ? m[1] : from).trim().toLowerCase();
    const at = addr.lastIndexOf("@");
    if (at >= 0) return addr.slice(at + 1);
    return addr;
}

/**
 * Infer a draft context from the recorded kind + subject/body signals.
 * Used both when learning a rule and when looking one up, so the same
 * email produces the same key in both phases.
 */
export function inferReplyContext(kind: string | null | undefined, subject: string, bodyText: string): ReplyContext {
    const hay = `${subject}\n${bodyText || ""}`.toLowerCase();
    const k = (kind || "").toLowerCase();

    if (k.includes("opportunity")) return "opportunity";
    if (k.includes("human") || k.includes("escalat")) return "human_question";

    // Question signals first — a question beats any keyword classification.
    if (/\?/.test(bodyText || "") || /\b(can you|could you|please (?:confirm|advise|send)|what is|when will|do you need)\b/i.test(hay)) return "human_question";

    // PO number in subject + ack/confirm → PO acknowledgment (beats generic
    // "received with thanks" which would otherwise read as simple_confirm).
    if (/\bpo\s*#?\s*\d{5,6}\b/i.test(subject) && /(received|thanks|acknowledg|confirm)/i.test(hay)) return "po_ack";
    if (/\bpurchase order\b|\bpo\s*#?\s*\d/i.test(subject)) return "po_ack";

    if (/(sounds good|will send|i'?ll send|as soon as we|noted|got it|received with thanks)/i.test(hay)) return "simple_confirm";
    if (/\binvoice\b|\bcost\b|\bbreakdown\b|\$[\d,]+\.\d{2}/i.test(hay)) return "invoice";
    if (/\btrack|\bship|\bdeliver|\bbol\b|\bfreight\b/i.test(hay)) return "tracking";
    return "generic";
}

/**
 * Substitute the recipient's first name back into a {name}-templated reply.
 * Falls back to the template verbatim if no name is available.
 */
export function applyReplyTemplate(template: string, firstName: string): string {
    if (!template) return "";
    if (!firstName) return template;
    return template.replace(/\{name\}/gi, firstName);
}

/**
 * Learn a rule from a draft→sent pair (template) or a deleted draft (no_reply).
 * Upserts on (vendor_key, context) — newest learning wins, times_learned bumps.
 */
export async function learnReplyRule(args: {
    vendorKey: string;
    context: ReplyContext;
    ruleType: ReplyRuleType;
    template?: string | null;
    sourceDraftBody?: string | null;
    sourceSentBody?: string | null;
    sourceEventId?: string | null;
}): Promise<void> {
    try {
        const db = createClient();
        if (!db) return;

        // Existing rule for this vendor+context → bump times_learned and overwrite.
        const { data: existing } = (await db
            .from("email_reply_rules")
            .select("id, times_learned")
            .eq("vendor_key", args.vendorKey)
            .eq("context", args.context)
            .maybeSingle()) as { data: { times_learned: number } | null };

        const timesLearned = (existing?.times_learned ?? 0) + 1;

        const payload = {
            vendor_key: args.vendorKey,
            context: args.context,
            rule_type: args.ruleType,
            template: args.template ?? null,
            source_draft_body: args.sourceDraftBody ?? null,
            source_sent_body: args.sourceSentBody ?? null,
            source_event_id: args.sourceEventId ?? null,
            times_learned: timesLearned,
            updated_at: new Date().toISOString(),
        };

        const { error } = await db.from("email_reply_rules").upsert(payload, {
            onConflict: "vendor_key,context",
        });
        if (error) {
            console.error(`[reply-rules] upsert failed: ${error.message}`);
        }
    } catch (err: any) {
        // Never block the calling agent on a rules-store failure (e.g. table
        // not yet migrated, or a mock DB that doesn't know this table).
        console.warn(`[reply-rules] learn failed (non-fatal): ${err?.message ?? err}`);
    }
}

/**
 * Look up a learned rule for a vendor+context. Returns null when none exists,
 * the DB is unavailable, or the table isn't migrated — callers then fall back
 * to normal drafting.
 */
export async function findReplyRule(
    vendorKey: string,
    context: ReplyContext,
): Promise<ReplyRule | null> {
    try {
        const db = createClient();
        if (!db) return null;

        const { data, error } = (await db
            .from("email_reply_rules")
            .select("vendor_key, context, rule_type, template")
            .eq("vendor_key", vendorKey)
            .eq("context", context)
            .maybeSingle()) as {
            data: { vendor_key: string; context: string; rule_type: ReplyRuleType; template: string | null } | null;
            error: { message: string } | null;
        };

        if (error || !data) return null;
        return {
            vendorKey: data.vendor_key,
            context: data.context,
            ruleType: data.rule_type,
            template: data.template ?? null,
        };
    } catch (err: any) {
        console.warn(`[reply-rules] lookup failed (non-fatal): ${err?.message ?? err}`);
        return null;
    }
}
