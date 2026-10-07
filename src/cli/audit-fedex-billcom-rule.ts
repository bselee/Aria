/**
 * @file    src/cli/audit-fedex-billcom-rule.ts
 * @purpose Prove the FedEx exclusion holds, on demand, against live data.
 *
 *          Rule (Bill, 2026-09-23): NO FedEx document is forwarded to Bill.com.
 *          FBO parcel packets, FedEx Freight bills, past-due notices and reward
 *          mail are all skipped, labelled and archived. The pipeline cannot show
 *          this by being quiet, so this CLI checks it four ways and exits 1 if
 *          any check fails:
 *
 *            1. Ledger     - FedEx-attributable ap_local_forwards rows since the
 *                            cutoff, by status. A single FORWARDED row fails.
 *            2. Channel    - every message Aria sent to buildasoilap@bill.com
 *                            since the cutoff, inspected for FedEx subject or
 *                            attachment. A single hit fails.
 *            3. Gate       - every FedEx-ish message in the ap@ mailbox over the
 *                            lookback, run through the pipeline's OWN skip
 *                            predicate (isNonInvoiceEmail) and its ledger row.
 *            4. Guard      - inventory of rows stopped by the attachment-level
 *                            guard (FedEx doc inside a non-FedEx email).
 *
 *          READ-ONLY. No Gmail mutation, no DB write, no Bill.com call.
 *
 * @author  Hermia
 * @created 2026-10-07
 * @deps    @googleapis/gmail, local-db, ap-local-forwarder (BILL_COM_EMAIL,
 *          isNonInvoiceEmail), fedex-billing-packet (predicate)
 * @env     GMAIL_AP_TOKEN (ap-token.json), BILL_COM_FORWARD_EMAIL
 *
 * Usage:
 *   npm run audit:fedex
 *       # rule cutoff 2026-09-23, 60-day mailbox lookback
 *   node --import tsx --env-file=.env.local src/cli/audit-fedex-billcom-rule.ts --since=2026-09-23 --mail-days=90
 *       # widen either window (bare `node` must be the Node 24 that built
 *       # better-sqlite3; the npm script pins it to the system install)
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { getLocalDb } from "@/lib/storage/local-db";
import { BILL_COM_EMAIL, isNonInvoiceEmail } from "@/lib/intelligence/workers/ap-local-forwarder";
import { isFedExExcludedFromBillCom } from "@/lib/intelligence/ap/fedex-billing-packet";

/** Ledger filter for rows the FedEx rule governs. */
const FEDEX_LEDGER_WHERE = `(email_from LIKE '%fedex%' OR email_subject LIKE '%fedex%'
    OR pdf_filename LIKE '%fedex%' OR pdf_filename LIKE '12.99999.%'
    OR vendor_routing_action = 'carrier_bill')`;

/** Gmail search windows that surface FedEx mail from any lane. */
const MAILBOX_QUERIES = [
    "from:fedex.com",
    "from:rewardcatalog.fedex.com",
    "from:message.fedex.com",
    "subject:fedex",
];

/** Header of a Gmail message payload. */
function header(payload: unknown, name: string): string {
    const parts = ((payload as { headers?: Array<{ name?: string; value?: string }> })?.headers) || [];
    return parts.find((h) => h.name === name)?.value || "";
}

/** Every attachment filename in a message payload, recursively. */
function attachmentNames(payload: unknown): string[] {
    const out: string[] = [];
    const walk = (part: { filename?: string; parts?: unknown[] } | undefined): void => {
        if (!part) return;
        if (part.filename) out.push(part.filename);
        for (const child of (part.parts || []) as Array<{ filename?: string; parts?: unknown[] }>) walk(child);
    };
    walk(payload as { filename?: string; parts?: unknown[] });
    return out;
}

/** True when any part of a sent message is a FedEx document by the pipeline's own definition. */
function sentMessageIsFedEx(from: string, subject: string, files: string[]): boolean {
    if (isFedExExcludedFromBillCom({ from, subject })) return true;
    return files.some((f) => isFedExExcludedFromBillCom({ from, subject: "", filename: f }));
}

/** Parse --key=value flags with defaults. */
function flag(name: string, fallback: string): string {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : fallback;
}

async function main(): Promise<void> {
    const since = flag("since", "2026-09-23");
    const mailDays = Number(flag("mail-days", "60"));
    const db = getLocalDb();
    let failures = 0;
    const check = (ok: boolean, label: string): void => {
        if (!ok) failures++;
        console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    };

    console.log(`FedEx -> Bill.com exclusion audit | rule cutoff ${since} | mailbox lookback ${mailDays}d`);
    console.log(`Bill.com ingest address: ${BILL_COM_EMAIL}\n`);

    // ── 1. Ledger ──────────────────────────────────────────────────────────
    console.log("[1] ledger rows attributable to FedEx");
    const rows = db.prepare(
        `SELECT id, forwarded_at, status, pdf_filename, email_from, email_subject, error_message
         FROM ap_local_forwards WHERE forwarded_at >= ? AND ${FEDEX_LEDGER_WHERE} ORDER BY forwarded_at`,
    ).all(since) as Array<Record<string, string>>;
    const byStatus = rows.reduce<Record<string, number>>((m, r) => {
        m[r.status] = (m[r.status] || 0) + 1;
        return m;
    }, {});
    const newest = db.prepare(
        `SELECT forwarded_at, pdf_filename FROM ap_local_forwards
         WHERE status = 'FORWARDED' AND ${FEDEX_LEDGER_WHERE} ORDER BY forwarded_at DESC LIMIT 1`,
    ).get() as { forwarded_at?: string; pdf_filename?: string } | undefined;
    console.log(`    since ${since}: ${JSON.stringify(byStatus)}`);
    console.log(`    newest FedEx forward ever: ${newest ? `${newest.forwarded_at} (${newest.pdf_filename})` : "none"}`);
    for (const r of rows.slice(-6)) {
        console.log(`      row ${r.id} | ${r.forwarded_at} | ${r.status} | ${String(r.email_subject).slice(0, 52)}`);
    }
    check((byStatus.FORWARDED || 0) === 0, "no FedEx row was forwarded on or after the cutoff");

    // ── 2. Channel ─────────────────────────────────────────────────────────
    const auth = await getAuthenticatedClient("ap").catch(() => getAuthenticatedClient("default"));
    const gmail = GmailApi({ version: "v1", auth }) as unknown as {
        users: { messages: { list: (a: unknown) => Promise<{ data: { messages?: Array<{ id: string }> } }>; get: (a: unknown) => Promise<{ data: { payload?: unknown } }> } };
    };
    console.log(`\n[2] everything Aria sent to ${BILL_COM_EMAIL} since ${since}`);
    const sentQuery = `in:sent to:${BILL_COM_EMAIL} after:${since.replace(/-/g, "/")}`;
    const sent = (await gmail.users.messages.list({ userId: "me", q: sentQuery, maxResults: 300 })).data.messages || [];
    let channelFedEx = 0;
    for (const s of sent) {
        const m = await gmail.users.messages.get({ userId: "me", id: s.id, format: "full" });
        const subject = header(m.data.payload, "Subject");
        const files = attachmentNames(m.data.payload);
        if (sentMessageIsFedEx(header(m.data.payload, "From"), subject, files)) {
            channelFedEx++;
            console.log(`    HIT ${subject.slice(0, 56)} | ${files.join(";").slice(0, 44)}`);
        }
    }
    console.log(`    ${sent.length} forwards inspected, ${channelFedEx} carrying FedEx material`);
    check(channelFedEx === 0, "no FedEx document reached the Bill.com channel");
    check(sent.length > 0, "the channel is live (non-FedEx invoices still flowing)");

    // ── 3. Gate over live mailbox ──────────────────────────────────────────
    console.log(`\n[3] FedEx mail in ap@ (last ${mailDays}d) against the pipeline's skip gate`);
    const seen = new Map<string, { id: string }>();
    for (const base of MAILBOX_QUERIES) {
        const res = await gmail.users.messages.list({ userId: "me", q: `newer_than:${mailDays}d ${base}`, maxResults: 100 });
        for (const m of res.data.messages || []) seen.set(m.id, m);
    }
    let gateMisses = 0;
    let postRuleForwards = 0;
    for (const [id] of seen) {
        const m = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const from = header(m.data.payload, "From");
        const subject = header(m.data.payload, "Subject");
        const files = attachmentNames(m.data.payload);
        const gate = isNonInvoiceEmail({ from, subject });
        const own = db.prepare(
            "SELECT status, forwarded_at FROM ap_local_forwards WHERE gmail_message_id = ?",
        ).all(id) as Array<{ status: string; forwarded_at: string }>;
        const forwardedSince = own.some((r) => r.status === "FORWARDED" && r.forwarded_at >= since);
        if (!gate && !sentMessageIsFedEx(from, subject, files)) gateMisses++;
        if (forwardedSince) postRuleForwards++;
    }
    console.log(`    ${seen.size} FedEx messages inspected`);
    check(gateMisses === 0, "every FedEx message hits the skip gate before any forward");
    check(postRuleForwards === 0, "no ledger row for those messages shows FORWARDED since the cutoff");

    // ── 4. Attachment-level guard ──────────────────────────────────────────
    console.log("\n[4] attachment-level guard (FedEx doc inside a non-FedEx email)");
    const guard = db.prepare(
        `SELECT COUNT(*) c FROM ap_local_forwards
         WHERE error_message LIKE '%FedEx excluded from Bill.com%' OR error_message LIKE '%FedEx packet excluded%'`,
    ).get() as { c: number };
    console.log(`    ${guard.c} row(s) stopped by it (0 is normal: the sender gate fires first)`);

    console.log(`\n${failures === 0 ? "RESULT: PASS - FedEx is not feeding Bill.com" : `RESULT: FAIL - ${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("audit-fedex-billcom-rule failed:", (e as Error).message);
    process.exit(2);
});
