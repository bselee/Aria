/**
 * @file    po-service.ts
 * @purpose Purchase Order service — PO sweep, receivings, calendar sync,
 *          reconciliation, build completions, quantity calibration, and
 *          Gmail conversation sync.
 * @created 2026-05-29
 * @author  Bill Selee
 * @extracted-from ops-manager.ts (Phase 2/3 OpsManager split)
 * @deps    finale/client, supabase, google/calendar, carriers/tracking-service,
 *          purchasing/calendar-lifecycle, purchasing/derive-po-lifecycle,
 *          purchasing/po-completion-state, purchasing/po-receipt-state,
 *          tracking/shipment-intelligence, builds/lead-time-service
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";
import { getLocalDb, dedupSeen, dedupMark } from "../../storage/local-db";
import { Telegraf } from "telegraf";
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../../google/calendar";
import { BuildParser } from "../build-parser";
import { FinaleClient, finaleClient } from "../../finale/client";
import {
    TRACKING_PATTERNS,
    carrierUrl,
    detectLTLCarrier,
    type TrackingStatus,
} from "../../carriers/tracking-service";
import {
    derivePurchasingLifecycle,
    getPurchasingEventDate,
} from "../../purchasing/calendar-lifecycle";
import { derivePOCompletionState } from "../../purchasing/po-completion-state";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "../../purchasing/po-receipt-state";
import { runPOSweep as runPOSweepModule } from "../../matching/po-sweep";
import { leadTimeService } from "../../builds/lead-time-service";
import { exec } from "child_process";
import { promisify } from "util";
import { businessHoursAlert } from "../alert-gate";

const execAsync = promisify(exec);
const RECONCILE_TIMEOUT_MS = 5 * 60 * 1000;
const RECONCILE_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Helper to decode Gmail message body (Base64URL).
 * @param data - Base64URL-encoded string
 * @returns Decoded UTF-8 string
 */
function _decodeGmailBody(data: string): string {
    return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Helper to recursively walk multipart Gmail messages.
 * @param parts - Array of MIME parts
 * @param bodyParts - Accumulator for decoded body text
 */
function _walkMsgParts(parts: any[], bodyParts: string[]) {
    for (const part of parts) {
        if (part.body?.data) {
            bodyParts.push(_decodeGmailBody(part.body.data));
        }
        if (part.parts) {
            _walkMsgParts(part.parts, bodyParts);
        }
    }
}

export class POService {
    constructor(private bot: Telegraf) {}

    /**
     * Helper to add N days to a date string.
     * @param date - ISO date string (YYYY-MM-DD)
     * @param days - Number of days to add
     * @returns New ISO date string
     */
    private addDays(date: string, days: number): string {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d.toISOString().split("T")[0];
    }

    /**
     * Builds a descriptive title for the calendar event.
     * @param po - Purchase order object
     * @param lifecycle - Purchasing lifecycle state
     * @returns Formatted event title string
     */
    private buildPOEventTitle(po: any, lifecycle: any): string {
        const vendor = po.vendorName || "Unknown Vendor";
        const poNum = po.orderId || "???";
        return `${lifecycle.prefixText} PO #${poNum} - ${vendor}`;
    }

    /**
     * Builds a rich description for the Google Calendar event.
     * @param po - Purchase order object
     * @param expectedDate - Expected delivery date (ISO)
     * @param leadProvenance - Source of lead time estimate
     * @param trackingNumbers - Array of tracking number strings
     * @param trackingStatuses - Map of tracking number to status
     * @param lifecycle - Purchasing lifecycle object
     * @param latestETA - Latest ETA from tracking (ISO string or undefined)
     * @param highConfTracking - High-confidence tracking data array
     * @param poLifecycleData - Additional lifecycle metadata
     * @returns HTML-formatted event description string
     */
    private async buildPOEventDescription(
        po: any,
        expectedDate: string,
        leadProvenance: string,
        trackingNumbers: string[],
        trackingStatuses: Map<string, TrackingStatus | null>,
        lifecycle: any,
        latestETA: string | undefined,
        highConfTracking: any[] | undefined,
        poLifecycleData: any,
    ): Promise<string> {
        const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";
        const rawOrderUrl = po.orderUrl || `/${accountPath}/api/order/${po.orderId}`;
        const encodedUrl = Buffer.from(rawOrderUrl).toString("base64");
        const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encodedUrl}`;

        let desc = `<b><a href="${finaleUrl}">PO #${po.orderId}</a></b>\n`;
        desc += `Vendor: ${po.vendorName}\n`;

        if (po.items && po.items.length > 0) {
            desc += `\n<b>Items:</b>\n`;
            for (const item of po.items) {
                desc += `- ${item.productId}: ${item.quantity}\n`;
            }
        }

        desc += `\nStatus: ${po.status}\n`;
        desc += `\n<b>Timeline:</b>\n`;
        desc += `Order Date: ${po.orderDate}\n`;
        desc += `Expected: ${expectedDate} (${leadProvenance})\n`;
        if (latestETA) desc += `Live ETA: ${new Date(latestETA).toLocaleDateString()}\n`;
        if (po.receiveDate) desc += `Actual Receipt: ${po.receiveDate}\n`;
        desc += `\n<b>Lifecycle:</b> ${lifecycle.calendarStatus.toUpperCase()}\n`;
        if (poLifecycleData?.lifecycle_stage) desc += `Stage: ${poLifecycleData.lifecycle_stage}\n`;

        if (trackingNumbers.length > 0) {
            desc += `\n<b>Tracking:</b>\n`;
            for (const t of trackingNumbers) {
                const ts = trackingStatuses.get(t);
                const status = ts?.display || "Pending";
                const link = ts?.public_url || carrierUrl(t);
                desc += `- <a href="${link}">${t}</a>: ${status}\n`;
            }
        }

        if (po.notes) desc += `\n<b>Internal Notes:</b>\n${po.notes}\n`;

        return desc;
    }

    /**
     * Watcher: identify Finale POs that satisfy all auto-complete gates AND
     * have been settled for >=48h, then mark them ORDER_COMPLETED. Default OFF
     * via PO_AUTO_COMPLETE_ENABLED env — runs in dry-run mode otherwise.
     * Activity row written only on actual completion (no chatter on skips).
     */
    public async runPOAutoCompleteWatcher(): Promise<void> {
        const { runPOAutoCompleteWatcher } = await import("../../purchasing/po-auto-complete");
        const stats = await runPOAutoCompleteWatcher();
        if (stats.scanned > 0) {
            console.log(
                `[po-auto-complete] scanned=${stats.scanned} eligible=${stats.eligible} ` +
                `completed=${stats.completed} skipped=${stats.skipped} errors=${stats.errors} ` +
                `dryRun=${stats.dryRun}`,
            );
        }
    }

    /**
     * Detect open POs at risk of arriving after their line-item SKUs run out,
     * and surface each as a PO_ARRIVAL_AT_RISK row in ap_activity_log. Builds
     * panel + Activity feed render these for review and next-step actions.
     * Activity-first routing: no Slack/Gmail push from this method.
     */
    public async runPOArrivalRiskCheck(): Promise<void> {
        const [{ detectAtRiskPOs, writeAtRiskActivityRows, loadInvoiceMatchedPOs }, { loadActivePurchases }, { finaleClient }] = await Promise.all([
            import("../../builds/po-arrival-risk"),
            import("../../purchasing/active-purchases"),
            import("../../finale/client"),
        ]);
        const [activePOs, intel] = await Promise.all([
            loadActivePurchases(finaleClient),
            finaleClient.getPurchasingIntelligence(),
        ]);
        const items = intel.flatMap((g) => g.items);
        const poNumbers = activePOs.map((p) => p.orderId).filter(Boolean) as string[];
        const poNumbersWithInvoice = await loadInvoiceMatchedPOs(poNumbers);
        const risks = detectAtRiskPOs({
            activePOs,
            purchasingItems: items,
            poNumbersWithInvoice,
        });
        if (risks.length === 0) {
            console.log("[POService] POArrivalRiskCheck: no at-risk POs");
            return;
        }
        const result = await writeAtRiskActivityRows(risks);
        console.log(
            `[POService] POArrivalRiskCheck: ${risks.length} at-risk POs ` +
            `(inserted=${result.inserted} updated=${result.updated} failed=${result.failed})`,
        );
    }

    /** PO-First AP Sweep wrapper. */
    public async runPOSweep(): Promise<void> {
        await runPOSweepModule(60, false);
    }

    /** Vendor reconciliation wrappers. */
    public async runReconcileAxiom(): Promise<void> {
        await this.runReconciliation("Axiom", "node --import tsx src/cli/reconcile-axiom.ts");
    }
    public async runReconcileFedEx(): Promise<void> {
        await this.runReconciliation("FedEx", "node --import tsx src/cli/reconcile-fedex.ts");
    }
    public async runReconcileTeraGanix(): Promise<void> {
        await this.runReconciliation("TeraGanix", "node --import tsx src/cli/reconcile-teraganix.ts");
    }
    public async runReconcileULINE(): Promise<void> {
        await this.runReconciliation("ULINE", "node --import tsx src/cli/reconcile-uline.ts");
    }

    /**
     * Run a child process reconciliation script.
     * @param vendorName - Vendor identifier (e.g., "ULINE", "FedEx")
     * @param command - Shell command to execute
     */
    public async runReconciliation(vendorName: string, command: string) {
        console.log(`\u{1F504} Starting ${vendorName} reconciliation...`);
        try {
            const { stdout, stderr } = await execAsync(command, { timeout: RECONCILE_TIMEOUT_MS, maxBuffer: RECONCILE_MAX_BUFFER });
            if (stderr) console.warn(`[Reconcile ${vendorName}] Stderr:`, stderr);
            console.log(`${vendorName} reconciliation complete.`);
        } catch (err: any) {
            console.error(`${vendorName} reconciliation failed:`, err.message);
        }
    }

    /** Purchasing calendar sync wrapper (60-day window). */
    public async runPurchasingCalendarSync(): Promise<void> {
        await this.syncPurchasingCalendar(60);
    }

    /**
     * Watchdog: alert if any vendor hasn\'t had a successful reconciliation run in 24h.
     */
    async checkMissingReconciliationRuns(): Promise<void> {
        const VENDORS = ["ULINE", "FedEx", "TeraGanix", "Axiom", "AAA"];
        const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const sb = createClient();
        if (!sb) return;

        for (const vendor of VENDORS) {
            const { data } = await sb
                .from("reconciliation_runs")
                .select("id, status, started_at")
                .eq("vendor", vendor)
                .gte("started_at", ONE_DAY_AGO)
                .in("status", ["success", "partial"])
                .order("started_at", { ascending: false })
                .limit(1);

            if (!data || data.length === 0) {
                await businessHoursAlert(this.bot, 
                    process.env.TELEGRAM_CHAT_ID || "",
                    `No successful ${vendor} reconciliation run in the last 24h. ` +
                    `Last run may have failed or not run. Check reconciliation_runs table.`,
                );
            }
        }
    }

    /**
     * Poll Finale for newly completed production builds.
     * Detects completed BOM production orders, writes to build_completions for the
     * dashboard BuildSchedulePanel, creates completed events on the MFG calendar,
     * and notifies Will via Telegram.
     */
    async pollBuildCompletions() {
        console.log("Checking for build completions...");
        try {
            const [finale, supabase, calendar, parser] = await Promise.all([
                Promise.resolve(new FinaleClient()),
                Promise.resolve(createClient()),
                Promise.resolve(new CalendarClient()),
                Promise.resolve(new BuildParser()),
            ]);

            const since = new Date(Date.now() - 14 * 86400000);
            const completed = await finale.getRecentlyCompletedBuilds(since);

            if (completed.length === 0) {
                console.log("No completed builds found.");
                return;
            }

            const events = await calendar.getAllUpcomingBuilds(30);
            const parsedBuilds = await parser.extractBuildPlan(events);
            const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";

            let notified = 0;

            for (const build of completed) {
                if (dedupSeen("build_completions", build.buildId)) continue;
                dedupMark("build_completions", build.buildId, 2160); // 90 days TTL
                notified++;

                let calendarEventId: string | null = null;

                // Create completed MFG calendar event
                try {
                    const matched = parsedBuilds.find((p: any) => p.sku === build.sku);
                    const completedAt = new Date(build.completedAt);
                    const buildDate = completedAt.toISOString().split("T")[0];
                    const timeStr = completedAt.toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/Denver",
                    });
                    const scheduledQty = matched?.quantity ?? null;

                    let title: string;
                    if (scheduledQty && scheduledQty !== build.quantity) {
                        const diff = build.quantity - scheduledQty;
                        const sign = diff > 0 ? "+" : "";
                        title = `${build.sku} x${build.quantity}/${scheduledQty} (${sign}${diff})`;
                    } else {
                        title = `${build.sku} x${build.quantity}`;
                    }

                    const descLines: string[] = [`Build Complete \u00B7 ${timeStr}`];
                    if (scheduledQty && scheduledQty !== build.quantity) {
                        const pct = Math.round((build.quantity / scheduledQty) * 100);
                        descLines.push(`Scheduled: ${scheduledQty} \u00B7 Actual: ${build.quantity} (${pct}%)`);
                    }
                    const buildUrlBuf = Buffer.from(build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`);
                    const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/detail/${buildUrlBuf.toString("base64")}`;
                    descLines.push(`\u2192 <a href="${finaleUrl}">Build #${build.buildId}</a>`);

                    calendarEventId = await calendar.createEvent(CALENDAR_IDS.MFG, {
                        title,
                        description: descLines.join("\n"),
                        date: buildDate,
                    });
                    console.log(`Created MFG calendar event ${calendarEventId} for build ${build.buildId}`);
                } catch (calErr: any) {
                    console.warn(`MFG calendar write failed for build ${build.buildId}: ${calErr.message}`);
                }

                // Upsert into build_completions for the dashboard
                if (supabase) {
                    try {
                        await supabase.from("build_completions").upsert(
                            {
                                build_id: build.buildId,
                                sku: build.sku,
                                quantity: build.quantity,
                                completed_at: build.completedAt,
                                calendar_event_id: calendarEventId,
                                calendar_id: calendarEventId ? CALENDAR_IDS.MFG : null,
                            },
                            { onConflict: "build_id" },
                        );
                    } catch (dbErr: any) {
                        console.warn(`Failed to upsert build_completions ${build.buildId}: ${dbErr.message}`);
                    }
                }
            }

            console.log(`Build completion check done \u2014 ${notified} new, ${completed.length} total in window.`);
        } catch (err: any) {
            console.error("pollBuildCompletions error:", err.message);
        }
    }

    /**
     * Poll Finale for today\'s received POs.
     *
     * Activity-feed-backed dedup (2026-05-15): the in-memory Set was never
     * hydrated on startup despite the original comment claiming so — every
     * pm2 restart re-fired every PO received today, producing the "multiple
     * Telegram alerts for same receiving" flood. New flow:
     *   1. Skip POs that already have a PO_RECEIVED row in ap_activity_log
     *      (last 48h, keyed by orderId in metadata).
     *   2. Write the PO_RECEIVED row BEFORE sending Telegram — so any crash
     *      after the row is written but before the alert fires doesn\'t get
     *      a re-send on the next tick.
     *   3. In-memory Set kept as a fast-path cache (avoid the DB read on
     *      already-seen POs within the same process), but it\'s no longer
     *      the source of truth.
     */
    async pollPOReceivings() {
        console.log("Checking for PO receivings...");
        try {
            const received = await finaleClient.getTodaysReceivedPOs();
            if (received.length === 0) return;

            const supabase = createClient();
            const alreadyAlertedPoIds = new Set<string>();
            if (supabase) {
                try {
                    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                    const ids = received.map((po: any) => po.orderId);
                    const { data } = await supabase
                        .from("ap_activity_log")
                        .select("metadata")
                        .eq("intent", "PO_RECEIVED")
                        .gte("created_at", since)
                        .in("metadata->>poId", ids);
                    for (const row of (data ?? []) as Array<{ metadata: any }>) {
                        const id = row.metadata?.poId;
                        if (id) alreadyAlertedPoIds.add(String(id));
                    }
                } catch (err: any) {
                    console.warn("[pollPOReceivings] Activity lookup failed; proceeding with in-memory dedup only:", err.message);
                }
            }

            for (const po of received) {
                if (dedupSeen("received_pos", po.orderId)) continue;
                if (alreadyAlertedPoIds.has(po.orderId)) {
                    dedupMark("received_pos", po.orderId, 168); // 7 days TTL
                    continue;
                }

                if (supabase) {
                    try {
                        await supabase.from("ap_activity_log").insert({
                            email_from: po.supplier,
                            email_subject: `PO ${po.orderId} received`,
                            intent: "PO_RECEIVED",
                            action_taken: `PO #${po.orderId} from ${po.supplier} received \u2014 $${po.total.toFixed(2)}`,
                            metadata: { poId: po.orderId, supplier: po.supplier, total: po.total },
                        });
                    } catch (err: any) {
                        console.warn(`[pollPOReceivings] Activity write failed for PO ${po.orderId}:`, err.message);
                    }
                }

                dedupMark("received_pos", po.orderId, 168); // 7 days TTL

                // KAIZEN(2026-06-01): Lifecycle RECEIVED transition
                setImmediate(() => {
                    import("../../purchasing/po-lifecycle").then(({ transitionLifecycleState }) => {
                        transitionLifecycleState(
                            String(po.orderId),
                            "RECEIVED",
                            "po-receiving-watcher",
                            { supplier: po.supplier, total: po.total }
                        ).catch(() => {});
                    }).catch(() => {});
                });
            }
        } catch (err: any) {
            console.error("PO Receiving error:", err.message);
            try {
                await businessHoursAlert(this.bot, 
                    process.env.TELEGRAM_CHAT_ID || "",
                    `pollPOReceivings error: ${err.message}`,
                );
            } catch { /* swallow */ }
        }
    }

    /**
     * Main Purchasing Calendar Sync Loop.
     * Uses local SQLite as the primary source of truth for event mappings.
     * @param daysBack - Number of days to look back for POs (default: 60)
     * @returns Object with counts of created, updated, skipped, cleared events
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number; cleared: number }> {
        const counts = { created: 0, updated: 0, skipped: 0, cleared: 0 };
        try {
            const finale = finaleClient;
            const supabase = createClient();
            const localDb = getLocalDb();

            const [pos] = await Promise.all([
                finale.getRecentPurchaseOrders(daysBack),
                leadTimeService.warmCache(),
            ]);

            let missingMultiPOs: string[] = [];
            try {
                if (supabase) {
                    const { data: multiPORows } = await supabase
                        .from("purchase_orders")
                        .select("po_number")
                        .eq("is_intended_multi", true);

                    const existingPOIds = new Set(pos.map((p: any) => p.orderId));
                    missingMultiPOs = (multiPORows ?? [])
                        .map((r: any) => r.po_number)
                        .filter((poNum: string) => !existingPOIds.has(poNum));
                }
            } catch { /* Suppress Supabase errors */ }

            let allPOSet = pos;
            if (missingMultiPOs.length > 0) {
                const olderPOs = await finale.getRecentPurchaseOrders(365);
                const matching = olderPOs.filter((p: any) => missingMultiPOs.includes(p.orderId));
                allPOSet = [...pos, ...matching];
            }

            if (allPOSet.length === 0) return counts;

            const localRows = localDb.prepare("SELECT po_number, event_id, calendar_id, status, last_tracking FROM purchasing_calendar_events").all() as any[];
            const existing = new Map<string, { event_id: string; calendar_id: string; status: string; last_tracking: string }>();
            for (const row of localRows) {
                existing.set(row.po_number, row);
            }

            const calendar = new CalendarClient();

            console.log(`[cal-sync] Syncing ${allPOSet.length} POs with local state...`);
            for (const po of allPOSet) {
                if (!po.orderId || po.orderId.toLowerCase().includes("dropship")) continue;

                const status = (po.status || "").toLowerCase();
                if (!["committed", "completed", "received"].includes(status)) continue;

                let expectedDate: string;
                let leadProvenance: string;
                if (po.orderDate) {
                    const lt = await leadTimeService.getForVendor(po.vendorName);
                    expectedDate = this.addDays(po.orderDate, lt.days);
                    leadProvenance = lt.label;
                } else {
                    expectedDate = new Date().toISOString().split("T")[0];
                    leadProvenance = "14d default";
                }

                const { getHighConfidenceTrackingForPOs } = await import("../../tracking/shipment-intelligence");
                let highConfTracking: any[] = [];
                try {
                    highConfTracking = await getHighConfidenceTrackingForPOs([po.orderId]);
                } catch {
                    highConfTracking = (po.shipments || []).map((s: any) => ({
                        trackingNumber: s.shipmentId,
                        status: s.status,
                        eta: s.receiveDate ? `${s.receiveDate}T12:00:00Z` : null,
                    }));
                }

                const trackingNumbers = highConfTracking.map((t: any) => t.trackingNumber);
                const trackingStatuses = new Map<string, TrackingStatus | null>();
                for (const t of highConfTracking) {
                    trackingStatuses.set(t.trackingNumber, {
                        category: (t.status?.toLowerCase().includes("delivered") ? "delivered" : "shipped") as any,
                        display: t.status || "Shipped",
                        public_url: t.carrierUrl || "",
                        estimated_delivery_at: t.eta,
                    });
                }

                const trackingHash = trackingNumbers.sort().join(",") + "|" +
                    Array.from(trackingStatuses.values()).map((ts) => ts?.display || "").join(",");

                const actualReceiveDate = resolvePurchaseOrderReceiptDate({
                    status: po.status,
                    receiveDate: po.receiveDate,
                    shipments: po.shipments,
                });

                const completionState = derivePOCompletionState({
                    finaleReceived: hasPurchaseOrderReceipt({ status: po.status, receiveDate: po.receiveDate, shipments: po.shipments }),
                    trackingDelivered: trackingNumbers.length > 0 && Array.from(trackingStatuses.values()).every((ts) => ts?.category === "delivered"),
                    hasMatchedInvoice: false,
                    reconciliationVerdict: null,
                    freightResolved: false,
                    unresolvedBlockers: [],
                });

                const latestETA = highConfTracking.map((t: any) => t.eta).filter(Boolean).sort().pop();
                const derivedExpectedDate = latestETA ? latestETA.split("T")[0] : expectedDate;

                const lifecycle = derivePurchasingLifecycle(
                    po.status,
                    Array.from(trackingStatuses.values()),
                    completionState,
                    derivedExpectedDate,
                    actualReceiveDate,
                    po.shipments,
                    { is_intended_multi: false, notes: po.notes, comments: po.comments },
                );

                const title = this.buildPOEventTitle(po, lifecycle);
                const description = await this.buildPOEventDescription(po, expectedDate, leadProvenance, trackingNumbers, trackingStatuses, lifecycle, latestETA, highConfTracking, null);
                const eventDate = getPurchasingEventDate(expectedDate, actualReceiveDate, lifecycle, latestETA);

                const existingRow = existing.get(po.orderId);
                const colorId = lifecycle.colorId;

                if (!existingRow) {
                    try {
                        const eventId = await calendar.createEvent(PURCHASING_CALENDAR_ID, { title, description, date: eventDate, colorId });
                        localDb.prepare("INSERT INTO purchasing_calendar_events (po_number, event_id, calendar_id, status, last_tracking, title) VALUES (?, ?, ?, ?, ?, ?)").run(po.orderId, eventId, PURCHASING_CALENDAR_ID, lifecycle.calendarStatus, trackingHash, title);
                        counts.created++;
                        console.log(`Created PO #${po.orderId} calendar event.`);
                    } catch (e: any) {
                        console.warn(`[cal-sync] Fail PO #${po.orderId}: ${e.message}`);
                    }
                } else if (existingRow.status !== lifecycle.calendarStatus || existingRow.last_tracking !== trackingHash || ["past_due", "exception"].includes(lifecycle.calendarStatus)) {
                    const ok = await calendar.updateEvent(existingRow.calendar_id, existingRow.event_id, { title, description, colorId, date: eventDate });
                    if (ok === null) {
                        localDb.prepare("DELETE FROM purchasing_calendar_events WHERE po_number = ?").run(po.orderId);
                    } else {
                        localDb.prepare("UPDATE purchasing_calendar_events SET status = ?, last_tracking = ?, title = ?, updated_at = CURRENT_TIMESTAMP WHERE po_number = ?").run(lifecycle.calendarStatus, trackingHash, title, po.orderId);
                        counts.updated++;
                    }
                } else {
                    counts.skipped++;
                }
            }
            console.log(`[cal-sync] Complete: ${counts.created} created, ${counts.updated} updated.`);
        } catch (err: any) {
            console.error("[cal-sync] Fatal error:", err.message);
        }
        return counts;
    }

    /**
     * Phase 2/3 calibration loop. Runs daily at 8:30 AM. Each step is
     * best-effort — none should be allowed to block the others.
     */
    async runQtyCalibration() {
        const { attachReceivedPOsToRecommendations, recomputeVendorCalibrationStats } = await import("../../purchasing/calibration-engine");
        const { cleanupExpiredReservations } = await import("../../purchasing/calibration");

        try {
            const attached = await attachReceivedPOsToRecommendations(30);
            console.log(`[qty-calibration] receivedPOs=${attached.receivedPOs} matched=${attached.matched} calibrated=${attached.calibrated} (precision=${attached.matchMethods.precision} fuzzy=${attached.matchMethods.fuzzy})`);
        } catch (err: any) {
            console.warn(`[qty-calibration] attach pass failed: ${err.message}`);
        }

        try {
            const recompute = await recomputeVendorCalibrationStats();
            console.log(`[qty-calibration] vendor stats refreshed for ${recompute.vendors} vendor(s)`);
        } catch (err: any) {
            console.warn(`[qty-calibration] recompute pass failed: ${err.message}`);
        }

        try {
            const released = await cleanupExpiredReservations();
            if (released > 0) console.log(`[qty-calibration] released ${released} expired draft reservation(s)`);
        } catch (err: any) {
            console.warn(`[qty-calibration] reservation cleanup failed: ${err.message}`);
        }
    }

    /**
     * Sync PO conversations with Gmail threads.
     * Extracts tracking numbers, vendor responses, and ETA data from email threads.
     */
    async syncPOConversations() {
        console.log("Syncing PO Conversations...");
        const trackingUpdatesBatch: Array<{ poNumber: string; vendorName: string; newOnes: string[] }> = [];
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            const since = new Date();
            since.setDate(since.getDate() - 45);
            const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, "/");

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: `(label:PO OR "BuildASoil PO #") after:${sinceStr}`,
                maxResults: 100,
            });

            if (!search.messages?.length) return;

            for (const m of search.messages) {
                const { data: thread } = await gmail.users.threads.get({ userId: "me", id: m.threadId!, format: "full" });
                if (!thread.messages) continue;

                const trackingNumbers: string[] = [];
                const vendorEmails: string[] = [];
                const firstMsg = thread.messages[0];
                const subject = firstMsg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "";

                const poMatch = subject.match(/BuildASoil PO #\s?(\d+)/i);
                if (!poMatch) continue;
                const poNumber = poMatch[1];

                const vendorMatch = subject.match(/BuildASoil PO\s*#?\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+$/i);
                const vendorName = vendorMatch ? vendorMatch[1].trim() : subject;

                const sentAt = parseInt(firstMsg.internalDate!);
                let responseAt: number | null = null;
                let lastVendorMsgAt: number | null = null;
                let humanReplyDetectedAt: string | null = null;
                let responseTimeMins: number | null = null;
                let firstResponderAddress: string | null = null;

                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find((h: any) => h.name === "From")?.value || "";
                    const msgTime = parseInt(msg.internalDate!);
                    if (!from.includes("buildasoil.com")) {
                        if (!responseAt) {
                            responseAt = msgTime;
                            responseTimeMins = Math.round((responseAt - sentAt) / 1000 / 60);
                            const addrMatch = from.match(/<([^>]+)>/) ?? from.match(/([^\s<>"\',]+@[^\s<>"\',]+)/);
                            if (addrMatch) firstResponderAddress = addrMatch[1].trim();
                        }
                        lastVendorMsgAt = msgTime;
                    } else if (lastVendorMsgAt && !humanReplyDetectedAt) {
                        humanReplyDetectedAt = new Date(msgTime).toISOString();
                    }
                }

                let firstVendorBody: string | null = null;
                let firstVendorSubject: string | null = null;
                for (const msg of thread.messages) {
                    const bodyParts: string[] = [msg.snippet || ""];
                    if (msg.payload?.body?.data) bodyParts.push(_decodeGmailBody(msg.payload.body.data));
                    if (msg.payload?.parts) _walkMsgParts(msg.payload.parts, bodyParts);
                    const bodyText = bodyParts.join("\n");
                    const fromH = msg.payload?.headers?.find((h: any) => h.name === "From")?.value || "";
                    if (firstVendorBody == null && !fromH.toLowerCase().includes("buildasoil.com")) {
                        firstVendorBody = bodyText;
                        firstVendorSubject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || null;
                    }
                    const ltlCarrier = detectLTLCarrier(bodyText);

                    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                        const gRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
                        let match;
                        while ((match = gRegex.exec(bodyText)) !== null) {
                            const trackingNum = ["generic", "pro", "bol", "oakharbor"].includes(carrier) ? (match[1] || match[0]) : match[0];
                            if (!trackingNum || (trackingNum.match(/\d/g)?.length ?? 0) < 2) continue;
                            let encoded = trackingNum;
                            if (carrier === "oakharbor") encoded = `Oak Harbor Freight Lines:::${trackingNum}`;
                            else if ((carrier === "pro" || carrier === "bol") && ltlCarrier) encoded = `${ltlCarrier}:::${trackingNum}`;

                            if (!trackingNumbers.some((t) => (t.split(":::")[1] || t) === (encoded.split(":::")[1] || encoded))) {
                                trackingNumbers.push(encoded);
                            }
                        }
                    }
                }

                if (supabase) {
                    try {
                        const { data: existing } = await supabase
                            .from("purchase_orders")
                            .select("tracking_numbers, po_sent_verified_at, po_sent_verified_source, po_sent_verified_evidence, vendor_stated_eta_extracted_at")
                            .eq("po_number", poNumber)
                            .maybeSingle();
                        const oldTracking = existing?.tracking_numbers || [];
                        const newOnes = trackingNumbers.filter((t) => !oldTracking.includes(t));

                        const HIGH_CONF = new Set(["po_send", "vendor_reply", "manual"]);
                        const alreadyHighConfidence = existing?.po_sent_verified_source && HIGH_CONF.has(existing.po_sent_verified_source);
                        const sentISO = sentAt ? new Date(sentAt).toISOString() : null;

                        const upsert: Record<string, any> = {
                            po_number: poNumber,
                            updated_at: new Date().toISOString(),
                        };

                        if (newOnes.length > 0) {
                            const merged = [...new Set([...oldTracking, ...trackingNumbers])];
                            upsert.tracking_numbers = merged;
                            upsert.vendor_response_at = responseAt ? new Date(responseAt).toISOString() : null;
                        }

                        if (responseAt) {
                            upsert.vendor_acknowledged_at = new Date(responseAt).toISOString();
                            upsert.vendor_ack_source = "thread_reply";
                        }
                        if (humanReplyDetectedAt) {
                            upsert.human_reply_detected_at = humanReplyDetectedAt;
                        }

                        const existingEta = (existing as any)?.vendor_stated_eta_extracted_at;
                        const tooRecent = existingEta && (Date.now() - new Date(existingEta).getTime()) < 5 * 86_400_000;
                        if (firstVendorBody && responseAt && !tooRecent) {
                            try {
                                const { extractETAFromText } = await import("@/lib/purchasing/eta-extractor");
                                const eta = await extractETAFromText({
                                    body: firstVendorBody,
                                    subject: firstVendorSubject ?? undefined,
                                });
                                if (eta.confidence !== "low" && (eta.etaDate || eta.shipDate)) {
                                    upsert.vendor_stated_eta = eta.etaDate;
                                    upsert.vendor_stated_ship_date = eta.shipDate;
                                    upsert.vendor_stated_eta_confidence = eta.confidence;
                                    upsert.vendor_stated_eta_extracted_at = new Date().toISOString();
                                    upsert.vendor_stated_eta_rationale = eta.rationale;
                                }
                            } catch (etaErr: any) {
                                console.warn("[po-sync] ETA extract failed:", etaErr?.message ?? etaErr);
                            }
                        }

                        if (!alreadyHighConfidence && sentISO) {
                            const evidence = {
                                type: "po_send",
                                source: "gmail_outbox",
                                at: sentISO,
                                detail: `label:PO outbox \u2014 ${subject}`,
                                gmail_thread_id: m.threadId,
                            };
                            const evidenceList = Array.isArray(existing?.po_sent_verified_evidence)
                                ? [...existing.po_sent_verified_evidence, evidence]
                                : [evidence];
                            upsert.po_sent_at = existing?.po_sent_verified_at ?? sentISO;
                            upsert.po_sent_verified_at = existing?.po_sent_verified_at ?? sentISO;
                            upsert.po_sent_verified_source = existing?.po_sent_verified_source ?? "po_send";
                            upsert.po_sent_verified_evidence = evidenceList;
                        }

                        const willWrite = newOnes.length > 0 || (!alreadyHighConfidence && sentISO) || !!responseAt;
                        if (willWrite) {
                            await supabase.from("purchase_orders").upsert(upsert, { onConflict: "po_number" });
                        }

                        if (responseAt && firstResponderAddress && vendorName) {
                            try {
                                const { recordVendorOrdersEmailFromReply } = await import("@/lib/purchasing/po-sender");
                                const r = await recordVendorOrdersEmailFromReply(vendorName, firstResponderAddress);
                                if (r.updated) {
                                    console.log(`[po-sync] orders_email ${r.reason} for ${vendorName} \u2192 ${firstResponderAddress.toLowerCase()}`);
                                }
                            } catch (err: any) {
                                console.warn(`[po-sync] orders_email write-back failed for ${vendorName}: ${err?.message ?? err}`);
                            }
                        }

                        if (newOnes.length > 0) {
                            trackingUpdatesBatch.push({ poNumber, vendorName, newOnes });
                        }
                    } catch { /* Supabase offline */ }
                }
            }

            if (trackingUpdatesBatch.length > 0) {
                const lines = trackingUpdatesBatch.map((b) =>
                    `\u2022 #${b.poNumber} ${b.vendorName}: ${b.newOnes.join(", ")}`,
                );
                const msg = `Tracking Updates (${trackingUpdatesBatch.length})\n\n${lines.join("\n")}`;
                try {
                    await businessHoursAlert(this.bot, process.env.TELEGRAM_CHAT_ID || "", msg, { parse_mode: "Markdown" });
                } catch (e: any) {
                    console.warn("[po-sync] tracking batch send failed:", e.message);
                }
            }
        } catch (err: any) {
            console.error("PO Sync error:", err.message);
        }
    }
}
