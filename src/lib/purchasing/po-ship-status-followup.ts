/**
 * @file    src/lib/purchasing/po-ship-status-followup.ts
 * @purpose Close the "vendor acknowledged but never shipped" gap. POs with a
 *          verified vendor acknowledgment but zero tracking sit invisible to
 *          po-followup-watcher (unacked only), vendor-escalation (unacked
 *          only), and po-overdue-followup (requires past expected receive
 *          date). Bill manually asked Novelty for ship status on PO 125172
 *          (2026-08-20, 10 days after ack). This module does that ask as a
 *          Gmail DRAFT (never auto-sends) once a PO has been acked 7-30 days
 *          with no tracking, no post-ack tracking request, and no invoice.
 *          Note: po-followup-watcher's L1 48h receipt check ALSO stamps
 *          tracking_requested_at, and that draft can predate the ack — a
 *          pre-ack stamp is NOT a tracking request and must not block.
 *
 * @author  Hermia
 * @created 2026-08-20
 * @deps    @/lib/db, @/lib/gmail/auth, @googleapis/gmail,
 *          @/lib/intelligence/vendor-comms-agent, ./po-followup-watcher
 *          (findPOThread), ./po-sender (lookupVendorOrderEmail),
 *          ./po-lifecycle (transitionLifecycleState),
 *          @/lib/intelligence/notify-via-task
 * @env     Gmail OAuth (getAuthenticatedClient 'default'), PGRST_* (createClient)
 */

import { createClient } from "@/lib/db";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import {
    VendorCommsAgent,
    type VendorCommContext,
} from "@/lib/intelligence/vendor-comms-agent";
import { notifyViaTask } from "@/lib/intelligence/notify-via-task";
import { findPOThread } from "./po-followup-watcher";
import { lookupVendorOrderEmail } from "./po-sender";
import { transitionLifecycleState } from "./po-lifecycle";

// ── Config ────────────────────────────────────────────────────────────────

/** Ask only after the vendor has had this long since acknowledging. */
export const MIN_DAYS_SINCE_ACK = 7;

/** Age out: beyond this, overdue/receiving logic or a human owns the PO. */
export const MAX_DAYS_SINCE_ACK = 30;

/** Max drafts per run to avoid runaway email creation. */
export const MAX_PER_RUN = 5;

const DROPSHIP_PATTERN = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;

// ── Types ─────────────────────────────────────────────────────────────────

export interface ShipStatusCandidate {
    po_number: string;
    vendor_name: string | null;
    vendor_party_id: string | null;
    vendor_acknowledged_at: string | null;
    tracking_numbers: string[] | null;
    tracking_requested_at: string | null;
    vendor_noncomm_at: string | null;
    lifecycle_stage: string | null;
    receive_date: string | null;
    status: string | null;
    total_amount: number | null;
    total: number | null;
    line_items: any[] | null;
    issue_date: string | null;
    required_date: string | null;
}

export interface ShipStatusOutcome {
    poNumber: string;
    action:
        | 'drafted'              // Gmail draft created for Bill to review
        | 'skipped_invoiced'      // invoice exists = goods on the way
        | 'skipped_dropship'
        | 'skipped_no_thread'
        | 'skipped_no_email'
        | 'skipped_state_changed' // PO lost eligibility mid-scan (e.g. RECEIVED)
        | 'error';
    reason?: string;
}

export interface CandidateVerdict {
    ok: boolean;
    reason?:
        | 'no_ack'
        | 'too_early'
        | 'aged_out'
        | 'has_tracking'
        | 'already_requested'
        | 'noncomm'
        | 'received'
        | 'receipt_scheduled_soon';
}

// ── Pure candidate filter (unit-tested, DB-free) ─────────────────────────

/**
 * Decide whether a PO qualifies for a ship-status request.
 * Pure function of the row + clock — safe to unit test without DB/Gmail.
 *
 * Qualifies when ALL hold:
 *   1. vendor_acknowledged_at set (vendor replied)
 *   2. acked 7-30 days ago (vendor had a week; not stale enough to age out)
 *   3. no tracking numbers
 *   4. no tracking request made AFTER the vendor ack — a pre-ack
 *      tracking_requested_at stamp is the L1 48h receipt check from
 *      po-followup-watcher, not a tracking request, so it doesn't block
 *   5. vendor not marked noncomm
 *   6. PO not received (status received OR past receive_date)
 *
 * @param po        purchase_orders row subset
 * @param nowMs     clock (injectable for tests), defaults to Date.now()
 * @returns verdict with machine-readable reason when excluded
 */
export function isShipStatusCandidate(
    po: Pick<
        ShipStatusCandidate,
        | "vendor_acknowledged_at"
        | "tracking_numbers"
        | "tracking_requested_at"
        | "vendor_noncomm_at"
        | "receive_date"
        | "status"
    >,
    nowMs: number = Date.now(),
): CandidateVerdict {
    // A tracking_requested_at stamp blocks the ship-status ask ONLY when it
    // postdates the vendor's ack. A pre-ack stamp is the L1 48h receipt check
    // from po-followup-watcher ("just making sure you received PO #X") — not
    // a tracking request — so the ship-status ask should still fire. With no
    // ack to compare against (or unparseable dates), stay conservative and
    // treat the stamp as a real tracking request. Evaluated first because
    // this verdict must win even when vendor_acknowledged_at is null.
    if (po.tracking_requested_at) {
        const reqMs = new Date(po.tracking_requested_at).getTime();
        const ackMs = po.vendor_acknowledged_at
            ? new Date(po.vendor_acknowledged_at).getTime()
            : NaN;
        const isReceiptCheckStamp =
            !isNaN(reqMs) && !isNaN(ackMs) && reqMs <= ackMs;
        if (!isReceiptCheckStamp) return { ok: false, reason: "already_requested" };
    }

    if (!po.vendor_acknowledged_at) return { ok: false, reason: "no_ack" };

    const ackedMs = new Date(po.vendor_acknowledged_at).getTime();
    if (isNaN(ackedMs)) return { ok: false, reason: "no_ack" };
    const daysAcked = Math.floor((nowMs - ackedMs) / 86_400_000);
    if (daysAcked < MIN_DAYS_SINCE_ACK) return { ok: false, reason: "too_early" };
    if (daysAcked > MAX_DAYS_SINCE_ACK) return { ok: false, reason: "aged_out" };

    if (po.tracking_numbers && po.tracking_numbers.length > 0) {
        return { ok: false, reason: "has_tracking" };
    }
    if (po.vendor_noncomm_at) return { ok: false, reason: "noncomm" };

    const receivedByStatus = (po.status ?? "").toLowerCase() === "received";
    const receivedByDate =
        !!po.receive_date && new Date(po.receive_date).getTime() < nowMs;
    if (receivedByStatus || receivedByDate) return { ok: false, reason: "received" };

    // Receipt scheduled within the next 3 days = goods are landing. Asking
    // "has it shipped?" is noise — the vendor already shipped.
    if (po.receive_date) {
        const rMs = new Date(po.receive_date).getTime();
        if (!isNaN(rMs) && rMs >= nowMs && rMs - nowMs <= 3 * 86_400_000) {
            return { ok: false, reason: "receipt_scheduled_soon" };
        }
    }

    return { ok: true };
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Run the ship-status follow-up stage.
 *
 * Flow per qualifying PO:
 *   1. Skip dropships, invoiced POs, and candidate-filter misses.
 *   2. Find the original PO thread (shared findPOThread).
 *   3. Resolve vendor email (thread To: → vendor_profiles lookup).
 *   4. Fresh re-check immediately before drafting: re-select the
 *      freshness-relevant columns (status, receive_date, tracking_numbers,
 *      tracking_requested_at, vendor_noncomm_at) and re-run the candidate
 *      filter against a FRESH clock. A PO that flipped to RECEIVED during
 *      the slow lookups above is skipped — no draft, no stamp.
 *   5. Draft a short ship-status request in-thread (draft only).
 *   6. Set tracking_requested_at; self-heal lifecycle REVIEW/SENT → ACKNOWLEDGED
 *      (vendor reply is proof) so the PO never sits at a stale stage.
 *
 * @param opts.dryRun  plan only — no Gmail drafts, no DB writes
 * @returns one outcome per candidate evaluated
 */
export async function runShipStatusFollowup(opts?: {
    dryRun?: boolean;
}): Promise<ShipStatusOutcome[]> {
    const dryRun = opts?.dryRun ?? false;
    const db = createClient();
    if (!db) return [];

    const now = Date.now();
    const outcomes: ShipStatusOutcome[] = [];

    const minAck = new Date(now - MIN_DAYS_SINCE_ACK * 86_400_000).toISOString();
    const maxAck = new Date(now - MAX_DAYS_SINCE_ACK * 86_400_000).toISOString();

    const { data: pos, error } = await db
        .from("purchase_orders")
        .select(
            "po_number, vendor_name, vendor_party_id, vendor_acknowledged_at, " +
            "tracking_numbers, tracking_requested_at, vendor_noncomm_at, " +
            "lifecycle_stage, receive_date, status, total_amount, total, " +
            "line_items, issue_date, required_date",
        )
        .gte("vendor_acknowledged_at", maxAck)
        .lte("vendor_acknowledged_at", minAck)
        // NOTE: no .is("tracking_requested_at", null) here — a pre-ack stamp
        // (L1 receipt check from po-followup-watcher) must NOT exclude the
        // PO. The timestamp comparison lives in isShipStatusCandidate.
        .is("vendor_noncomm_at", null)
        // Null-safe status exclusion: isShipStatusCandidate treats a NULL
        // status as NOT received, but PostgREST's
        // .not("status", "eq", "received") would also drop NULL-status rows
        // (NULL <> 'received' is unknown in SQL). So exclude only explicit
        // 'received' rows with an OR that keeps NULL status in the window.
        // The dropship regex stays in code (DROPSHIP_PATTERN) — not here.
        .or("status.is.null,status.neq.received")
        // Newest acks first: the acked 7-30d pool can exceed the 25-row
        // limit, and default (insertion) order returns stale/never-eligible
        // rows first — silently starving eligible POs out of the window.
        .order("vendor_acknowledged_at", { ascending: false })
        .limit(25);

    if (error) {
        console.error("[po-ship-status] query failed:", error.message);
        return [];
    }
    if (!pos || pos.length === 0) return outcomes;

    const gmail = GmailApi({ version: "v1", auth: await getAuthenticatedClient("default") });
    const agent = new VendorCommsAgent(gmail);

    let draftedCount = 0;

    for (const row of pos as ShipStatusCandidate[]) {
        if (draftedCount >= MAX_PER_RUN) break;

        const verdict = isShipStatusCandidate(row, now);
        if (!verdict.ok) continue; // window/db filter should already exclude these

        if (DROPSHIP_PATTERN.test(row.vendor_name ?? "")) {
            outcomes.push({ poNumber: row.po_number, action: "skipped_dropship" });
            continue;
        }

        // Invoice exists = vendor has billed = goods on the way. Don't ask.
        try {
            const { data: inv } = await db
                .from("vendor_invoices")
                .select("id")
                .eq("po_number", row.po_number)
                .limit(1);
            if (inv && inv.length > 0) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_invoiced",
                    reason: "vendor invoice already on file",
                });
                continue;
            }
        } catch (invErr: any) {
            console.warn(
                `[po-ship-status] ${row.po_number} invoice check failed:`,
                invErr?.message ?? invErr,
            );
        }

        const thread = await findPOThread(gmail, row.po_number);
        if (!thread) {
            outcomes.push({
                poNumber: row.po_number,
                action: "skipped_no_thread",
                reason: "no outbound PO thread",
            });
            continue;
        }

        let vendorEmail = thread.vendorEmail;
        if (!vendorEmail || /buildasoil\.com/i.test(vendorEmail)) {
            const lookup = await lookupVendorOrderEmail(
                row.vendor_name ?? "",
                row.vendor_party_id ?? "",
            );
            vendorEmail = lookup.email;
        }
        if (!vendorEmail || /buildasoil\.com/i.test(vendorEmail)) {
            outcomes.push({
                poNumber: row.po_number,
                action: "skipped_no_email",
                reason: "no vendor email on file",
            });
            continue;
        }

        // ── Fresh re-check (read-then-act race guard) ─────────────────────
        // The initial snapshot was taken before the slow lookups above
        // (invoice check, Gmail thread search, vendor email lookup). If the
        // PO lost eligibility in that window — status flipped to RECEIVED,
        // receive_date passed, tracking landed, a concurrent run stamped
        // tracking_requested_at — a "has it shipped?" draft is noise. Skip
        // it: no draft, no tracking_requested_at stamp, no lifecycle
        // transition, no draftedCount. Re-select ONLY the freshness-relevant
        // columns and re-run the candidate filter with a FRESH clock so the
        // 3-day receipt window is judged against now, not the run's `now`.
        try {
            const { data: freshRow, error: freshErr } = await db
                .from("purchase_orders")
                .select(
                    "status, receive_date, tracking_numbers, " +
                    "tracking_requested_at, vendor_noncomm_at",
                )
                .eq("po_number", row.po_number)
                .maybeSingle();

            if (freshErr) {
                // Fail closed: drafting off a stale snapshot is the bug being
                // fixed. Record the skip so it is visible in the run log.
                console.warn(
                    `[po-ship-status] ${row.po_number} fresh recheck failed:`,
                    freshErr?.message ?? freshErr,
                );
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_state_changed",
                    reason: `fresh recheck query failed: ${
                        freshErr?.message?.slice(0, 120) ?? freshErr
                    }`,
                });
                continue;
            }
            if (!freshRow) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_state_changed",
                    reason: "po row disappeared during scan",
                });
                continue;
            }

            const freshVerdict = isShipStatusCandidate(
                {
                    // The fresh select omits vendor_acknowledged_at; it can't
                    // change mid-run, so carry the snapshot's value over. The
                    // explicit assignment must come AFTER the spread so it
                    // wins: freshRow's type includes the column, but the
                    // query never returns it.
                    ...(freshRow as ShipStatusCandidate),
                    vendor_acknowledged_at: row.vendor_acknowledged_at,
                },
                Date.now(), // FRESH clock — NOT the run's captured `now`
            );
            if (!freshVerdict.ok) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_state_changed",
                    reason: `${freshVerdict.reason} while scanning`,
                });
                continue;
            }
        } catch (recheckErr) {
            console.warn(
                `[po-ship-status] ${row.po_number} fresh recheck threw:`,
                recheckErr?.message ?? recheckErr,
            );
            outcomes.push({
                poNumber: row.po_number,
                action: "skipped_state_changed",
                reason: `fresh recheck failed: ${
                    recheckErr?.message?.slice(0, 120) ?? recheckErr
                }`,
            });
            continue;
        }

        const lineItemsArr = Array.isArray(row.line_items) ? row.line_items : [];
        const ctx: VendorCommContext = {
            poNumber: row.po_number,
            vendorEmail,
            vendorName: row.vendor_name ?? "",
            subject: thread.subject,
            threadId: thread.threadId,
            messageId: thread.messageId,
            sentAt: thread.sentAt,
            hasTracking: false,
            trackingQuality: "none",
            responseType: "ship_status",
            poTotalAmount: row.total_amount ?? row.total ?? undefined,
            itemCount: lineItemsArr.length > 0 ? lineItemsArr.length : undefined,
            lineItems: lineItemsArr.map((li: any) => ({
                sku: li.sku || li.productId || undefined,
                description: li.description || li.productName || li.name || undefined,
                quantity: li.quantity || li.qty || undefined,
                unitPrice: li.unitPrice || li.price || undefined,
            })),
            issueDate: row.issue_date ?? undefined,
            requiredDate: row.required_date ?? undefined,
            lifecycleStage: row.lifecycle_stage ?? undefined,
        };

        try {
            if (!dryRun) {
                await agent.draftShipStatusRequest(ctx);
                await db
                    .from("purchase_orders")
                    .update({
                        tracking_requested_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .eq("po_number", row.po_number);

                // Self-heal stale lifecycle: vendor reply on file is proof of
                // ACKNOWLEDGED. The local cache can lag (empty or stale), so
                // on a blocked transition walk the ladder first.
                const ackRes = await transitionLifecycleState(
                    row.po_number,
                    "ACKNOWLEDGED",
                    "po-ship-status-followup",
                    {
                        source: "vendor_ack_on_file",
                        vendorName: row.vendor_name ?? undefined,
                    },
                );
                if (!ackRes.ok) {
                    await transitionLifecycleState(row.po_number, "SENT", "po-ship-status-followup", {
                        source: "self_heal_ladder",
                        vendorName: row.vendor_name ?? undefined,
                        reason: "cache_lagged_behind_ack",
                    });
                    await transitionLifecycleState(
                        row.po_number,
                        "ACKNOWLEDGED",
                        "po-ship-status-followup",
                        {
                            source: "vendor_ack_on_file",
                            vendorName: row.vendor_name ?? undefined,
                        },
                    );
                }
            }
            outcomes.push({
                poNumber: row.po_number,
                action: "drafted",
                reason: `draft to ${vendorEmail}${dryRun ? " (dry-run)" : ""}`,
            });
            draftedCount++;
        } catch (err: any) {
            console.error(
                `[po-ship-status] ${row.po_number} draft failed:`,
                err?.message ?? err,
            );
            outcomes.push({
                poNumber: row.po_number,
                action: "error",
                reason: err?.message?.slice(0, 120),
            });
        }
    }

    // Task-first notification when drafts were actually created.
    if (!dryRun && draftedCount > 0) {
        const drafted = outcomes.filter((o) => o.action === "drafted").map((o) => o.poNumber);
        await notifyViaTask({
            sourceId: `ship-status-followup:${new Date().toISOString().slice(0, 10)}`,
            type: "cron_summary",
            goal: `Review ${draftedCount} vendor ship-status draft(s) in Gmail: PO ${drafted.join(", ")}`,
            inputs: { drafted, count: draftedCount },
            summaryLabel: "Ship-status drafts",
        });
    }

    console.log(
        `[po-ship-status] done: ${draftedCount} drafted, ` +
        `${outcomes.filter((o) => o.action.startsWith("skipped")).length} skipped`,
    );
    return outcomes;
}
