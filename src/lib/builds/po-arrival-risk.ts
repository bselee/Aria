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
    | "acknowledged_no_tracking"   // vendor ack'd but nothing about shipping
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

export interface AtRiskPO {
    poId: string;
    vendorName: string;
    vendorPartyId: string | null;
    orderDate: string | null;
    expectedArrival: string;       // ISO date
    leadProvenance: string;        // e.g. "14d (Finale)"
    commState: VendorCommState;
    /** What we know about vendor responsiveness — drives draft tone. */
    facts: {
        poSentAt: string | null;
        vendorAcknowledgedAt: string | null;
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

/**
 * Classify the vendor's current communication state on a PO. Precedence:
 * ETA passed → tracking no movement → ETA stated → ack only → silent.
 */
export function classifyVendorCommState(
    po: Pick<ActivePurchase, "vendorAcknowledgedAt" | "trackingNumbers" | "shipments" | "etaProfile" | "isReceived">,
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
    if (hasAck && !hasTracking) return "acknowledged_no_tracking";
    return "none";
}

// ── detector ───────────────────────────────────────────────────────────────

export interface DetectAtRiskPOsInput {
    activePOs: ActivePurchase[];
    purchasingItems: PurchasingItem[];
    today?: string;
    /** Only flag SKUs that are at least N days short. Default 3 — cuts noise. */
    minDaysShort?: number;
}

export function detectAtRiskPOs(input: DetectAtRiskPOsInput): AtRiskPO[] {
    const today = input.today ?? todayIso();
    const minDaysShort = input.minDaysShort ?? 3;

    // Index per-SKU intelligence for O(1) lookup.
    const skuIntel = new Map<string, PurchasingItem>();
    for (const item of input.purchasingItems) {
        if (item.productId) skuIntel.set(item.productId, item);
    }

    const out: AtRiskPO[] = [];

    for (const po of input.activePOs) {
        if (!po.orderId || po.isReceived) continue;
        if (!po.expectedDate) continue;

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

        out.push({
            poId: po.orderId,
            vendorName: po.vendorName ?? "Unknown Vendor",
            vendorPartyId: (po as any).vendorPartyId ?? null,
            orderDate: po.orderDate ?? null,
            expectedArrival: po.expectedDate,
            leadProvenance: po.leadProvenance ?? "unknown",
            commState: classifyVendorCommState(po, today),
            facts: {
                poSentAt: (po as any).sentVerification?.sentAt ?? po.orderDate ?? null,
                vendorAcknowledgedAt: po.vendorAcknowledgedAt ?? null,
                vendorStatedEta: (po.etaProfile as any)?.vendorPromisedEta ?? null,
                trackingNumbers: po.trackingNumbers ?? [],
                lastMovementSummary: po.lastMovementSummary ?? null,
                lifecycleStage: po.lifecycleStage ?? null,
            },
            atRiskItems,
            worstDaysShort: atRiskItems.reduce((m, i) => Math.max(m, i.daysShort), 0),
        });
    }

    // Worst-first so the dashboard / cron sees most urgent up top.
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

    for (const risk of risks) {
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
            const action = `${risk.worstDaysShort}d short on arrival. ${summarizeAtRiskItems(risk.atRiskItems)}`;
            const metadata = {
                poId: risk.poId,
                vendorName: risk.vendorName,
                vendorPartyId: risk.vendorPartyId,
                orderDate: risk.orderDate,
                expectedArrival: risk.expectedArrival,
                leadProvenance: risk.leadProvenance,
                commState: risk.commState,
                facts: risk.facts,
                atRiskItems: risk.atRiskItems,
                worstDaysShort: risk.worstDaysShort,
                detectorVersion: 1,
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
