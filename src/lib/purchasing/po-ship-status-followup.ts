/**
 * @file    src/lib/purchasing/po-ship-status-followup.ts
 * @purpose Close the "vendor acknowledged but never shipped" gap. A PO with a
 *          verified vendor acknowledgment but zero tracking sits invisible to
 *          po-followup-watcher (unacked only), vendor-escalation (unacked only)
 *          and po-overdue-followup (requires a past expected receive date).
 *          Bill manually asked Novelty for ship status on PO 125172 (2026-08-20,
 *          10 days after ack). This module does that ask automatically, once.
 *
 *          Task 6.1 (docs/plans/2026-10-29-aria-dashboard-hardening.md) ported
 *          this stage from branch aria/3way-match-gate-fix and reconciled it
 *          against this branch's module layout:
 *
 *            - `findPOThread` is PRIVATE to ./po-followup-watcher here, so the
 *              resolver below is a local copy instead of an import.
 *            - VendorCommsAgent has no `draftShipStatusRequest` on this branch,
 *              so the draft is built locally from buildFollowUpEmail (the same
 *              primitive vendor-comms-agent uses) and created as a Gmail DRAFT.
 *            - `notifyViaTask` is NOT called. Bill's rule: no Telegram/Slack
 *              reports. The output of this stage lands on the DASHBOARD ROW —
 *              `needs_human_review` + `last_movement_summary` on purchase_orders.
 *
 *          Three thresholds, deliberately different:
 *
 *            NO-TRACKING-AFTER-ACK (dashboard flag, 5d): the same "acked, no
 *            tracking, open" shape, surfaced EARLY so the row carries the
 *            problem while the ship date can still be fixed. Flag only — never
 *            drafts. Excludes dropship + paid-in-advance vendors (they never
 *            send tracking), see isNoTrackingAfterAckCandidate.
 *
 *            CANDIDATE (dashboard flag): acked >= 7d, no tracking, no real
 *            invoice, no receipt within 3d, still open. NO upper age bound —
 *            an old silent PO is exactly the failure this stage exists for
 *            (PO 125283: acked 2026-09-10, 900 x RAP101, $5,328, never flagged).
 *
 *            DRAFT (email): the same candidate, but only while the ack is
 *            <= MAX_DAYS_SINCE_ACK. Drafting "has it shipped?" onto a 90-day-old
 *            thread is noise; past that window the row is flagged for a human
 *            to chase or cancel instead.
 *
 * @author  Hermia
 * @created 2026-08-20
 * @updated 2026-10-29 — ported to aria/20260924-ops (WS6.1), dashboard-row output;
 *          2026-10-29 — added the 5d "no tracking after ack" early-flag trigger
 *          (NO_TRACKING_AFTER_ACK_DAYS) reusing the same dashboard surface.
 * @deps    @/lib/db, @/lib/gmail/auth, @googleapis/gmail,
 *          @/lib/carriers/tracking-service (buildFollowUpEmail),
 *          @/config/paid-in-advance-vendors (isPaidInAdvanceVendor),
 *          ./po-sender (lookupVendorOrderEmail), ./po-lifecycle
 */

import { createClient } from "@/lib/db";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { buildFollowUpEmail } from "@/lib/carriers/tracking-service";
import { isPaidInAdvanceVendor } from "@/config/paid-in-advance-vendors";
import { lookupVendorOrderEmail } from "./po-sender";
import { transitionLifecycleState } from "./po-lifecycle";

// ── Config ────────────────────────────────────────────────────────────────

/** Ask only after the vendor has had this long since acknowledging. */
export const MIN_DAYS_SINCE_ACK = 7;

/**
 * Early-warning threshold for the "acked but no tracking" trigger.
 *
 * Deliberately SHORTER than MIN_DAYS_SINCE_ACK: at 5 days a vendor who accepted
 * the PO and has not produced a tracking number is already overdue to be
 * chased (a normal LTL/parcel shipment gets a label within a couple of days).
 * This trigger only FLAGS the dashboard row — it never drafts an email. The
 * draft window still opens at MIN_DAYS_SINCE_ACK so we don't put "where's the
 * tracking?" on a thread the vendor acked on Monday.
 *
 * Why separate from MIN_DAYS_SINCE_ACK rather than just lowering it: the 7d
 * value is the draft gate and is covered by regression tests tied to real PO
 * history; lowering it would start emailing vendors a day after they replied.
 */
export const NO_TRACKING_AFTER_ACK_DAYS = 5;

/**
 * Email-draft window. Beyond this the PO is still flagged on the dashboard but
 * no "has it shipped?" draft is created — overdue/human chase owns it.
 * NOT a candidate gate: an aged silent PO is still a candidate.
 */
export const MAX_DAYS_SINCE_ACK = 30;

/**
 * How far back the scheduled scan looks for acked rows. Without a floor the
 * scan would re-flag hundreds of 2025 hunks of history; beyond ~4 months the
 * question is "why is this still in Finale", not "did the vendor ship it".
 */
export const CANDIDATE_LOOKBACK_DAYS = 120;

/** A receipt this close means goods are landing — asking is noise. */
export const RECEIPT_SOON_DAYS = 3;

/** Max email drafts per run to avoid runaway draft creation. */
export const MAX_PER_RUN = 5;

/**
 * Rows pulled per PostgREST request while walking the candidate window.
 *
 * The window is walked page by page (see scanShipStatusCandidates). A single
 * `.limit()` on an oldest-first order was the bug behind the first live run
 * returning 0 candidates: `purchase_orders` holds a 277-row cohort all sharing
 * the 2026-07-22 backfilled ack stamp, so a 200-row cap never reached PO
 * 125283 (acked 2026-09-10, ~300th row). A cap on READS is not a cap on
 * candidates.
 */
export const SCAN_PAGE_SIZE = 500;

/**
 * Safety cap on rows EXAMINED per run (not candidates). 120 days of ack rows is
 * a few hundred rows in practice; this only bounds a pathological window.
 */
export const MAX_ROWS_SCANNED = 5000;

const DROPSHIP_PATTERN =
    /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;

/** Terminal states that are not "goods still owed to us". */
const TERMINAL_STATUS_PATTERN = /received|closed|cancel|complete|void/i;

/** Marker text prefix so re-runs can tell they already stamped this row. */
export const SHIP_STATUS_SUMMARY_PREFIX = "Ship-status follow-up";

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
    needs_human_review?: boolean | null;
    last_movement_summary?: string | null;
}

export interface ShipStatusOutcome {
    poNumber: string;
    action:
        | "drafted" // Gmail DRAFT created for Bill to review
        | "flagged" // dashboard row marked (aged / dry-run) — no email
        | "skipped_invoiced" // invoice exists = goods on the way
        | "skipped_dropship"
        | "skipped_not_a_po_number"
        | "skipped_no_thread"
        | "skipped_no_email"
        | "skipped_state_changed" // PO lost eligibility mid-scan (e.g. RECEIVED)
        | "error";
    reason?: string;
}

export interface CandidateVerdict {
    ok: boolean;
    reason?:
        | "no_ack"
        | "too_early"
        | "has_tracking"
        | "already_requested"
        | "noncomm"
        | "received"
        | "terminal_status"
        | "receipt_scheduled_soon"
        | "dropship"
        | "paid_in_advance";
}

/** Which trigger surfaced a scanned candidate. */
export type ShipFollowupTrigger = "ship_status" | "no_tracking_after_ack";

// ── Pure predicates (unit-tested, DB/Gmail-free) ──────────────────────────

/**
 * Is this string a Finale purchase order number? Finale issues 6-digit POs
 * (optionally stored with a `PO-` prefix). 8-digit web/dropship order ids
 * (`23507197`) and marketplace ids are not chasable in Finale, so they are
 * never followed up here.
 */
export function isFinalePoNumber(poNumber: string | null | undefined): boolean {
    return /^(po-?)?\d{6}$/i.test(String(poNumber ?? "").trim());
}

/**
 * Vendors that ship direct to the customer / marketplace and never hand us a
 * tracking number — the same pattern po-followup-watcher and vendor-escalation
 * already use to skip dropships. Exported so the "chase for tracking" triggers
 * share one definition instead of three copies.
 */
export function isDropshipVendor(vendorName: string | null | undefined): boolean {
    return DROPSHIP_PATTERN.test(String(vendorName ?? ""));
}

/**
 * Decide whether a PO qualifies for the ship-status stage (candidate rule).
 * Pure function of the row + clock — safe to unit test without DB/Gmail.
 *
 * Qualifies when ALL hold:
 *   1. vendor_acknowledged_at set (vendor replied)
 *   2. acked at least MIN_DAYS_SINCE_ACK ago (no upper bound — aged silence is
 *      the bug this catches; the draft window is a separate predicate)
 *   3. no tracking numbers
 *   4. no tracking request made AFTER the vendor ack — a pre-ack
 *      tracking_requested_at stamp is the L1 48h receipt check from
 *      po-followup-watcher, not a tracking request, so it doesn't block
 *   5. vendor not marked noncomm
 *   6. PO not received and not terminal (closed/cancelled/completed/void)
 *   7. receipt not scheduled to land within RECEIPT_SOON_DAYS
 *
 * @param po    purchase_orders row subset
 * @param nowMs clock (injectable for tests), defaults to Date.now()
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
    // ("just making sure you received PO #X") — not a tracking request.
    // With no ack to compare against (or unparseable dates), stay conservative
    // and treat the stamp as a real tracking request. Evaluated first because
    // this verdict must win even when vendor_acknowledged_at is null.
    if (po.tracking_requested_at) {
        const reqMs = new Date(po.tracking_requested_at).getTime();
        const ackMs = po.vendor_acknowledged_at
            ? new Date(po.vendor_acknowledged_at).getTime()
            : NaN;
        const isReceiptCheckStamp = !isNaN(reqMs) && !isNaN(ackMs) && reqMs <= ackMs;
        if (!isReceiptCheckStamp) return { ok: false, reason: "already_requested" };
    }

    if (!po.vendor_acknowledged_at) return { ok: false, reason: "no_ack" };

    const ackedMs = new Date(po.vendor_acknowledged_at).getTime();
    if (isNaN(ackedMs)) return { ok: false, reason: "no_ack" };
    const daysAcked = Math.floor((nowMs - ackedMs) / 86_400_000);
    if (daysAcked < MIN_DAYS_SINCE_ACK) return { ok: false, reason: "too_early" };

    if (po.tracking_numbers && po.tracking_numbers.length > 0) {
        return { ok: false, reason: "has_tracking" };
    }
    if (po.vendor_noncomm_at) return { ok: false, reason: "noncomm" };

    const status = (po.status ?? "").toLowerCase();
    if (status === "received") return { ok: false, reason: "received" };
    if (status && TERMINAL_STATUS_PATTERN.test(status)) {
        return { ok: false, reason: "terminal_status" };
    }
    if (po.receive_date) {
        const rMs = new Date(po.receive_date).getTime();
        if (!isNaN(rMs) && rMs < nowMs) return { ok: false, reason: "received" };
        // Receipt scheduled within the next few days = goods are landing.
        if (!isNaN(rMs) && rMs - nowMs <= RECEIPT_SOON_DAYS * 86_400_000) {
            return { ok: false, reason: "receipt_scheduled_soon" };
        }
    }

    return { ok: true };
}

/**
 * "No tracking after ack" trigger — the early-warning sibling of
 * isShipStatusCandidate.
 *
 * Tracking coverage is ~13% ETA / ~97% stale, and the dominant failure mode is
 * a PO the vendor ACKNOWLEDGED and then went quiet on. A PO with a vendor ack
 * but an empty tracking_numbers array (and not received) is the signal to chase;
 * this predicate fires at NO_TRACKING_AFTER_ACK_DAYS (5) instead of waiting the
 * full MIN_DAYS_SINCE_ACK (7) draft window, so the dashboard row carries the
 * problem while there is still time to fix the ship date.
 *
 * Qualifies when ALL hold:
 *   1. vendor_acknowledged_at set and parseable
 *   2. acked at least NO_TRACKING_AFTER_ACK_DAYS ago
 *   3. tracking_numbers empty
 *   4. no tracking request made AFTER the ack (same semantics as the 7d
 *      predicate: a pre-ack stamp is po-followup-watcher's L1 receipt check)
 *   5. vendor not marked noncomm
 *   6. status not received and not terminal (closed/cancelled/completed/void)
 *   7. no receipt landed or scheduled inside RECEIPT_SOON_DAYS
 *   8. not a dropship vendor (never sends tracking)
 *   9. not a paid-in-advance vendor (goods ship on our payment, tracking is
 *      handled off-thread — chasing produces noise, not shipments)
 *
 * Pure: row + clock only, no DB/Gmail. Never drafts — the caller flags.
 */
export function isNoTrackingAfterAckCandidate(
    po: Pick<
        ShipStatusCandidate,
        | "vendor_name"
        | "vendor_acknowledged_at"
        | "tracking_numbers"
        | "tracking_requested_at"
        | "vendor_noncomm_at"
        | "receive_date"
        | "status"
    >,
    nowMs: number = Date.now(),
): CandidateVerdict {
    if (isDropshipVendor(po.vendor_name)) return { ok: false, reason: "dropship" };
    if (isPaidInAdvanceVendor(po.vendor_name)) {
        return { ok: false, reason: "paid_in_advance" };
    }

    if (po.tracking_requested_at) {
        const reqMs = new Date(po.tracking_requested_at).getTime();
        const ackMs = po.vendor_acknowledged_at
            ? new Date(po.vendor_acknowledged_at).getTime()
            : NaN;
        const isReceiptCheckStamp = !isNaN(reqMs) && !isNaN(ackMs) && reqMs <= ackMs;
        if (!isReceiptCheckStamp) return { ok: false, reason: "already_requested" };
    }

    const daysAcked = daysSinceAck(po.vendor_acknowledged_at, nowMs);
    if (daysAcked === null) return { ok: false, reason: "no_ack" };
    if (daysAcked < NO_TRACKING_AFTER_ACK_DAYS) return { ok: false, reason: "too_early" };

    if (Array.isArray(po.tracking_numbers) && po.tracking_numbers.length > 0) {
        return { ok: false, reason: "has_tracking" };
    }
    if (po.vendor_noncomm_at) return { ok: false, reason: "noncomm" };

    const status = (po.status ?? "").toLowerCase();
    if (status === "received") return { ok: false, reason: "received" };
    if (status && TERMINAL_STATUS_PATTERN.test(status)) {
        return { ok: false, reason: "terminal_status" };
    }

    if (po.receive_date) {
        const rMs = new Date(po.receive_date).getTime();
        if (!isNaN(rMs) && rMs < nowMs) return { ok: false, reason: "received" };
        if (!isNaN(rMs) && rMs - nowMs <= RECEIPT_SOON_DAYS * 86_400_000) {
            return { ok: false, reason: "receipt_scheduled_soon" };
        }
    }

    return { ok: true };
}

/**
 * Should this candidate also get an email draft? Only inside the draft window.
 * Beyond MAX_DAYS_SINCE_ACK the row is flagged for a human instead.
 */
export function shouldDraftShipStatus(
    po: Pick<ShipStatusCandidate, "vendor_acknowledged_at">,
    nowMs: number = Date.now(),
): boolean {
    if (!po.vendor_acknowledged_at) return false;
    const ackedMs = new Date(po.vendor_acknowledged_at).getTime();
    if (isNaN(ackedMs)) return false;
    const daysAcked = Math.floor((nowMs - ackedMs) / 86_400_000);
    return daysAcked >= MIN_DAYS_SINCE_ACK && daysAcked <= MAX_DAYS_SINCE_ACK;
}

/** Whole days since the vendor acknowledged, or null when unparseable. */
export function daysSinceAck(
    vendorAcknowledgedAt: string | null | undefined,
    nowMs: number = Date.now(),
): number | null {
    if (!vendorAcknowledgedAt) return null;
    const ms = new Date(vendorAcknowledgedAt).getTime();
    if (isNaN(ms)) return null;
    return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

/**
 * A zero-total invoice row is not proof the vendor billed — WS2.4 established
 * that a $0 identity (phantom OCR row) must not satisfy the invoice leg. For
 * ship-status purposes only a positive total means "goods are on their way",
 * so PO 125283 (invoice 5271576 at $0.00) stays a follow-up candidate.
 */
export function hasRealInvoice(
    rows: Array<{ total?: number | string | null }> | null | undefined,
): boolean {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return rows.some((row) => {
        const total = typeof row?.total === "string" ? Number(row.total) : row?.total;
        return typeof total === "number" && Number.isFinite(total) && total > 0;
    });
}

/**
 * Dashboard-row text for a silent PO. Written to
 * purchase_orders.last_movement_summary so the Active Purchases row says why
 * it is flagged, without a Telegram/Slack message.
 */
export function silentPoSummary(daysAcked: number, nowMs: number = Date.now()): string {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    return (
        `${SHIP_STATUS_SUMMARY_PREFIX} ${day}: vendor acked ${daysAcked}d ago, ` +
        `no tracking, no invoice — chase ship status or cancel.`
    );
}

/** Did a previous run of this stage already stamp this row? */
export function alreadyFlaggedByShipStatus(
    row: Pick<ShipStatusCandidate, "last_movement_summary"> | null | undefined,
): boolean {
    return String(row?.last_movement_summary ?? "").startsWith(SHIP_STATUS_SUMMARY_PREFIX);
}

// ── PO thread resolution (local copy of po-followup-watcher's private helper) ──

interface POThreadRef {
    threadId: string;
    messageId: string;
    subject: string;
    sentAt: Date;
    vendorEmail: string | null;
}

async function resolvePOThread(gmail: any, poNumber: string): Promise<POThreadRef | null> {
    const digits = poNumber.replace(/^PO-?/i, "");
    const search = await gmail.users.messages.list({
        userId: "me",
        q: `(subject:"PO #${digits}" OR subject:"PO ${digits}")`,
        maxResults: 10,
    });
    const msgs = search.data?.messages ?? [];
    for (const m of msgs) {
        const t = await gmail.users.threads.get({
            userId: "me",
            id: m.threadId,
            format: "metadata",
            metadataHeaders: ["Subject", "To", "From", "Date", "Message-ID"],
        });
        const allMsgs = t.data?.messages ?? [];
        if (allMsgs.length === 0) continue;

        // Two outbound PO paths exist:
        //   (a) Gmail send from bill.selee@ — SENT label; To: is often ourselves
        //       with the vendor in BCC, so the caller falls back to the lookup.
        //   (b) Finale native send — From=noreply@mail.finaleinventory.com,
        //       To: is the actual vendor.
        let anchor: any = null;
        let toVendor: string | null = null;
        for (const msg of allMsgs) {
            const labels = msg.labelIds ?? [];
            const hs = msg.payload?.headers ?? [];
            const fromHeader = (hs.find((h: any) => h.name === "From")?.value ?? "").toLowerCase();
            const isGmailSend = labels.includes("SENT");
            const isFinaleSend = /noreply@mail\.finaleinventory\.com/i.test(fromHeader);
            if (!isGmailSend && !isFinaleSend) continue;
            anchor = msg;
            if (isFinaleSend) {
                const toHeader = hs.find((h: any) => h.name === "To")?.value ?? "";
                const em = toHeader.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
                if (em && !/buildasoil\.com/i.test(em[0])) toVendor = em[0];
            }
            break;
        }
        if (!anchor) continue;

        const headers = anchor.payload?.headers ?? [];
        const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "";
        if (!new RegExp(`PO[-\\s]*#?\\s*${digits}\\b`).test(subject)) continue;
        const messageIdHeader = headers.find((h: any) => h.name === "Message-ID")?.value ?? anchor.id;

        return {
            threadId: anchor.threadId!,
            messageId: messageIdHeader,
            subject,
            sentAt: new Date(parseInt(anchor.internalDate ?? "0", 10)),
            vendorEmail: toVendor,
        };
    }
    return null;
}

// ── Dashboard row write (the only output of this stage) ───────────────────

/**
 * Land the follow-up on the dashboard row. Bill's rule: no Telegram/Slack.
 * Idempotent for an unchanged row — a row already carrying this stage's exact
 * summary text is not rewritten on every tick. The text embeds the ack age and
 * the run date, so a later run (more days acked) DOES refresh it; a frozen
 * "acked 5d ago" on a 40-day-old PO is exactly the stale-signal problem this
 * stage exists to remove.
 */
export async function flagPoOnDashboard(
    db: any,
    poNumber: string,
    opts: { daysAcked: number; needsHumanReview?: boolean; nowMs?: number },
): Promise<void> {
    const now = new Date(opts.nowMs ?? Date.now());
    const { data: existing, error: readErr } = await db
        .from("purchase_orders")
        .select("needs_human_review, last_movement_summary")
        .eq("po_number", poNumber)
        .maybeSingle();
    if (readErr) {
        console.warn(
            `[po-ship-status] ${poNumber} flag pre-read failed:`,
            readErr?.message ?? readErr,
        );
    }
    const wantReview = opts.needsHumanReview !== false;
    const summary = silentPoSummary(opts.daysAcked, now.getTime());
    if (
        existing &&
        alreadyFlaggedByShipStatus(existing) &&
        existing.last_movement_summary === summary &&
        (existing.needs_human_review === wantReview || !wantReview)
    ) {
        return; // already stamped by an earlier run with this exact text
    }
    const { error } = await db
        .from("purchase_orders")
        .update({
            needs_human_review: wantReview,
            last_movement_summary: summary,
            updated_at: now.toISOString(),
        })
        .eq("po_number", poNumber);
    if (error) {
        console.warn(`[po-ship-status] ${poNumber} dashboard flag failed:`, error.message);
    }
}

// ── Candidate scan (DB reads only, no writes) ─────────────────────────────

export interface ScannedCandidate {
    po: ShipStatusCandidate;
    daysAcked: number;
    draftWorthy: boolean;
    /** Which trigger surfaced this row. Early rows flag only, never draft. */
    trigger: ShipFollowupTrigger;
}

/**
 * Rows that pass the pure candidate filter and have no REAL invoice.
 * Exposed so a dry-run probe and the cron share one definition of "candidate".
 *
 * The window is paged (SCAN_PAGE_SIZE at a time) up to MAX_ROWS_SCANNED rows.
 * Paging — not one capped read — is load-bearing: rows tie on
 * `vendor_acknowledged_at` (277 rows share one backfilled 2026-07-22 stamp), so
 * a single oldest-first `.limit()` silently hides every later candidate.
 * Rows are de-duplicated by po_number in case a tie crosses a page boundary.
 */
export async function scanShipStatusCandidates(
    db: any,
    opts: { nowMs?: number; limit?: number } = {},
): Promise<ScannedCandidate[]> {
    const now = opts.nowMs ?? Date.now();
    // The read window opens at the EARLIER trigger (no-tracking-after-ack, 5d)
    // so the early-warning rows are loaded too; the 7d draft gate is enforced by
    // isShipStatusCandidate per row, not by the query.
    const minAck = new Date(now - NO_TRACKING_AFTER_ACK_DAYS * 86_400_000).toISOString();
    const lookback = new Date(now - CANDIDATE_LOOKBACK_DAYS * 86_400_000).toISOString();
    const maxRows = Math.min(opts.limit ?? MAX_ROWS_SCANNED, MAX_ROWS_SCANNED);

    const rows: ShipStatusCandidate[] = [];
    const seen = new Set<string>();
    let readError: any = null;

    for (let offset = 0; offset < maxRows; offset += SCAN_PAGE_SIZE) {
        const take = Math.min(SCAN_PAGE_SIZE, maxRows - offset);
        const page = await db
            .from("purchase_orders")
            .select(
                "po_number, vendor_name, vendor_party_id, vendor_acknowledged_at, " +
                "tracking_numbers, tracking_requested_at, vendor_noncomm_at, " +
                "lifecycle_stage, receive_date, status, total_amount, total, " +
                "line_items, issue_date, required_date, needs_human_review, " +
                "last_movement_summary",
            )
            .gte("vendor_acknowledged_at", lookback)
            .lte("vendor_acknowledged_at", minAck)
            // No .is("tracking_requested_at", null): a pre-ack stamp (L1 receipt
            // check) must not exclude the PO — the comparison lives in the filter.
            .is("vendor_noncomm_at", null)
            // Null-safe exclusion: .neq("status","received") would drop NULL rows.
            .or("status.is.null,status.neq.received")
            // Oldest acks first: the long-silent POs are the point of this stage.
            .order("vendor_acknowledged_at", { ascending: true })
            .limit(take)
            .offset(offset);

        if (page.error) {
            readError = page.error;
            break;
        }
        const batch = (page.data ?? []) as ShipStatusCandidate[];
        for (const row of batch) {
            if (!row?.po_number || seen.has(row.po_number)) continue;
            seen.add(row.po_number);
            rows.push(row);
        }
        if (batch.length < take) break;
        if (offset + take >= maxRows) {
            console.warn(
                `[po-ship-status] scan truncated at ${maxRows} rows — window is larger than MAX_ROWS_SCANNED`,
            );
        }
    }

    if (readError) {
        console.error("[po-ship-status] query failed:", readError.message);
        return [];
    }
    if (rows.length === 0) return [];

    const candidateRows: ShipStatusCandidate[] = [];
    const triggerByPo = new Map<string, ShipFollowupTrigger>();
    for (const row of rows) {
        if (!isFinalePoNumber(row.po_number)) continue;
        if (isShipStatusCandidate(row, now).ok) {
            candidateRows.push(row);
            triggerByPo.set(row.po_number, "ship_status");
            continue;
        }
        // 5-6d acked + no tracking: advertise the row early. Drafts stay gated
        // at MIN_DAYS_SINCE_ACK inside the loop.
        if (isNoTrackingAfterAckCandidate(row, now).ok) {
            candidateRows.push(row);
            triggerByPo.set(row.po_number, "no_tracking_after_ack");
        }
    }
    if (candidateRows.length === 0) return [];

    // Invoice leg: only a POSITIVE total proves the vendor billed (WS2.4).
    const invoiced = new Set<string>();
    const numbers = candidateRows.map((row) => row.po_number);
    for (let i = 0; i < numbers.length; i += 100) {
        const chunk = numbers.slice(i, i + 100);
        try {
            const { data: invRows, error: invErr } = await db
                .from("vendor_invoices")
                .select("po_number, total")
                .in("po_number", chunk);
            if (invErr) {
                console.warn("[po-ship-status] invoice read failed:", invErr.message);
                continue;
            }
            const byPo = new Map<string, Array<{ total?: number | null }>>();
            for (const inv of invRows ?? []) {
                if (!inv?.po_number) continue;
                if (!byPo.has(inv.po_number)) byPo.set(inv.po_number, []);
                byPo.get(inv.po_number)!.push(inv);
            }
            for (const [po, invs] of byPo) {
                if (hasRealInvoice(invs)) invoiced.add(po);
            }
        } catch (err: any) {
            console.warn("[po-ship-status] invoice check threw:", err?.message ?? err);
        }
    }

    return candidateRows
        .filter((row) => !invoiced.has(row.po_number))
        .map((row) => {
            const trigger = triggerByPo.get(row.po_number) ?? "ship_status";
            return {
                po: row,
                daysAcked: daysSinceAck(row.vendor_acknowledged_at, now) ?? 0,
                // Early rows are never draft-worthy: the draft window is the
                // existing 7-30d gate, unchanged by this trigger.
                draftWorthy: trigger === "ship_status" && shouldDraftShipStatus(row, now),
                trigger,
            };
        });
}

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Run the ship-status follow-up stage.
 *
 * Per candidate (acked, no tracking, no real invoice, not received):
 *   0. 5-6d acked (early trigger): flag the dashboard row only, no email.
 *   1. Mark the dashboard row (needs_human_review + last_movement_summary).
 *   2. Inside the draft window only: resolve the PO thread + vendor email,
 *      re-check freshness, create a Gmail DRAFT in-thread, stamp
 *      tracking_requested_at, and self-heal a stale lifecycle stage.
 *   3. Older than the draft window: flag only — a human chases or cancels.
 *
 * @param opts.dryRun plan only — no Gmail calls, no DB writes
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

    const candidates = await scanShipStatusCandidates(db, { nowMs: now });
    if (candidates.length === 0) {
        console.log("[po-ship-status] no candidates");
        return outcomes;
    }

    let gmail: any = null;
    let draftedCount = 0;

    for (const candidate of candidates) {
        const row = candidate.po;

        if (isDropshipVendor(row.vendor_name)) {
            outcomes.push({ poNumber: row.po_number, action: "skipped_dropship" });
            continue;
        }

        // ── Early "no tracking after ack" trigger: flag only, never draft ──
        // The row is actionable at 5 days, but the email window still opens at
        // MIN_DAYS_SINCE_ACK — a "where's the tracking?" draft on a thread the
        // vendor acked on Monday is noise. Same dashboard surface, same
        // idempotence stamp; only the reason differs.
        if (candidate.trigger === "no_tracking_after_ack") {
            const earlyReason =
                `acked ${candidate.daysAcked}d, no tracking, no invoice — flagged early ` +
                `(draft window opens at ${MIN_DAYS_SINCE_ACK}d)`;
            if (dryRun) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "flagged",
                    reason: `dry-run: would flag — ${earlyReason}`,
                });
                continue;
            }
            try {
                await flagPoOnDashboard(db, row.po_number, {
                    daysAcked: candidate.daysAcked,
                    needsHumanReview: true,
                    nowMs: now,
                });
            } catch (flagErr) {
                console.warn(
                    `[po-ship-status] ${row.po_number} early flag write threw:`,
                    flagErr instanceof Error ? flagErr.message : flagErr,
                );
            }
            outcomes.push({
                poNumber: row.po_number,
                action: "flagged",
                reason: earlyReason,
            });
            continue;
        }

        if (dryRun) {
            outcomes.push({
                poNumber: row.po_number,
                action: "flagged",
                reason:
                    `dry-run: acked ${candidate.daysAcked}d, no tracking, no invoice → ` +
                    (candidate.draftWorthy
                        ? "would flag + draft ship-status request"
                        : `would flag (past ${MAX_DAYS_SINCE_ACK}d draft window)`),
            });
            continue;
        }

        // ── 1. Dashboard row is the always-delivered output ───────────────
        try {
            await flagPoOnDashboard(db, row.po_number, {
                daysAcked: candidate.daysAcked,
                needsHumanReview: true,
                nowMs: now,
            });
        } catch (flagErr: any) {
            console.warn(
                `[po-ship-status] ${row.po_number} flag write threw:`,
                flagErr?.message ?? flagErr,
            );
        }

        // ── 2. Aged out of the email window: flag only ────────────────────
        if (!candidate.draftWorthy) {
            outcomes.push({
                poNumber: row.po_number,
                action: "flagged",
                reason: `acked ${candidate.daysAcked}d (> ${MAX_DAYS_SINCE_ACK}d draft window)`,
            });
            continue;
        }

        if (draftedCount >= MAX_PER_RUN) {
            outcomes.push({
                poNumber: row.po_number,
                action: "flagged",
                reason: "draft budget exhausted this run",
            });
            continue;
        }

        // ── 3. Draft a ship-status request in-thread ──────────────────────
        try {
            if (!gmail) {
                gmail = GmailApi({
                    version: "v1",
                    auth: await getAuthenticatedClient("default"),
                });
            }

            const thread = await resolvePOThread(gmail, row.po_number);
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

            // Read-then-act race guard: the snapshot above was taken before the
            // slow lookups. Re-select the freshness columns and re-run the filter
            // against a FRESH clock so a PO that flipped to RECEIVED mid-scan is
            // never drafted at. Fail closed on a read error.
            const { data: freshRow, error: freshErr } = await db
                .from("purchase_orders")
                .select(
                    "status, receive_date, tracking_numbers, " +
                    "tracking_requested_at, vendor_noncomm_at",
                )
                .eq("po_number", row.po_number)
                .maybeSingle();
            if (freshErr) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_state_changed",
                    reason: `fresh recheck query failed: ${String(freshErr?.message ?? freshErr).slice(0, 120)}`,
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
            // vendor_acknowledged_at is not in the fresh select (it cannot change
            // mid-run), so carry the snapshot value — after the spread, so it wins.
            const freshVerdict = isShipStatusCandidate(
                {
                    ...(freshRow as ShipStatusCandidate),
                    vendor_acknowledged_at: row.vendor_acknowledged_at,
                },
                Date.now(),
            );
            if (!freshVerdict.ok) {
                outcomes.push({
                    poNumber: row.po_number,
                    action: "skipped_state_changed",
                    reason: `${freshVerdict.reason} while scanning`,
                });
                continue;
            }

            const lineItems = Array.isArray(row.line_items) ? row.line_items : [];
            const itemLines = lineItems
                .slice(0, 5)
                .map((li: any) => {
                    const sku = li.sku || li.productId || "item";
                    const qty = li.quantity ?? li.qty;
                    return qty ? `- ${sku} (qty ${qty})` : `- ${sku}`;
                })
                .join("\n");
            const body =
                `Hi,\n\n` +
                `Thanks for confirming PO #${row.po_number}` +
                (row.total_amount || row.total ? ` ($${Number(row.total_amount ?? row.total).toFixed(2)})` : "") +
                `. We don't have tracking for it yet.` +
                (itemLines ? `\n\nPO Details:\n  ${itemLines.replace(/\n/g, "\n  ")}` : "") +
                `\n\nCould you send the ship date and tracking — or the BOL/PRO if it is going LTL?\n\n` +
                `Thanks!\nBuildASoil Purchasing`;

            const rawEmail = buildFollowUpEmail({
                to: vendorEmail,
                subject: `Re: ${thread.subject}`,
                inReplyTo: thread.messageId,
                references: thread.messageId,
                body,
            });

            const draftRes = await gmail.users.drafts.create({
                userId: "me",
                requestBody: {
                    message: {
                        raw: Buffer.from(rawEmail).toString("base64url"),
                        threadId: thread.threadId,
                    },
                },
            });

            const stampedAt = new Date().toISOString();
            const { error: stampErr } = await db
                .from("purchase_orders")
                .update({ tracking_requested_at: stampedAt, updated_at: stampedAt })
                .eq("po_number", row.po_number);
            if (stampErr) {
                console.warn(
                    `[po-ship-status] ${row.po_number} tracking stamp failed:`,
                    stampErr.message,
                );
            }

            // Self-heal stale lifecycle: a vendor reply on file is proof of
            // ACKNOWLEDGED. On this branch transitionLifecycleState() returns
            // void and silently skips an invalid hop, so walk the ladder only
            // when the cached stage is still early — never drag a progressed
            // PO (RECEIVED/RECONCILED) backwards.
            const stage = String(row.lifecycle_stage ?? "").toUpperCase();
            if (stage === "" || stage === "DRAFT" || stage === "REVIEW") {
                await transitionLifecycleState(row.po_number, "SENT", "po-ship-status-followup", {
                    source: "self_heal_ladder",
                    vendorName: row.vendor_name ?? undefined,
                    reason: "cache_lagged_behind_ack",
                });
                await transitionLifecycleState(
                    row.po_number,
                    "ACKNOWLEDGED",
                    "po-ship-status-followup",
                    { source: "vendor_ack_on_file", vendorName: row.vendor_name ?? undefined },
                );
            }

            outcomes.push({
                poNumber: row.po_number,
                action: "drafted",
                reason: `draft to ${vendorEmail} (draftId ${draftRes?.data?.id ?? "?"})`,
            });
            draftedCount++;
        } catch (err: any) {
            console.error(`[po-ship-status] ${row.po_number} draft failed:`, err?.message ?? err);
            outcomes.push({
                poNumber: row.po_number,
                action: "error",
                reason: String(err?.message ?? err).slice(0, 120),
            });
        }
    }

    console.log(
        `[po-ship-status] done: ${draftedCount} drafted, ` +
        `${outcomes.filter((o) => o.action === "flagged").length} flagged, ` +
        `${outcomes.filter((o) => o.action.startsWith("skipped")).length} skipped`,
    );
    return outcomes;
}
