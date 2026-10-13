/**
 * @file    src/lib/purchasing/billcom-unbilled-watchdog.ts
 * @purpose Daily check that every invoice Aria forwarded to Bill.com actually
 *          became a bill there. A forward stays an open item until Bill.com
 *          shows a bill for it; the open items land in `ap_activity_log`, which
 *          the dashboard daily-ops and activity summaries already read.
 *
 *          Why it exists: `reconcile-billcom.ts` sweeps only the last 14 days of
 *          forwards, so a forward that produced no bill stopped being examined
 *          the moment it aged out. Ferticell 2907 (8 forwards on 2026-06-18) and
 *          8013 (3 on 2026-06-30) sat unbilled for 117 and 105 days with nothing
 *          watching, and nothing ever wrote the ledger's `billcom_processed`
 *          flag back (351 rows unset).
 *
 *          Local SQLite + PostgREST only. Never touches Finale or Bill.com.
 *          No Telegram, no Slack, no email: the open items appear where AP is
 *          reviewed.
 *
 * @author  Hermia
 * @created 2026-10-13
 * @deps    @/lib/storage/local-db, @/lib/purchasing/billcom-ap-audit,
 *          @/lib/intelligence/ap-statement-gate, @/lib/db
 */

import { getLocalDb } from "@/lib/storage/local-db";
import {
    findUnbilledForwards,
    type ForwardRow,
    type RefRow,
    type LedgerBacklogReport,
} from "@/lib/purchasing/billcom-ap-audit";
import { isStatementDocument } from "@/lib/intelligence/ap-statement-gate";
import { createClient } from "@/lib/db";

/** Open-item age (days) before a forward is worth reporting. */
export const WATCHDOG_MIN_AGE_DAYS = 14;

/** Cap on the open items carried in the activity row's metadata. */
export const WATCHDOG_MAX_ITEMS = 25;

export interface WatchdogOutcome {
    report: LedgerBacklogReport;
    /** Ledger rows stamped billcom_processed=1 this run. */
    stamped: number;
    /** True when an activity row was written. */
    logged: boolean;
    /** Why nothing was written, when logged is false. */
    skippedReason?: "none-open" | "already-logged-today";
}

/**
 * Run the check: judge every forward against the Bill.com reference, heal the
 * ledger's `billcom_processed` flag for forwards whose bill has arrived, and log
 * one activity row when forwards are still unbilled past the age bar.
 *
 * @param nowMs Clock override for tests.
 * @returns the report plus what was written.
 */
export async function runBillcomUnbilledWatchdog(nowMs?: number): Promise<WatchdogOutcome> {
    const db = getLocalDb();
    const ref = db
        .prepare("SELECT vendor_name, invoice_number, invoice_amount, invoice_date FROM billcom_bills_ref")
        .all() as RefRow[];
    const forwards = db
        .prepare(
            `SELECT id, forwarded_at, status, email_from, email_subject, pdf_filename,
                    ocr_vendor_name, ocr_invoice_number, ocr_total
             FROM ap_local_forwards`,
        )
        .all() as ForwardRow[];

    const report = findUnbilledForwards(forwards, ref, {
        minAgeDays: WATCHDOG_MIN_AGE_DAYS,
        nowMs,
        isNonInvoice: (f) =>
            isStatementDocument(f.email_subject || "", f.pdf_filename || "", f.email_from || ""),
    });

    // Heal: a bill now in the reference means the forward did its job. This is
    // the column nothing wrote back, which is why 351 rows stayed unset.
    const stamp = db.prepare(
        "UPDATE ap_local_forwards SET billcom_processed = 1 WHERE id = ? AND COALESCE(billcom_processed, 0) = 0",
    );
    let stamped = 0;
    for (const c of report.confirmed) stamped += stamp.run(c.id).changes;

    if (report.needsAttention.length === 0) {
        return { report, stamped, logged: false, skippedReason: "none-open" };
    }

    // One row per day, not one per item: the dashboard summaries count rows.
    const sb = createClient();
    const today = new Date(nowMs ?? Date.now()).toISOString().slice(0, 10);
    const { data: existing, error: readErr } = await sb
        .from("ap_activity_log")
        .select("id")
        .eq("intent", "BILLCOM_UNBILLED")
        .gte("created_at", `${today}T00:00:00Z`)
        .limit(1);
    if (readErr) throw new Error(`watchdog activity check failed: ${readErr.message}`);
    const todayRows = (existing ?? []) as unknown as Array<{ id: number }>;
    if (todayRows.length > 0) {
        return { report, stamped, logged: false, skippedReason: "already-logged-today" };
    }

    const oldest = report.needsAttention[0];
    const { error: writeErr } = await sb.from("ap_activity_log").insert({
        email_from: "Bill.com watchdog",
        email_subject:
            `Forwarded, no bill in Bill.com: ${report.needsAttention.length} open (oldest ${oldest.ageDays}d)`,
        intent: "BILLCOM_UNBILLED",
        action_taken:
            `${report.needsAttention.length} forward(s) older than ${WATCHDOG_MIN_AGE_DAYS} days have no Bill.com bill; ` +
            `oldest ${oldest.vendor} #${oldest.invoice} at ${oldest.ageDays} days`,
        reviewed_at: null,
        reviewed_action: null,
        metadata: {
            count: report.needsAttention.length,
            examined: report.examined,
            confirmed: report.confirmed.length,
            excused: report.excused,
            stamped,
            items: report.needsAttention.slice(0, WATCHDOG_MAX_ITEMS).map((u) => ({
                invoice: u.invoice,
                vendor: u.vendor,
                amount: u.amount,
                ageDays: u.ageDays,
                forwardedAt: String(u.forwardedAt).slice(0, 10),
                filename: u.filename,
            })),
        },
    });
    if (writeErr) throw new Error(`watchdog activity write failed: ${writeErr.message}`);

    return { report, stamped, logged: true };
}
