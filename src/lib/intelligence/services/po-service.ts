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
import { createClient } from "../../db";
import { dedupSeen, dedupMark } from "../../storage/local-db";
import { Telegraf } from "telegraf";
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../../google/calendar";
import { BuildParser } from "../build-parser";
import { FinaleClient, finaleClient } from "../../finale/client";
import {
    TRACKING_PATTERNS,
    detectLTLCarrier,
} from "../../carriers/tracking-service";
import { loadActivePurchases, type ActivePurchase } from "../../purchasing/active-purchases";
import { runPOSweep as runPOSweepModule } from "../../matching/po-sweep";
import { exec } from "child_process";
import { promisify } from "util";
import { businessHoursAlert } from "../alert-gate";

const supabase = createClient();
const db = supabase;

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

    /** Purchasing calendar sync wrapper — minimal incoming mirror. */
    public async runPurchasingCalendarSync(): Promise<void> {
        await this.syncPurchasingCalendarMinimal();
    }

    /**
     * Minimal, idempotent purchasing-calendar sync.
     *
     * One event per ACTIVE (incoming, not-yet-received) PO. Source of truth is
     * `loadActivePurchases` — the same "what's incoming" set the dashboard shows,
     * so received/cancelled POs drop off automatically. Title carries no lifecycle
     * prefix; status/timeline live in the event body.
     *
     * Replaces the old lifecycle-prefixed sync, which deduped against a
     * `process.cwd()`-relative SQLite mapping (3 divergent copies on disk) and
     * never deleted calendar events — producing 10-66 duplicate events per PO.
     *
     * Idempotent: reconciles by PO number extracted from the event title, so
     * repeated runs neither duplicate nor drift.
     *
     * @returns Counts of created / updated / deleted events
     */
    async syncPurchasingCalendarMinimal(): Promise<{ created: number; updated: number; deleted: number }> {
        const counts = { created: 0, updated: 0, deleted: 0 };
        try {
            const active = await loadActivePurchases(finaleClient, 60);
            const activeById = new Map(active.map((p) => [String(p.orderId), p]));

            const calendar = new CalendarClient();
            const timeMin = new Date(Date.now() - 365 * 86400000).toISOString();
            const timeMax = new Date(Date.now() + 365 * 86400000).toISOString();
            const events = await calendar.listEvents(PURCHASING_CALENDAR_ID, timeMin, timeMax);

            const byPo = new Map<string, Array<{ id: string; summary: string; created: string }>>();
            for (const ev of events) {
                const m = /PO #(\d+)/.exec(ev.summary || "");
                const key = m ? m[1] : "__other__";
                if (!byPo.has(key)) byPo.set(key, []);
                byPo.get(key)!.push({ id: ev.id, summary: ev.summary, created: ev.created });
            }

            // Remove received/stale POs + any non-PO events (no longer incoming).
            for (const [po, evs] of byPo) {
                if (po === "__other__" || !activeById.has(po)) {
                    for (const ev of evs) {
                        await calendar.deleteEvent(PURCHASING_CALENDAR_ID, ev.id);
                        counts.deleted++;
                    }
                }
            }

            // For active POs: keep exactly one event, retitle, fix date + body.
            for (const [po, evs] of byPo) {
                if (po === "__other__" || !activeById.has(po)) continue;
                const p = activeById.get(po)!;
                evs.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
                const keep = evs[0];
                for (const ev of evs.slice(1)) {
                    await calendar.deleteEvent(PURCHASING_CALENDAR_ID, ev.id);
                    counts.deleted++;
                }
                const title = `PO #${po} - ${p.vendorName || "Unknown Vendor"}`;
                const date = (p.expectedDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
                const description = this.buildMinimalPOEventDescription(p);
                const ok = await calendar.updateEvent(PURCHASING_CALENDAR_ID, keep.id, { title, description, date });
                if (ok) {
                    counts.updated++;
                } else {
                    // Event vanished on Google's side — recreate.
                    await calendar.createEvent(PURCHASING_CALENDAR_ID, { title, description, date });
                    counts.created++;
                }
            }

            // Create events for active POs that have none yet.
            for (const [po, p] of activeById) {
                if (byPo.has(po) && byPo.get(po)!.length > 0) continue;
                const title = `PO #${po} - ${p.vendorName || "Unknown Vendor"}`;
                const date = (p.expectedDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
                const description = this.buildMinimalPOEventDescription(p);
                await calendar.createEvent(PURCHASING_CALENDAR_ID, { title, description, date });
                counts.created++;
            }

            console.log(`[cal-sync-minimal] created=${counts.created} updated=${counts.updated} deleted=${counts.deleted} (active=${activeById.size})`);
        } catch (err: any) {
            console.error("[cal-sync-minimal] Fatal error:", err.message);
        }
        return counts;
    }

    /**
     * Build a clean event body for the minimal calendar: Finale link, vendor,
     * line items, status, order date, expected arrival. No lifecycle/tracking
     * churn — just what the team needs to see what's incoming.
     */
    private buildMinimalPOEventDescription(po: ActivePurchase): string {
        const finaleUrl = po.finaleUrl;

        let desc = `<b><a href="${finaleUrl}">PO #${po.orderId}</a></b>\n`;
        desc += `Vendor: ${po.vendorName}\n`;
        if (po.items && po.items.length > 0) {
            desc += `\n<b>Items:</b>\n`;
            for (const item of po.items) {
                desc += `- ${item.productId}: ${item.quantity}\n`;
            }
        }
        desc += `\nStatus: ${po.status}\n`;
        desc += `Order Date: ${po.orderDate}\n`;
        desc += `Expected: ${(po.expectedDate || "").slice(0, 10)}`;
        if (po.leadProvenance) desc += ` (${po.leadProvenance})`;
        desc += `\n`;
        return desc;
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
                if (db) {
                    try {
                        await db.from("build_completions").upsert(
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

            const db = createClient();
            const alreadyAlertedPoIds = new Set<string>();
            if (db) {
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

                if (db) {
                    try {
                        await db.from("ap_activity_log").insert({
                            email_from: po.supplier,
                            email_subject: `PO ${po.orderId} received`,
                            // SEMANTICS (locked 2026-08-06): PO_RECEIVED = Finale goods
                            // receipt observed by pollPOReceivings. NOT carrier delivery.
                            // Carrier delivery lives on shipments.status_category=delivered.
                            // Vault "DELIVERED · need receive" must NOT treat this intent alone
                            // as carrier proof (HerbsNOW 125126 trust break).
                            intent: "PO_RECEIVED",
                            action_taken: `PO #${po.orderId} from ${po.supplier} received \u2014 $${po.total.toFixed(2)}`,
                            metadata: {
                                poId: po.orderId,
                                supplier: po.supplier,
                                total: po.total,
                                source: "finale_pollPOReceivings",
                                kind: "finale_receipt",
                            },
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
            const db = createClient();

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

                if (db) {
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
                            await db.from("purchase_orders").upsert(upsert, { onConflict: "po_number" });
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
                    `• #${b.poNumber} ${b.vendorName}: ${b.newOnes.join(", ")}`,
                );
                const msg = `Tracking Updates (${trackingUpdatesBatch.length})\n\n${lines.join("\n")}`;
                try {
                    await businessHoursAlert(this.bot, process.env.TELEGRAM_CHAT_ID || "", msg, { parse_mode: "Markdown" });
                } catch (e: any) {
                    console.warn("[po-sync] tracking batch send failed:", e.message);
                }
            }

            try {
                const { stampStockoutThreads } = await import("@/lib/purchasing/po-thread-clock-stamp");
                const stamped = await stampStockoutThreads();
                if (stamped.stamped.length > 0) {
                    console.log(`[po-sync] thread-clock holds: ${stamped.stamped.join(", ")}`);
                }
            } catch (clockErr: any) {
                console.warn("[po-sync] thread-clock stamp failed:", clockErr?.message ?? clockErr);
            }
        } catch (err: any) {
            console.error("PO Sync error:", err.message);
        }
    }
}
