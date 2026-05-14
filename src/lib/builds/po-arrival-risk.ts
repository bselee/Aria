/**
 * @file    po-arrival-risk.ts
 * @purpose Detect open POs whose expected arrival lands AFTER the projected
 *          stockout for one of their line-item SKUs. These are the POs that
 *          are going to bite us — stock runs out, builds are short, vendor
 *          hasn't confirmed shipping. The detector emits a structured signal;
 *          the po_arrival_at_risk flow drafts the vendor ETA email.
 *
 *          The detector classifies the *vendor communication state* per PO
 *          so the downstream draft can match tone: friendly nudge for "no
 *          response at all" vs urgent "where's the truck" for tracking
 *          provided but no movement.
 *
 *          Inputs:
 *            - loadActivePurchases() — open POs with expectedDate + lifecycle
 *            - getPurchasingIntelligence() — per-SKU stockOnHand + dailyRate
 *
 *          Output: AtRiskPO[] — one per PO that has at least one line-item
 *          SKU running out before arrival.
 */

import type { ActivePurchase } from "../purchasing/active-purchases";
import type { PurchasingItem } from "../finale/client";
import { createClient } from "../supabase";

export type VendorCommState =
    | "none"                       // PO sent, vendor silent
    | "auto_acknowledged"          // ack'd by automated/system reply only
    | "recent_human_reply"         // a real human at the vendor replied recently
    | "eta_stated_no_tracking"     // vendor gave an ETA but no tracking
    | "tracking_no_movement"       // tracking exists but no scan/movement
    | "shipped_past_eta";          // ETA passed, still not received

export interface AtRiskItem {
    sku: string;
    productName?: string;
    stockOnHand: number;
    dailyRate: number;
    runwayDays: number;
    stockoutDate: string;       // ISO date — today + runwayDays
    daysShort: number;          // expectedArrival - stockoutDate (positive ⇒ risk)
    affectedFGs?: string[];     // FGs that consume this SKU (best-effort)
}

/**
 * Two severity tiers so the UI can split current pain from heads-up:
 *   at_risk      — stockout already lands before arrival (daysShort >= AT_RISK_THRESHOLD)
 *   soon_at_risk — margin is thin (daysShort within [-PROACTIVE_WINDOW, AT_RISK_THRESHOLD))
 */
export type AtRiskSeverity = "at_risk" | "soon_at_risk";

export const AT_RISK_THRESHOLD_DAYS = 3;
export const PROACTIVE_WINDOW_DAYS = 14;

export interface AtRiskPO {
    poId: string;
    vendorName: string;
    vendorPartyId: string | null;
    severity: AtRiskSeverity;
    orderDate: string | null;
    expectedArrival: string;       // ISO date
    leadProvenance: string;        // e.g. "14d (Finale)"
    commState: VendorCommState;
    /** What we know about vendor responsiveness — drives draft tone. */
    facts: {
        poSentAt: string | null;
        vendorAcknowledgedAt: string | null;
        humanReplyDetectedAt: string | null;
        vendorStatedEta: string | null;
        trackingNumbers: string[];
        lastMovementSummary: string | null;
        lifecycleStage: string | null;
    };
    /** SKUs on this PO that will stock out before the PO arrives. */
    atRiskItems: AtRiskItem[];
    /** Worst-case days short across atRiskItems (for sort/severity). */
    worstDaysShort: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function todayIso(): string {
    return isoDate(new Date());
}

function addDaysIso(baseIso: string, days: number): string {
    const d = new Date(baseIso);
    d.setUTCDate(d.getUTCDate() + Math.round(days));
    return isoDate(d);
}

function daysBetween(fromIso: string, toIso: string): number {
    const a = new Date(fromIso).getTime();
    const b = new Date(toIso).getTime();
    return Math.round((b - a) / 86_400_000);
}

const RECENT_HUMAN_REPLY_WINDOW_DAYS = 7;

/**
 * Classify the vendor's current communication state on a PO. Precedence
 * (highest urgency / strongest signal first):
 *   shipped_past_eta → tracking_no_movement → eta_stated_no_tracking
 *   → recent_human_reply → auto_acknowledged → none
 */
export function classifyVendorCommState(
    po: Pick<ActivePurchase, "vendorAcknowledgedAt" | "humanReplyDetectedAt" | "trackingNumbers" | "shipments" | "etaProfile" | "isReceived">,
    todayDate: string = todayIso(),
): VendorCommState {
    const hasTracking = (po.trackingNumbers ?? []).length > 0;
    const shipments = po.shipments ?? [];
    const hasMovement = shipments.some((s: any) =>
        s.delivered_at ||
        s.status_category === "in_transit" ||
        s.status_category === "delivered" ||
        s.status_category === "out_for_delivery",
    );
    const hasAck = !!po.vendorAcknowledgedAt;
    const promisedEta = (po.etaProfile as any)?.vendorPromisedEta ?? null;
    const etaPassed = !!promisedEta && new Date(promisedEta) < new Date(todayDate);

    if (etaPassed && !po.isReceived) return "shipped_past_eta";
    if (hasTracking && !hasMovement) return "tracking_no_movement";
    if (promisedEta && !hasTracking) return "eta_stated_no_tracking";

    // Real human reply trumps automated ack — Gayle@Coats replying explicitly
    // about an invoice is qualitatively different from a system auto-ack.
    if (po.humanReplyDetectedAt) {
        const replyAge = (new Date(todayDate).getTime() - new Date(po.humanReplyDetectedAt).getTime()) / 86_400_000;
        if (replyAge <= RECENT_HUMAN_REPLY_WINDOW_DAYS) return "recent_human_reply";
    }
    if (hasAck && !hasTracking) return "auto_acknowledged";
    return "none";
}

// ── detector ───────────────────────────────────────────────────────────────

export interface DetectAtRiskPOsInput {
    activePOs: ActivePurchase[];
    purchasingItems: PurchasingItem[];
    today?: string;
    /** Only flag SKUs that are at least N days short. Default 3 — cuts noise. */
    minDaysShort?: number;
    /**
     * PO numbers for which we already have an invoice in vendor_invoices.
     * The vendor has billed us — they've shipped (or are shipping) on their
     * side. Don't flag these as "at risk of late arrival"; they're moving.
     */
    poNumbersWithInvoice?: Set<string>;
}

export function detectAtRiskPOs(input: DetectAtRiskPOsInput): AtRiskPO[] {
    const today = input.today ?? todayIso();
    // Lower bound: AT_RISK_THRESHOLD bumps a SKU to at_risk; anything in
    // [-PROACTIVE_WINDOW, AT_RISK_THRESHOLD) is soon_at_risk. Caller can
    // still override via minDaysShort to e.g. cut the proactive tier.
    const minDaysShort = input.minDaysShort ?? -PROACTIVE_WINDOW_DAYS;
    const invoiceMatched = input.poNumbersWithInvoice ?? new Set<string>();

    // Index per-SKU intelligence for O(1) lookup.
    const skuIntel = new Map<string, PurchasingItem>();
    for (const item of input.purchasingItems) {
        if (item.productId) skuIntel.set(item.productId, item);
    }

    const out: AtRiskPO[] = [];

    for (const po of input.activePOs) {
        if (!po.orderId || po.isReceived) continue;
        if (!po.expectedDate) continue;

        // Vendor has shipped/delivered/billed on their side — not at risk.
        // completionState moves past "in_transit" the moment tracking shows
        // delivered, receipt is in Finale, OR an invoice match is logged.
        if (po.completionState && po.completionState !== "in_transit") continue;
        if (invoiceMatched.has(po.orderId)) continue;

        const atRiskItems: AtRiskItem[] = [];
        for (const line of po.items ?? []) {
            const sku = line.productId;
            if (!sku) continue;
            const intel = skuIntel.get(sku);
            if (!intel) continue;
            if (!isFinite(intel.dailyRate) || intel.dailyRate <= 0) continue;
            if (!isFinite(intel.stockOnHand)) continue;

            const stockoutDate = addDaysIso(today, intel.runwayDays);
            const daysShort = daysBetween(stockoutDate, po.expectedDate);
            if (daysShort < minDaysShort) continue;

            atRiskItems.push({
                sku,
                productName: intel.productName,
                stockOnHand: intel.stockOnHand,
                dailyRate: intel.dailyRate,
                runwayDays: intel.runwayDays,
                stockoutDate,
                daysShort,
                affectedFGs: intel.feedsFinishedGoods?.map((f) => f.sku),
            });
        }

        if (atRiskItems.length === 0) continue;

        // Negative daysShort means buffer remains (soon_at_risk tier); preserve
        // the sign so the UI / writer can show "5d buffer" vs "6d short".
        const worstDaysShort = atRiskItems.reduce(
            (m, i) => (i.daysShort > m ? i.daysShort : m),
            Number.NEGATIVE_INFINITY,
        );
        const severity: AtRiskSeverity =
            worstDaysShort >= AT_RISK_THRESHOLD_DAYS ? "at_risk" : "soon_at_risk";

        out.push({
            poId: po.orderId,
            vendorName: po.vendorName ?? "Unknown Vendor",
            vendorPartyId: (po as any).vendorPartyId ?? null,
            severity,
            orderDate: po.orderDate ?? null,
            expectedArrival: po.expectedDate,
            leadProvenance: po.leadProvenance ?? "unknown",
            commState: classifyVendorCommState(po, today),
            facts: {
                poSentAt: (po as any).sentVerification?.sentAt ?? po.orderDate ?? null,
                vendorAcknowledgedAt: po.vendorAcknowledgedAt ?? null,
                humanReplyDetectedAt: po.humanReplyDetectedAt ?? null,
                vendorStatedEta: (po.etaProfile as any)?.vendorPromisedEta ?? null,
                trackingNumbers: po.trackingNumbers ?? [],
                lastMovementSummary: po.lastMovementSummary ?? null,
                lifecycleStage: po.lifecycleStage ?? null,
            },
            atRiskItems,
            worstDaysShort,
        });
    }

    // Worst-first so the dashboard / cron sees most urgent up top. Severity
    // is implicit in worstDaysShort (>=3 vs <3), so sort by it alone.
    out.sort((a, b) => b.worstDaysShort - a.worstDaysShort);
    return out;
}

// ── Activity-feed writer ───────────────────────────────────────────────────
//
// Per the Activity-first routing rule: detected risks land as Activity rows
// FIRST (intent=PO_ARRIVAL_AT_RISK), not as Slack/Gmail pushes. Builds panel
// renders a red-alert summary from these rows; "Compose ETA draft" and other
// next-step actions are triggered FROM the Activity row by Will/dashboard.

const ACTIVITY_INTENT_PO_AT_RISK = "PO_ARRIVAL_AT_RISK";

function commStateLabel(s: VendorCommState): string {
    return s.replace(/_/g, " ");
}

function summarizeAtRiskItems(items: AtRiskItem[]): string {
    if (items.length === 0) return "no items";
    const head = items.slice(0, 3).map((i) =>
        `${i.sku} (${i.daysShort}d short)`,
    ).join(", ");
    return items.length > 3 ? `${head}, +${items.length - 3} more` : head;
}

/**
 * Returns the set of PO numbers that already have a matched invoice in
 * vendor_invoices. Used by the detector to skip POs whose vendors have
 * already done their part (invoice = they shipped / are shipping).
 *
 * Looks back 90 days to keep the query bounded — older invoices wouldn't
 * be relevant to currently-open POs anyway.
 */
export async function loadInvoiceMatchedPOs(poNumbers: string[]): Promise<Set<string>> {
    if (poNumbers.length === 0) return new Set();
    const sb = createClient();
    if (!sb) return new Set();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const { data, error } = await sb
        .from("vendor_invoices")
        .select("po_number")
        .in("po_number", poNumbers)
        .gte("invoice_date", cutoff.toISOString().slice(0, 10));
    if (error) {
        console.warn(`[po-arrival-risk] vendor_invoices read failed: ${error.message}`);
        return new Set();
    }
    return new Set((data ?? []).map((r) => r.po_number).filter(Boolean) as string[]);
}

export interface WriteAtRiskResult {
    inserted: number;
    updated: number;
    failed: number;
}

/**
 * Upsert one ap_activity_log row per AtRiskPO, deduped to one row per (poId,
 * UTC day). On the second/third tick of the same day the metadata is
 * refreshed in place instead of producing a new row — keeps the feed clean.
 *
 * Returns counts so the cron can log a one-line summary.
 */
export async function writeAtRiskActivityRows(risks: AtRiskPO[]): Promise<WriteAtRiskResult> {
    const sb = createClient();
    if (!sb || risks.length === 0) {
        return { inserted: 0, updated: 0, failed: 0 };
    }

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartIso = todayStart.toISOString();

    let inserted = 0;
    let updated = 0;
    let failed = 0;

    // First: collect any rows currently snoozed (snoozed_until > now) so the
    // writer skips them entirely. Snooze lives in metadata.snoozed_until and
    // is set by /api/dashboard/po-risk/snooze.
    const nowIso = new Date().toISOString();
    const snoozedPoIds = new Set<string>();
    try {
        const { data: snoozedRows } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", ACTIVITY_INTENT_PO_AT_RISK)
            .filter("metadata->>snoozed_until", "gt", nowIso)
            .limit(500);
        for (const r of (snoozedRows ?? []) as Array<{ metadata: any }>) {
            const id = r.metadata?.poId;
            if (id) snoozedPoIds.add(String(id));
        }
    } catch {
        // best-effort — better to over-surface than to miss real risks
    }

    for (const risk of risks) {
        if (snoozedPoIds.has(risk.poId)) continue;
        try {
            // Look for an existing row from today for this PO.
            const { data: existing } = await sb
                .from("ap_activity_log")
                .select("id")
                .eq("intent", ACTIVITY_INTENT_PO_AT_RISK)
                .filter("metadata->>poId", "eq", risk.poId)
                .gte("created_at", todayStartIso)
                .limit(1);

            const subject = `PO #${risk.poId} — ${commStateLabel(risk.commState)}`;
            const tierTag = risk.severity === "at_risk"
                ? `${risk.worstDaysShort}d short on arrival`
                : `margin tight (${Math.abs(risk.worstDaysShort)}d buffer)`;
            const action = `${tierTag}. ${summarizeAtRiskItems(risk.atRiskItems)}`;
            const metadata = {
                poId: risk.poId,
                vendorName: risk.vendorName,
                vendorPartyId: risk.vendorPartyId,
                severity: risk.severity,
                orderDate: risk.orderDate,
                expectedArrival: risk.expectedArrival,
                leadProvenance: risk.leadProvenance,
                commState: risk.commState,
                facts: risk.facts,
                atRiskItems: risk.atRiskItems,
                worstDaysShort: risk.worstDaysShort,
                detectorVersion: 2,
            };

            if (existing && existing.length > 0) {
                const { error } = await sb
                    .from("ap_activity_log")
                    .update({
                        action_taken: action,
                        email_subject: subject,
                        metadata,
                    })
                    .eq("id", existing[0].id);
                if (error) {
                    console.warn(`[po-arrival-risk] update ${risk.poId} failed: ${error.message}`);
                    failed++;
                } else {
                    updated++;
                }
            } else {
                const { error } = await sb
                    .from("ap_activity_log")
                    .insert({
                        email_from: risk.vendorName,
                        email_subject: subject,
                        intent: ACTIVITY_INTENT_PO_AT_RISK,
                        action_taken: action,
                        notified_slack: false,
                        metadata,
                    });
                if (error) {
                    console.warn(`[po-arrival-risk] insert ${risk.poId} failed: ${error.message}`);
                    failed++;
                } else {
                    inserted++;
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[po-arrival-risk] write ${risk.poId} threw: ${msg}`);
            failed++;
        }
    }

    return { inserted, updated, failed };
}
