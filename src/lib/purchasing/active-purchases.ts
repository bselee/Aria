/**
 * @file    active-purchases.ts
 * @purpose Build Active Purchases panel rows from Finale (source of truth).
 *          Local PostgREST enrichment is progressive / fail-open.
 * @author  BuildASoil
 * @updated 2026-08-11 — removed phantom columns tracking_paused/tracking_source
 *           from purchase_orders select; split enrichment into independent
 *           try/catch blocks so one failure can't kill all enrichment
 * @deps    finale, db, lead-time, shipment-intelligence, po-completion
 */

import { leadTimeService } from "../builds/lead-time-service";
import type { FinaleClient, FullPO } from "../finale/client";
import { createClient, probePostgrest } from "../db";
import { loadPOCompletionSignalIndex } from "./po-completion-loader";
import { derivePOCompletionState, type POCompletionState } from "./po-completion-state";
import { derivePurchaseMovement, type PurchaseMovement } from "./active-purchases-movement";
import { classifyShipmentEvidence, listShipmentsForPurchaseOrders, type ShipmentRecord } from "../tracking/shipment-intelligence";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate, isHighConfidenceReceived } from "./po-receipt-state";
import { derivePOSentVerification, type POSentVerification } from "./po-sent-verification";
import { deriveVendorEtaProfile, type VendorEtaProfile } from "./vendor-eta-profile";
import { normalizeLifecycleStage } from "./po-lifecycle";

export interface ActivePurchase extends FullPO {
    expectedDate: string;
    leadProvenance: string;
    trackingNumbers: string[];
    shipments: Array<ShipmentRecord & { evidenceLevel: "confirmed" | "candidate"; evidenceReason: string }>;
    isReceived: boolean;
    completionState: POCompletionState;
    lifecycleStage?: string;
    lifecycleSummary?: string;
    lastMovementSummary?: string | null;
    trackingUnavailableAt?: string | null;
    trackingRequestedAt?: string | null;
    vendorAcknowledgedAt?: string | null;
    humanReplyDetectedAt?: string | null;
    sentVerification: POSentVerification;
    etaProfile: VendorEtaProfile;
    trackingPaused?: boolean;
    trackingSource?: string | null;
    typicalTrackingSource?: string | null;
    vendorOrdersEmail?: string | null;
    vendorIntel?: { total_spend?: number; pending_reconciliation?: number; avg_freight?: number } | null;
    invoiceStatus?: string;
    invoiceId?: string;
    hasDiscrepancies?: boolean;
    movement: PurchaseMovement;
}

function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split("T")[0];
}

function normalizePlannedReceiveDate(
    receiveDate: string | null | undefined,
    orderDate: string | null | undefined,
    today: string,
): string | null {
    if (!receiveDate) return null;
    const rd = /^(\d{4}-\d{2}-\d{2})/.exec(receiveDate)?.[1] || null;
    if (!rd) return null;
    if (rd <= today) return null;
    if (orderDate) {
        const ord = /^(\d{4}-\d{2}-\d{2})/.exec(orderDate)?.[1];
        if (ord) {
            const days = (Date.parse(rd) - Date.parse(ord)) / 86_400_000;
            if (days > 75) return null;
        }
    }
    return rd;
}

export async function loadActivePurchases(
    finale: FinaleClient,
    daysBack = 60,
    preloadedPos?: FullPO[]
): Promise<ActivePurchase[]> {
    const pos = preloadedPos ?? await finale.getRecentPurchaseOrders(daysBack);
    await leadTimeService.warmCache().catch((e: any) =>
        console.warn("[active-purchases] leadTime warm failed:", e?.message || e)
    );

    const uniqueVendors = [...new Set(pos.map(p => p.vendorName).filter(Boolean))];
    await Promise.all(uniqueVendors.map(v => leadTimeService.getForVendor(v))).catch(() => undefined);

    const dbHealthy = await probePostgrest(2000);
    const db = dbHealthy ? createClient() : null;
    if (!dbHealthy) {
        console.warn("[active-purchases] PostgREST unhealthy — Finale-only mode");
    }

    const vendorMap = new Map<string, { typical_tracking_source?: string; orders_email?: string; vendor_emails?: string[] }>();
    const vendorIntelMap = new Map<string, { total_spend?: number; pending_reconciliation?: number; avg_freight?: number }>();
    const trackingMap = new Map<string, string[]>();
    const shipmentMap = new Map<string, ShipmentRecord[]>();
    const lifecycleMap = new Map<string, Record<string, any>>();
    const poSendMap = new Map<string, Array<Record<string, any>>>();
    const invoiceMap = new Map<string, { status: string; id: string; hasDiscrepancies: boolean; total?: number }>();
    const finaleReceiptActivity = new Set<string>();
    let completionSignals: Awaited<ReturnType<typeof loadPOCompletionSignalIndex>> = new Map();

    const poNumbers = pos.map(p => p.orderId).filter(Boolean);

    if (db && poNumbers.length > 0) {
        // Phase 1: vendor profiles + vendor intel (independent failures isolated)
        if (uniqueVendors.length > 0) {
            try {
                const { data: vData } = await db
                    .from("vendor_profiles")
                    .select("vendor_name, typical_tracking_source, orders_email, vendor_emails, communication_pattern, is_noncomm")
                    .in("vendor_name", uniqueVendors);
                for (const v of vData || []) {
                    vendorMap.set(v.vendor_name.toLowerCase(), v);
                }
            } catch (e) {
                console.warn("Failed to load vendor profiles in loadActivePurchases:", e);
            }
            try {
                const { data: vipData } = await db
                    .from("vendor_invoices")
                    .select("vendor_name, total, freight, status")
                    .in("vendor_name", uniqueVendors)
                    .order("created_at", { ascending: false })
                    .limit(500);
                const byVendor = new Map<string, { total_spend: number; avg_freight: number; pending: number; count: number }>();
                for (const v of vipData || []) {
                    const key = v.vendor_name?.toLowerCase();
                    if (!key) continue;
                    const entry = byVendor.get(key) || { total_spend: 0, avg_freight: 0, pending: 0, count: 0 };
                    entry.total_spend += Number(v.total) || 0;
                    entry.avg_freight += Number(v.freight) || 0;
                    entry.count++;
                    if (v.status === "received") entry.pending++;
                    byVendor.set(key, entry);
                }
                for (const [k, v] of byVendor) {
                    vendorIntelMap.set(k, {
                        total_spend: v.total_spend,
                        pending_reconciliation: v.pending,
                        avg_freight: v.count > 0 ? v.avg_freight / v.count : 0,
                    });
                }
            } catch (e) {
                console.warn("Failed to load invoice patterns:", e);
            }
        }

        // Phase 2a: purchase_orders → lifecycleMap + trackingMap (independent)
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: poData } = await db
                    .from("purchase_orders")
                    .select(
                        "po_number, tracking_numbers, lifecycle_stage, last_movement_summary, " +
                        "tracking_unavailable_at, tracking_requested_at, vendor_acknowledged_at, vendor_ack_source, " +
                        "human_reply_detected_at, po_sent_at, po_sent_verified_at, po_sent_verified_source, " +
                        "po_sent_verified_evidence, last_eta_update, vendor_stated_eta, vendor_stated_eta_confidence, " +
                        "status, receive_date"
                    )
                    .in("po_number", chunk);
                for (const dp of poData || []) {
                    trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                    lifecycleMap.set(dp.po_number, dp);
                }
            }
        } catch (e: any) {
            console.warn("[active-purchases] purchase_orders fetch failed (lifecycle/tracking will be empty):", e.message);
        }

        // Phase 2b: po_sends → poSendMap (independent)
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: sendData } = await db
                    .from("po_sends")
                    .select("po_number, sent_at, committed_at, sent_to_email, triggered_by, gmail_message_id")
                    .in("po_number", chunk);
                for (const row of sendData || []) {
                    if (!poSendMap.has(row.po_number)) poSendMap.set(row.po_number, []);
                    poSendMap.get(row.po_number)!.push(row);
                }
            }
        } catch (e: any) {
            console.warn("[active-purchases] po_sends fetch failed (sent verification will be degraded):", e.message);
        }

        // Phase 2c: shipments → shipmentMap (independent)
        try {
            const shipments = await listShipmentsForPurchaseOrders(poNumbers);
            for (const shipment of shipments) {
                for (const poNumber of shipment.po_numbers || []) {
                    if (!shipmentMap.has(poNumber)) shipmentMap.set(poNumber, []);
                    shipmentMap.get(poNumber)!.push(shipment);
                }
            }
        } catch (e: any) {
            console.warn("[active-purchases] shipment fetch failed (tracking movement will be empty):", e.message);
        }

        // Phase 3: invoices (own try/catch)
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: invData } = await db
                    .from("invoices")
                    .select("po_number, status, id, discrepancies, total")
                    .in("po_number", chunk);
                for (const inv of invData || []) {
                    invoiceMap.set(inv.po_number, {
                        status: inv.status,
                        id: inv.id,
                        hasDiscrepancies: Array.isArray(inv.discrepancies) && inv.discrepancies.length > 0,
                        total: typeof inv.total === "number" ? inv.total : undefined,
                    });
                }
            }

            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: viData } = await db
                    .from("vendor_invoices")
                    .select("po_number, status, id, total")
                    .in("po_number", chunk)
                    .order("created_at", { ascending: false });
                for (const inv of viData || []) {
                    if (!inv.po_number) continue;
                    const existing = invoiceMap.get(inv.po_number);
                    if (!existing || existing.total == null) {
                        invoiceMap.set(inv.po_number, {
                            status: inv.status || existing?.status || "matched",
                            id: inv.id || existing?.id || "",
                            hasDiscrepancies: existing?.hasDiscrepancies || false,
                            total: typeof inv.total === "number" ? inv.total : existing?.total,
                        });
                    }
                }
            }

            try {
                const since = new Date(Date.now() - 120 * 86400 * 1000).toISOString();
                const { data: rcvActs } = await db
                    .from("ap_activity_log")
                    .select("metadata")
                    .eq("intent", "PO_RECEIVED")
                    .gte("created_at", since)
                    .limit(500);
                for (const row of rcvActs || []) {
                    const md = row.metadata || {};
                    const pid = String(md.poId || "");
                    if (md.atRiskItems) continue;
                    if (pid && poNumbers.includes(pid)) finaleReceiptActivity.add(pid);
                }
            } catch (actErr: any) {
                console.warn("[active-purchases] PO_RECEIVED activity lookup failed:", actErr?.message || actErr);
            }

            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: paData } = await db
                    .from("ap_pending_approvals")
                    .select("order_id")
                    .eq("status", "pending")
                    .in("order_id", chunk);
                for (const pa of paData || []) {
                    if (pa.order_id && !invoiceMap.has(pa.order_id)) {
                        invoiceMap.set(pa.order_id, {
                            status: "matched_review",
                            id: "",
                            hasDiscrepancies: false,
                        });
                    } else if (pa.order_id && invoiceMap.has(pa.order_id)) {
                        const existing = invoiceMap.get(pa.order_id)!;
                        invoiceMap.set(pa.order_id, {
                            ...existing,
                            status: "matched_review",
                        });
                    }
                }
            }
        } catch (e: any) {
            console.warn("[purchasing] invoice fetch failed:", e.message);
        }

        // Phase 4: completion signals (own try/catch)
        try {
            completionSignals = await loadPOCompletionSignalIndex(db, poNumbers);
        } catch (e: any) {
            console.warn("[purchasing] completion signal load failed:", e.message);
        }

        // Phase 5: self-heal lifecycle mismatches
        try {
            const healMismatches: Array<{ po_number: string; last_movement_summary: string; updated_at: string }> = [];
            for (const po of pos) {
                if (!po.orderId) continue;
                const lifecycle = lifecycleMap.get(po.orderId);
                const localReceiveDate = lifecycle?.receive_date || null;
                const localStatus = lifecycle?.status || null;
                const isRcvd =
                    hasPurchaseOrderReceipt({
                        status: po.status,
                        receiveDate: po.receiveDate || localReceiveDate,
                        shipments: po.shipments,
                    }) ||
                    hasPurchaseOrderReceipt({
                        status: localStatus,
                        receiveDate: localReceiveDate,
                        shipments: null,
                    }) ||
                    normalizeLifecycleStage(lifecycle?.lifecycle_stage ?? null) === "RECEIVED" ||
                    normalizeLifecycleStage(lifecycle?.lifecycle_stage ?? null) === "COMPLETED";
                if (!isRcvd) continue;
                if (!lifecycle) continue;
                const stage = normalizeLifecycleStage(lifecycle.lifecycle_stage ?? null);
                if (stage && stage !== "RECEIVED" && stage !== "COMPLETED" && stage !== "CANCELLED") {
                    healMismatches.push({
                        po_number: po.orderId,
                        last_movement_summary: `Auto-healed ${new Date().toISOString().slice(0, 10)}: receipt evidence present but lifecycle was stuck at "${lifecycle.lifecycle_stage}"`,
                        updated_at: new Date().toISOString(),
                    });
                    lifecycleMap.set(po.orderId, { ...lifecycle, lifecycle_stage: "RECEIVED" });
                }
            }
            if (healMismatches.length > 0) {
                try {
                    for (let i = 0; i < healMismatches.length; i += 100) {
                        const chunk = healMismatches.slice(i, i + 100);
                        await db.from("purchase_orders").upsert(chunk, { onConflict: "po_number" });
                    }
                    console.log(`[active-purchases] Self-healed ${healMismatches.length} PO lifecycle_stage mismatches`);
                } catch (e: any) {
                    console.warn("[active-purchases] Self-heal upsert failed:", e.message);
                }
                try {
                    const { transitionLifecycleState } = await import("./po-lifecycle");
                    for (const match of healMismatches) {
                        transitionLifecycleState(match.po_number, "RECEIVED", "active-purchases-selfheal", {
                            detail: "received",
                            autoHealed: true,
                            summary: match.last_movement_summary,
                        }).catch(() => {});
                    }
                } catch (tlErr: any) {
                    console.warn("[active-purchases] Self-heal lifecycle transitions failed:", tlErr.message);
                }
            }
        } catch (e: any) {
            console.warn("[purchasing] self-heal phase failed:", e.message);
        }
    }

    const activePos: ActivePurchase[] = [];

    for (const po of pos) {
        if (!po.orderId) continue;
        if (po.orderId.toLowerCase().includes("dropship")) continue;

        const status = (po.status || "").toLowerCase();
        if (!["committed", "completed"].includes(status)) continue;

        const shipments = (shipmentMap.get(po.orderId) || []).map((shipment) => {
            const classification = classifyShipmentEvidence(shipment);
            return {
                ...shipment,
                evidenceLevel: classification.level,
                evidenceReason: classification.reason,
            };
        });
        const confirmedShipments = shipments.filter((shipment) => shipment.evidenceLevel === "confirmed");
        const poLifecycleRow = lifecycleMap.get(po.orderId);
        const invoiceInfo = invoiceMap.get(po.orderId);

        const finaleShips = (po.shipments || []).map((s) => ({
            status: s.status,
            receiveDate: s.receiveDate,
        }));
        const cacheStage = (po as any).lifecycleStage as string | null | undefined;

        let expectedDate: string;
        let leadProvenance: string;
        let lt: Awaited<ReturnType<typeof leadTimeService.getForVendor>> | null = null;
        const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const plannedReceive =
            normalizePlannedReceiveDate(po.receiveDate || poLifecycleRow?.receive_date, po.orderDate, todayStr);

        if (plannedReceive) {
            expectedDate = plannedReceive;
            leadProvenance = "Finale planned receive";
            if (po.orderDate) {
                lt = await leadTimeService.getForVendor(po.vendorName).catch(() => null);
            }
        } else if (po.orderDate) {
            lt = await leadTimeService.getForVendor(po.vendorName);
            expectedDate = addDays(po.orderDate, lt.days);
            leadProvenance = lt.label;
        } else {
            expectedDate = todayStr;
            leadProvenance = "21d default";
        }

        const resolvedReceiveDate = resolvePurchaseOrderReceiptDate({
            status: po.status,
            receiveDate: po.receiveDate || poLifecycleRow?.receive_date || null,
            shipments: finaleShips.length ? finaleShips : (po.shipments || []),
            orderDate: po.orderDate,
        }) || resolvePurchaseOrderReceiptDate({
            status: poLifecycleRow?.status || null,
            receiveDate: poLifecycleRow?.receive_date || null,
            shipments: null,
            orderDate: po.orderDate,
        });

        const localStage = normalizeLifecycleStage(
            poLifecycleRow?.lifecycle_stage ?? cacheStage ?? null,
        );

        const isReceived = isHighConfidenceReceived({
            status: po.status,
            receiveDate: po.receiveDate || poLifecycleRow?.receive_date || null,
            shipments: finaleShips.length ? finaleShips : (po.shipments || []),
            orderDate: po.orderDate,
            lifecycleStage: localStage || poLifecycleRow?.lifecycle_stage || cacheStage,
            matchedInvoiceTotal: invoiceInfo?.total ?? null,
            matchedInvoiceStatus: invoiceInfo?.status ?? null,
            poTotal: typeof po.total === "number" ? po.total : null,
            expectedDate,
            finaleReceiptActivity: finaleReceiptActivity.has(po.orderId),
        });

        const completionSignal = completionSignals.get(po.orderId);
        const completionState = derivePOCompletionState({
            finaleReceived: isReceived,
            trackingDelivered: confirmedShipments.length > 0 && confirmedShipments.every((shipment) => shipment.status_category === "delivered"),
            hasMatchedInvoice: completionSignal?.hasMatchedInvoice || !!invoiceInfo,
            reconciliationVerdict: completionSignal?.reconciliationVerdict || null,
            freightResolved: completionSignal?.freightResolved || false,
            unresolvedBlockers: completionSignal?.unresolvedBlockers || [],
        });

        if (completionState === "complete" && isReceived) {
            continue;
        }

        if (isReceived && completionState !== "exception") {
            continue;
        }

        const poLifecycle = poLifecycleRow;
        const vendorPromisedEta =
            plannedReceive ||
            ((poLifecycle?.vendor_stated_eta &&
                (poLifecycle?.vendor_stated_eta_confidence === "high" ||
                 poLifecycle?.vendor_stated_eta_confidence === "medium")
                    ? poLifecycle.vendor_stated_eta
                    : null) ??
            poLifecycle?.last_eta_update?.estimated_delivery_at ??
            poLifecycle?.last_eta_update?.eta ??
            poLifecycle?.last_eta_update?.date ??
            null);
        const etaProfile = deriveVendorEtaProfile({
            vendorName: po.vendorName,
            orderDate: po.orderDate || new Date().toISOString().slice(0, 10),
            fallbackLeadDays: lt?.days ?? 21,
            fallbackLabel: lt?.label ?? "21d default",
            fallbackSource: lt?.provenance ?? "default",
            vendorPromisedEta,
            shipments: confirmedShipments.map((shipment) => ({
                estimated_delivery_at: shipment.estimated_delivery_at,
                delivered_at: shipment.delivered_at,
                created_at: shipment.created_at,
            })),
        });
        const sentVerification = derivePOSentVerification({
            poNumber: po.orderId,
            purchaseOrder: poLifecycle,
            sendRows: poSendMap.get(po.orderId) || [],
            hasTracking: (trackingMap.get(po.orderId)?.length || 0) > 0 || shipments.length > 0,
        });

        const vendorProfile = vendorMap.get(po.vendorName?.toLowerCase());

        const movement = derivePurchaseMovement({
            shipments: shipments.map((shipment) => ({
                tracking_number: shipment.tracking_number,
                public_tracking_url: shipment.public_tracking_url,
                carrier_name: shipment.carrier_name,
                status_category: shipment.status_category,
                estimated_delivery_at: shipment.estimated_delivery_at,
                delivered_at: shipment.delivered_at,
                last_checked_at: shipment.last_checked_at,
                last_source: shipment.last_source,
                source_refs: shipment.source_refs,
                evidenceLevel: shipment.evidenceLevel,
            })),
            legacyTrackingNumbers: trackingMap.get(po.orderId) || [],
            invoiceStatus: invoiceInfo?.status,
            invoiceId: invoiceInfo?.id,
            hasDiscrepancies: invoiceInfo?.hasDiscrepancies,
            isReceived,
        });

        activePos.push({
            ...po,
            receiveDate: resolvedReceiveDate,
            expectedDate: etaProfile.expectedDate || expectedDate,
            leadProvenance: etaProfile.label || leadProvenance,
            isReceived,
            completionState,
            trackingNumbers: trackingMap.get(po.orderId) || [],
            shipments,
            lifecycleStage: poLifecycle?.lifecycle_stage || undefined,
            lastMovementSummary: poLifecycle?.last_movement_summary || null,
            trackingUnavailableAt: poLifecycle?.tracking_unavailable_at || null,
            trackingRequestedAt: poLifecycle?.tracking_requested_at || null,
            vendorAcknowledgedAt: poLifecycle?.vendor_acknowledged_at || null,
            humanReplyDetectedAt: poLifecycle?.human_reply_detected_at || null,
            sentVerification,
            etaProfile,
            // trackingPaused/trackingSource hard-defaulted — columns do not exist in purchase_orders (2026-08-11)
            trackingPaused: false,
            trackingSource: null,
            typicalTrackingSource: vendorProfile?.typical_tracking_source || null,
            vendorOrdersEmail: vendorProfile?.orders_email || vendorProfile?.vendor_emails?.[0] || null,
            vendorIntel: vendorIntelMap.get(po.vendorName?.toLowerCase()) || null,
            invoiceStatus: invoiceInfo?.status || undefined,
            invoiceId: invoiceInfo?.id || undefined,
            hasDiscrepancies: invoiceInfo?.hasDiscrepancies || false,
            movement,
        });
    }

    activePos.sort((a, b) => {
        const da = new Date(a.orderDate || 0).getTime();
        const dbSort = new Date(b.orderDate || 0).getTime();
        return dbSort - da;
    });

    return activePos;
}
