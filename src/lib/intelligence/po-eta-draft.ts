/**
 * @file    po-eta-draft.ts
 * @purpose Compose-and-save a vendor ETA inquiry draft for an at-risk PO.
 *          Triggered by the dashboard "Compose ETA Draft" button on a
 *          PO_ARRIVAL_AT_RISK Activity row. Never auto-sends — output is a
 *          Gmail draft sitting in ap@buildasoil.com Drafts, plus a
 *          PO_ETA_DRAFT_CREATED Activity row for audit.
 *
 *          The draft tone is calibrated to the comm state recorded in the
 *          source Activity row's metadata.
 */

import { getAuthenticatedClient } from "../gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { createClient } from "../supabase";
import { unifiedTextGeneration } from "./llm";

type CommState =
    | "none"
    | "auto_acknowledged"
    | "recent_human_reply"
    | "eta_stated_no_tracking"
    | "tracking_no_movement"
    | "shipped_past_eta";

const COMM_STATE_GUIDANCE: Record<CommState, string> = {
    none:
        "Vendor has not responded at all. Tone: friendly nudge, polite check-in. Mention PO# and date sent.",
    auto_acknowledged:
        "Only an automated/system ack on file — no real human at the vendor has engaged. Tone: friendly nudge, polite check-in. Ask if a person can confirm where things stand.",
    recent_human_reply:
        "A real human at the vendor replied recently (last 7 days). Tone: warm follow-up that thanks them for the prior reply and asks for current shipping status / tracking.",
    eta_stated_no_tracking:
        "Vendor gave us an ETA but no tracking yet. Tone: courteous, reference their stated ETA, ask whether it's still on track and if tracking can be shared.",
    tracking_no_movement:
        "Tracking exists but the carrier has no scan / movement. Tone: a bit firmer — ask whether the shipment actually picked up and where the truck is. Stay professional, not accusatory.",
    shipped_past_eta:
        "The vendor's stated ETA has passed and we still haven't received it. Tone: direct, slightly urgent. Ask for current shipment status, tracking, and an honest revised ETA. Stop short of demanding.",
};

interface AtRiskMetadata {
    poId: string;
    vendorName: string;
    vendorPartyId?: string | null;
    severity?: "at_risk" | "soon_at_risk";
    expectedArrival: string;
    commState: CommState;
    facts?: {
        poSentAt?: string | null;
        vendorAcknowledgedAt?: string | null;
        humanReplyDetectedAt?: string | null;
        vendorStatedEta?: string | null;
        trackingNumbers?: string[];
        lastMovementSummary?: string | null;
    };
    atRiskItems?: Array<{ sku: string; productName?: string; daysShort: number; stockoutDate: string }>;
    worstDaysShort?: number;
}

export interface ComposeDraftResult {
    ok: boolean;
    draftId?: string;
    subject?: string;
    body?: string;
    vendorEmail?: string;
    followUpActivityId?: string;
    error?: string;
}

/** Resolve vendor email from vendor_profiles. Returns "" if not on file. */
async function lookupVendorEmail(vendorName: string): Promise<string> {
    const sb = createClient();
    if (!sb || !vendorName) return "";
    try {
        const { data } = await sb
            .from("vendor_profiles")
            .select("vendor_emails")
            .ilike("vendor_name", vendorName)
            .limit(1);
        const emails = (data?.[0] as { vendor_emails?: string[] } | undefined)?.vendor_emails ?? [];
        return emails.length > 0 ? emails[0] : "";
    } catch {
        return "";
    }
}

async function composeBody(meta: AtRiskMetadata): Promise<{ subject: string; body: string }> {
    const commState = (meta.commState || "none") as CommState;
    const guidance = COMM_STATE_GUIDANCE[commState] ?? COMM_STATE_GUIDANCE.none;
    const facts = meta.facts ?? {};
    const itemSummary = (meta.atRiskItems ?? [])
        .slice(0, 5)
        .map((i) => {
            const tail = i.daysShort >= 0 ? `~${i.daysShort} day(s) short` : `~${Math.abs(i.daysShort)} day(s) of buffer`;
            return `- ${i.sku}${i.productName ? ` (${i.productName})` : ""}: stock runs out ${i.stockoutDate}, ${tail} vs your expected arrival`;
        })
        .join("\n");

    const factBlock = [
        `PO #${meta.poId} sent ${facts.poSentAt ?? "(date unknown)"}`,
        facts.vendorAcknowledgedAt ? `Vendor acknowledged ${facts.vendorAcknowledgedAt}` : "No vendor acknowledgement on file",
        facts.humanReplyDetectedAt ? `Last human reply from vendor: ${facts.humanReplyDetectedAt}` : null,
        facts.vendorStatedEta ? `Vendor's stated ETA: ${facts.vendorStatedEta}` : "No vendor-stated ETA on file",
        (facts.trackingNumbers ?? []).length > 0 ? `Tracking on file: ${(facts.trackingNumbers ?? []).join(", ")}` : "No tracking on file",
        facts.lastMovementSummary ? `Latest movement: ${facts.lastMovementSummary}` : null,
    ].filter(Boolean).join("\n");

    const prompt = `You are Aria, Will's AP assistant at BuildASoil. Draft a SHORT, professional email to a vendor about an outstanding purchase order whose arrival is at risk.

CRITICAL CONSTRAINTS:
- Keep it under 100 words.
- No "Dear Sir/Madam". Greet by company name or "Hi team" if you don't know the contact.
- Plain text, no markdown, no signature block (Gmail signature is added separately).
- Match this tone exactly: ${guidance}
- Mention the PO number and that stock is running low — vendors respond better to "this is going to bite us" than vague nudges.
- DO NOT name specific build schedules or internal builds.
- DO NOT promise dates. Ask, don't tell.

Facts about this PO:
${factBlock}

At-risk items (we will run out before the PO is expected to arrive):
${itemSummary || "(no items)"}

Vendor: ${meta.vendorName}
Expected arrival per our records: ${meta.expectedArrival}

Return EXACTLY two lines, prefixed:
SUBJECT: <subject line, ≤80 chars, mention PO# and "ETA check">
BODY:
<email body>`;

    const out = await unifiedTextGeneration({ prompt, temperature: 0.5, maxTokens: 350 });
    const subjectMatch = out.match(/^SUBJECT:\s*(.+)$/im);
    const bodyMatch = out.match(/^BODY:\s*\n?([\s\S]+)$/im);
    const subject = (subjectMatch?.[1] ?? `PO #${meta.poId} — ETA check`).trim();
    const body = (bodyMatch?.[1] ?? out).trim();
    return { subject, body };
}

function buildRfc2822(to: string, subject: string, body: string): string {
    const lines = [
        to ? `To: ${to}` : "",
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        body,
        ``,
    ].filter(l => l !== "");
    return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

/**
 * Compose a draft for the at-risk PO in the source Activity row, save it
 * to Gmail Drafts, and post a PO_ETA_DRAFT_CREATED follow-up Activity
 * row. Returns the draft id + body so the UI can preview.
 */
export async function composeAndSaveDraftFromActivity(
    sourceActivityId: string,
    metadata: AtRiskMetadata,
): Promise<ComposeDraftResult> {
    const vendorEmail = await lookupVendorEmail(metadata.vendorName);

    let composed: { subject: string; body: string };
    try {
        composed = await composeBody(metadata);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `LLM compose failed: ${msg}`, vendorEmail };
    }

    let draftId: string | undefined;
    try {
        const auth = await getAuthenticatedClient("ap");
        const gmail = GmailApi({ version: "v1", auth: auth as any });
        const raw = buildRfc2822(vendorEmail, composed.subject, composed.body);
        const draftRes = await gmail.users.drafts.create({
            userId: "me",
            requestBody: { message: { raw } },
        });
        draftId = draftRes.data.id ?? undefined;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Gmail draft create failed: ${msg}`, vendorEmail, subject: composed.subject, body: composed.body };
    }

    // Audit row so Activity feed shows the draft was created — clickable
    // back to the source PO_ARRIVAL_AT_RISK row.
    let followUpActivityId: string | undefined;
    const sb = createClient();
    if (sb) {
        try {
            const { data, error } = await sb.from("ap_activity_log").insert({
                email_from: metadata.vendorName,
                email_subject: composed.subject,
                intent: "PO_ETA_DRAFT_CREATED",
                action_taken: `ETA draft saved to Gmail Drafts for PO #${metadata.poId}${vendorEmail ? ` (to ${vendorEmail})` : " — vendor email TBD"}`,
                metadata: {
                    poId: metadata.poId,
                    vendorName: metadata.vendorName,
                    draftId,
                    vendorEmail: vendorEmail || null,
                    sourceActivityId,
                    subject: composed.subject,
                    body: composed.body,
                },
            }).select("id").single();
            if (!error && data) followUpActivityId = (data as { id: string }).id;
        } catch {
            // best-effort — draft is the source of truth
        }
    }

    return {
        ok: true,
        draftId,
        subject: composed.subject,
        body: composed.body,
        vendorEmail,
        followUpActivityId,
    };
}
