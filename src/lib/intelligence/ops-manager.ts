import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { getLocalDb } from "../storage/local-db";
import cron, { type ScheduledTask } from "node-cron";
import { Telegraf } from "telegraf";
import { WebClient } from "@slack/web-api";
import { SYSTEM_PROMPT } from "../../config/persona";
import { indexOperationalContext } from "./pinecone";
import { unifiedTextGeneration } from "./llm";
import { OversightAgent } from "./oversight-agent";
import { runBuildRiskAnalysis } from "../builds/build-risk";
import { leadTimeService } from "../builds/lead-time-service";
import { APIdentifierAgent } from "./workers/ap-identifier";
import { EmailIngestionWorker } from "./workers/email-ingestion";
import { APForwarderAgent } from "./workers/ap-forwarder";
import { TrackingAgent } from "./tracking-agent";
import { AcknowledgementAgent } from "./acknowledgement-agent";
import { SupervisorAgent } from "./supervisor-agent";
import * as agentTask from "./agent-task";
import { closeFinishedTasks } from "./agent-task-closure";
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../google/calendar";
import type { FullPO } from "../finale/client";
import { BuildParser } from "./build-parser";
import { FinaleClient, finaleClient } from "../finale/client";
import { runHousekeeping } from "./feedback-loop";
import {
    TRACKING_PATTERNS,
    getTrackingStatus,
    carrierUrl,
    detectLTLCarrier,
    buildFollowUpEmail,
    isFedExNumber,
    type TrackingStatus,
    type TrackingCategory,
} from '../carriers/tracking-service';
import {
    RECEIVED_CALENDAR_RETENTION_DAYS,
    RECEIVED_DASHBOARD_RETENTION_DAYS,
    derivePurchasingLifecycle,
    getPurchasingEventDate,
    shouldKeepReceivedPurchase,
    daysSinceDate,
} from "../purchasing/calendar-lifecycle";
import { loadActivePurchases } from "../purchasing/active-purchases";
import { loadPOCompletionSignalIndex } from "../purchasing/po-completion-loader";
import { derivePOCompletionState } from "../purchasing/po-completion-state";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "../purchasing/po-receipt-state";
import { syncRecommendationFeedbackForPurchaseOrders } from "../purchasing/recommendation-feedback-sync";
import { withAdvisoryLock } from "../purchasing/advisory-lock";
import { derivePOLifecycleState, shouldRequestTrackingFollowUp, getFollowUpTemplate, getFollowUpTemplateL2, shouldUseL2FollowUp, getVendorThankYou, getVendorClarifyRequest } from "../purchasing/derive-po-lifecycle";
import { VendorCommsAgent } from "./vendor-comms-agent";
import { enqueueEmailClassification } from "./nightshift-agent";
import { runPOSweep } from "../matching/po-sweep";
import { buildDailyFinaleSlices } from "./ops-summary-slices";
import {
    recordCronRun,
    getAllCronRunStatuses,
    formatCronStatusReport,
    formatCompactStatus,
    type CronRunStatus,
} from '../scheduler/cron-registry';
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { listShipmentsForPurchaseOrders, upsertShipmentEvidence } from "../tracking/shipment-intelligence";
import { runEmailPollingCycle } from "./email-polling-cycle";
import { memoryLayerManager } from "./memory-layer-manager";

const execAsync = promisify(exec);

// DECISION(2026-03-18): 5-minute timeout for vendor reconciliation child processes.
// Prevents hung Playwright browsers or network stalls from running indefinitely.
const RECONCILE_TIMEOUT_MS = 5 * 60 * 1000;
const RECONCILE_MAX_BUFFER = 10 * 1024 * 1024; // 10MB stdout cap

// DECISION(2026-03-19): Tracking logic extracted to src/lib/carriers/tracking-service.ts.
// Removed ~340 lines: TRACKING_PATTERNS, LTL_CARRIER_KEYWORDS, detectLTLCarrier,
// carrierUrl, parseTrackingContent, FedEx OAuth, EasyPost, getLTLTrackingStatus,
// getTrackingStatus, buildFollowUpEmail. All now imported from tracking-service.

// DECISION(2026-03-19): Cron registry extracted to src/lib/scheduler/cron-registry.ts.
// The old cronLastRun Map is replaced by recordCronRun/getAllCronRunStatuses imports.
// Kept as a re-export alias for backward compatibility with any external consumers.
export const cronLastRun = getAllCronRunStatuses();

export class OpsManager {
    private bot: Telegraf;
    private scheduledTasks: ScheduledTask[] = [];
    private slack: WebClient | null;
    private slackChannel: string;
    private apIdentifier: APIdentifierAgent;
    private emailIngestionDefault: EmailIngestionWorker;
    private emailIngestionAP: EmailIngestionWorker;
    private apForwarder: APForwarderAgent;
    private trackingAgent: TrackingAgent;
    private ackAgent: AcknowledgementAgent;
    private supervisor: SupervisorAgent;
    private oversightAgent: OversightAgent;
    private agentName = "ops-manager";
    // In-memory dedup for build completion alerts.
    // Hydrated from Supabase on startup to prevent duplicate alerts after restart.
    private seenCompletedBuildIds = new Set<string>();
    // In-memory dedup for PO receiving alerts.
    // Hydrated from today's received POs on startup to prevent replay after restart.
    private seenReceivedPOIds = new Set<string>();
    // In-memory dedup for outside-PO-thread email alerts.
    // Prevents the same vendor email from triggering a Telegram notification on every sync cycle.
    // Hydrated from Supabase on startup.
    private seenOutsideThreadMsgIds = new Set<string>();

    // Pending ULINE Friday approval — set when cron sends pre-check Telegram message.
    // Cleared when user approves or skips.
    private pendingUlineFriday: {
        messageId: number;
        manifest: any;
        manifestJson: string;
    } | null = null;

    constructor(bot: Telegraf) {
        this.bot = bot;

        // DECISION(2026-02-25): Initialize Slack client alongside Telegram.
        // Slack posting is best-effort — if SLACK_BOT_TOKEN is missing, we
        // gracefully skip Slack without blocking the Telegram message.
        const slackToken = process.env.SLACK_BOT_TOKEN;
        this.slack = slackToken ? new WebClient(slackToken) : null;
        this.slackChannel = process.env.SLACK_MORNING_CHANNEL || "#purchasing";

        if (!this.slack) {
            console.warn("⚠️ OpsManager: SLACK_BOT_TOKEN not set — Slack cross-posting disabled.");
        }

        // Initialize dedicated AP agents
        this.apIdentifier = new APIdentifierAgent(bot);
        this.emailIngestionDefault = new EmailIngestionWorker("default");
        this.emailIngestionAP = new EmailIngestionWorker("ap");
        this.apForwarder = new APForwarderAgent(bot);
        this.trackingAgent = new TrackingAgent();
        this.ackAgent = new AcknowledgementAgent("default");
        this.supervisor = new SupervisorAgent(bot);

        // Initialize OversightAgent for heartbeat monitoring
        this.oversightAgent = new OversightAgent();
        this.registerOversightRecoveries();

        // Hydrate seenCompletedBuildIds from build_completions to prevent duplicate
        // notifications after a restart.  Uses a fire-and-forget so it doesn't block boot.
        this.hydrateSeenCompletedBuildIds();
    }

    private async hydrateSeenCompletedBuildIds() {
        try {
            const supabase = createClient();
            if (!supabase) return;
            const { data } = await supabase
                .from('build_completions')
                .select('build_id')
                .gte('created_at', new Date(Date.now() - 90 * 86400000).toISOString());
            if (data) {
                for (const row of data) {
                    this.seenCompletedBuildIds.add(row.build_id);
                }
                if (this.seenCompletedBuildIds.size > 0) {
                    console.log(`🔨 Hydrated ${this.seenCompletedBuildIds.size} seen build IDs from build_completions`);
                }
            }
        } catch {
            // Non-critical — dedup set starts empty on fresh boot
        }
    }

    private registerOversightRecoveries() {
        const runEmailRecovery = async () => {
            await this.pollAPInbox();
            return true;
        };

        this.oversightAgent.registerRecovery("ops-manager", {
            controlCommand: "restart_bot",
        });
        this.oversightAgent.registerRecovery("default-email-pipeline", {
            retry: runEmailRecovery,
            controlCommand: "run_ap_poll_now",
        });
        this.oversightAgent.registerRecovery("default-acknowledgement", {
            retry: runEmailRecovery,
            controlCommand: "run_ap_poll_now",
        });
        this.oversightAgent.registerRecovery("ap-email-pipeline", {
            retry: runEmailRecovery,
            controlCommand: "run_ap_poll_now",
        });
        this.oversightAgent.registerRecovery("ap-identifier", {
            retry: runEmailRecovery,
            controlCommand: "run_ap_poll_now",
        });
        this.oversightAgent.registerRecovery("ap-forwarder", {
            retry: runEmailRecovery,
            controlCommand: "run_ap_poll_now",
        });
        this.oversightAgent.registerRecovery("nightshift-agent", {
            retry: async () => {
                await enqueueEmailClassification();
                return true;
            },
            controlCommand: "run_nightshift_now",
        });
    }

    /**
     * Safely executes a scheduled task with duration tracking, DB audit logging,
     * and crash escalation. Every run is recorded to cron_runs for observability.
     *
     * DECISION(2026-03-18): Enhanced from bare try/catch to include:
     * - performance.now() duration tracking
     * - In-memory cronLastRun registry for /crons command
     * - Supabase cron_runs table audit trail
     * - Supervisor exception queue on failure
     */
    private async safeRun(taskName: string, task: () => Promise<any> | any) {
        const startTime = performance.now();
        let cronRunId: number | null = null;
        const startedAtIso = new Date().toISOString();

        // Record start in cron_runs (fire-and-forget — don't block the task)
        try {
            const supabase = createClient();
            if (supabase) {
                const { data } = await supabase.from('cron_runs').insert({
                    task_name: taskName,
                    status: 'running',
                }).select('id').single();
                cronRunId = data?.id ?? null;
            }
        } catch { /* non-critical */ }

        try {
            await task();

            const durationMs = Math.round(performance.now() - startTime);
            recordCronRun(taskName, durationMs, 'success');

            // Update cron_runs with success
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    if (supabase) {
                        await supabase.from('cron_runs').update({
                            finished_at: new Date().toISOString(),
                            duration_ms: durationMs,
                            status: 'success',
                        }).eq('id', cronRunId);
                    }
                } catch { /* non-critical */ }
            }

            // Register heartbeat on success
            await this.oversightAgent?.registerHeartbeat(this.agentName, taskName, { lastSuccess: new Date() });
            await memoryLayerManager.archiveSession(`cron:${taskName}:${startedAtIso}`, {
                sessionId: `cron:${taskName}:${startedAtIso}`,
                agentName: this.agentName,
                taskType: taskName,
                inputSummary: `Scheduled task ${taskName}`,
                outputSummary: `Completed in ${durationMs}ms`,
                status: "success",
                createdAt: startedAtIso,
            });
        } catch (error: any) {
            const durationMs = Math.round(performance.now() - startTime);
            recordCronRun(taskName, durationMs, 'error', error.message);

            // Update cron_runs with failure
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    if (supabase) {
                        await supabase.from('cron_runs').update({
                            finished_at: new Date().toISOString(),
                            duration_ms: durationMs,
                            status: 'error',
                            error_message: error.message,
                        }).eq('id', cronRunId);
                    }
                } catch { /* non-critical */ }

                // Mirror to control-plane hub. Failure-only — successful runs do not
                // generate hub rows by design (would drown out the actual work signal).
                // Phase 2.5: incrementOrCreate dedups identical-shape failures into
                // dedup_count++ on the existing row instead of stacking new rows.
                try {
                    const task = await agentTask.incrementOrCreate({
                        sourceTable: 'cron_runs',
                        sourceId: String(cronRunId),
                        type: 'cron_failure',
                        goal: `Cron ${taskName} failed: ${String(error?.message || error).slice(0, 120)}`,
                        status: 'FAILED',
                        owner: 'aria',
                        priority: 1,
                        inputs: {
                            task_name: taskName,
                            error_message: error?.message ?? String(error),
                            duration_ms: durationMs,
                            started_at: startedAtIso,
                        },
                    });
                    const supabase = createClient();
                    if (supabase) {
                        await supabase.from('cron_runs')
                            .update({ task_id: task.id })
                            .eq('id', cronRunId);
                    }
                } catch { /* hub write is best-effort */ }
            }

            console.error(`❌ Cron Task Failed: ${taskName}`, error.message);
            // Escalate to Supervisor
            this.supervisor.reportAgentException(taskName, error);
            // Register heartbeat on error
            await this.oversightAgent?.registerHeartbeat(this.agentName, taskName, { lastError: String(error) });
            await memoryLayerManager.archiveSession(`cron:${taskName}:${startedAtIso}`, {
                sessionId: `cron:${taskName}:${startedAtIso}`,
                agentName: this.agentName,
                taskType: taskName,
                inputSummary: `Scheduled task ${taskName}`,
                outputSummary: String(error?.message || error),
                status: "failure",
                createdAt: startedAtIso,
            });
        }
    }

    /**
     * Helper to add N days to a date string.
     */
    private addDays(date: string, days: number): string {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
    }

    /**
     * Builds a descriptive title for the calendar event.
     */
    private buildPOEventTitle(po: any, lifecycle: any): string {
        const vendor = po.vendorName || 'Unknown Vendor';
        const poNum = po.orderId || '???';
        return `${lifecycle.prefixText} PO #${poNum} - ${vendor}`;
    }

    /**
     * Builds a rich description for the Google Calendar event.
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
        poLifecycleData: any
    ): Promise<string> {
        const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
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
                const status = ts?.display || 'Pending';
                const link = ts?.public_url || carrierUrl(t);
                desc += `- <a href="${link}">${t}</a>: ${status}\n`;
            }
        }

        if (po.notes) desc += `\n<b>Internal Notes:</b>\n${po.notes}\n`;

        return desc;
    }

    /**
     * Start OpsManager and all background cron jobs.
     */
    async start(): Promise<void> {
        await this.oversightAgent?.start();
        this.registerJobs();
    }

    /**
     * Stop OpsManager and all background cron jobs.
     */
    async stop(): Promise<void> {
        await this.oversightAgent?.stop();
        for (const task of this.scheduledTasks) {
            task.stop();
        }
        this.scheduledTasks = [];
    }

    /**
     * Register all background cron jobs.
     */
    registerJobs() {
        const TZ = { timezone: "America/Denver" };
        this.scheduledTasks = [];

        const schedule = (expression: string, task: () => void) => {
            const scheduledTask = cron.schedule(expression, task, TZ);
            this.scheduledTasks.push(scheduledTask);
            return scheduledTask;
        };

        // AP polling every 15 minutes
        schedule("*/15 * * * *", () => {
            this.safeRun("APPolling", () => this.pollAPInbox());
        });

        // Build risk analysis at 7:30 AM weekdays
        schedule("30 7 * * 1-5", () => {
            this.safeRun("BuildRisk", () => this.runDailyBuildRisk());
        });

        // Daily summary at 8:00 AM weekdays (Mon-Fri only)
        schedule("0 8 * * 1-5", () => {
            this.safeRun("DailySummary", () => this.sendDailySummary());
        });

        // Weekly summary at 8:01 AM Fridays
        schedule("1 8 * * 5", () => {
            this.safeRun("WeeklySummary", () => this.sendWeeklySummary());
        });

        // Nightshift enqueue at 6:00 PM weekdays
        schedule("0 18 * * 1-5", () => {
            this.safeRun("NightshiftEnqueue", () => this.enqueueNightshiftWork());
        });

        // Housekeeping at 9:00 PM
        schedule("0 21 * * *", () => {
            this.safeRun("Housekeeping", () => runHousekeeping());
        });

        // Dashboard stat indexing every hour
        schedule("5 * * * *", () => {
            this.safeRun("StatIndexing", () => this.indexOperationsContext());
        });

        // PO Sync every 30 minutes
        schedule("*/30 * * * *", () => {
            this.safeRun("POSync", () => this.syncPOConversations());
        });

        // PO-First AP Sweep every 4 hours
        schedule("30 */4 * * *", () => {
            this.safeRun("POSweep", () => runPOSweep(60, false));
        });

        // VENDOR RECONCILIATIONS
        schedule("0 1 * * 1-5", () => {
            this.safeRun("ReconcileAxiom", () => this.runReconciliation("Axiom", "node --import tsx src/cli/reconcile-axiom.ts"));
        });

        schedule("30 1 * * 1-5", () => {
            this.safeRun("ReconcileFedEx", () => this.runReconciliation("FedEx", "node --import tsx src/cli/reconcile-fedex.ts"));
        });

        schedule("0 2 * * 1-5", () => {
            this.safeRun("ReconcileTeraGanix", () => this.runReconciliation("TeraGanix", "node --import tsx src/cli/reconcile-teraganix.ts"));
        });

        schedule("0 3 * * 1-5", () => {
            this.safeRun("ReconcileULINE", () => this.runReconciliation("ULINE", "node --import tsx src/cli/reconcile-uline.ts"));
        });

        // Build Completion Watcher every 30 minutes
        schedule("*/30 * * * *", () => {
            this.safeRun("BuildCompletionWatcher", () => this.pollBuildCompletions());
        });

        // PO Receiving Watcher every 30 minutes
        schedule("*/30 * * * *", () => {
            this.safeRun("POReceivingWatcher", () => this.pollPOReceivings());
        });

        // Purchasing Calendar Sync every 4 hours
        schedule("0 */4 * * *", () => {
            this.safeRun("PurchasingCalendarSync", () => this.syncPurchasingCalendar(60));
        });

        // Hygiene: close completed agent_task rows every 5 minutes
        schedule("*/5 * * * *", () => {
            this.safeRun("CloseFinishedTasks", async () => {
                const closed = await closeFinishedTasks();
                if (closed > 0) {
                    console.log(`[OpsManager] closeFinishedTasks: closed ${closed} task(s)`);
                }
            });
        });

        console.log("✅ OpsManager background jobs registered.");
    }

    /**
     * Periodically poll AP inbox for new invoices.
     */
    async pollAPInbox() {
        console.log("📡 Polling AP Inbox...");
        try {
            await runEmailPollingCycle({
                emailIngestionDefault: this.emailIngestionDefault,
                acknowledgementAgent: this.ackAgent,
                emailIngestionAP: this.emailIngestionAP,
                apIdentifier: this.apIdentifier,
                apForwarder: this.apForwarder,
                onStageSuccess: (stage: string) => this.oversightAgent.registerHeartbeat(stage, stage, { source: "email-polling-cycle" }),
            });
        } catch (err: any) {
            console.error("AP Polling error:", err.message);
        }
    }

    /**
     * Daily Build Risk Analysis.
     * DECISION(2026-04-14): saveBuildRiskSnapshot call added — was missing,
     * so dashboard BuildRiskPanel/BuildSchedulePanel never had any data to show
     * (they read from build_risk_snapshots, which only got written by /buildrisk
     * command, never by the 7:30 AM cron).
     */
    async runDailyBuildRisk() {
        console.log("📦 Running Daily Build Risk Analysis...");
        try {
            const results = await runBuildRiskAnalysis();
            const { saveBuildRiskSnapshot } = await import('../builds/build-risk-logger');
            await saveBuildRiskSnapshot(results);
        } catch (err: any) {
            console.error("Build Risk error:", err.message);
        }
    }

    /**
     * Enqueue work for Nightshift (local Ollama).
     */
    async enqueueNightshiftWork() {
        console.log("🌙 Enqueuing work for Nightshift...");
        try {
            await enqueueEmailClassification();
            await this.oversightAgent.registerHeartbeat("nightshift-agent", "enqueue-nightshift-work", { source: "ops-manager" });
        } catch (err: any) {
            console.error("Nightshift Enqueue error:", err.message);
        }
    }

    /**
     * Index operational context to Pinecone.
     */
    async indexOperationsContext() {
        console.log("🧠 Indexing operational context...");
        try {
            await indexOperationalContext();
        } catch (err: any) {
            console.error("Indexing error:", err.message);
        }
    }

    /**
     * Run a child process reconciliation script.
     */
    private async runReconciliation(vendorName: string, command: string) {
        console.log(`🔄 Starting ${vendorName} reconciliation...`);
        try {
            const { stdout, stderr } = await execAsync(command, { timeout: RECONCILE_TIMEOUT_MS, maxBuffer: RECONCILE_MAX_BUFFER });
            if (stderr) console.warn(`[Reconcile ${vendorName}] Stderr:`, stderr);
            console.log(`✅ ${vendorName} reconciliation complete.`);
        } catch (err: any) {
            console.error(`${vendorName} reconciliation failed:`, err.message);
        }
    }

    /**
     * Poll Finale for newly completed production builds.
     * Detects completed BOM production orders, writes to build_completions for the
     * dashboard BuildSchedulePanel, creates ✅-completed events on the MFG calendar,
     * and notifies Will via Telegram.
     */
    async pollBuildCompletions() {
        console.log("🔨 Checking for build completions...");
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
                console.log("🔨 No completed builds found.");
                return;
            }

            const events = await calendar.getAllUpcomingBuilds(30);
            const parsedBuilds = await parser.extractBuildPlan(events);
            const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';

            let notified = 0;

            for (const build of completed) {
                if (this.seenCompletedBuildIds.has(build.buildId)) continue;
                this.seenCompletedBuildIds.add(build.buildId);
                notified++;

                let calendarEventId: string | null = null;

                // Create ✅-completed MFG calendar event
                try {
                    const matched = parsedBuilds.find(p => p.sku === build.sku);
                    const completedAt = new Date(build.completedAt);
                    const buildDate = completedAt.toISOString().split('T')[0];
                    const timeStr = completedAt.toLocaleTimeString('en-US', {
                        hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
                    });
                    const scheduledQty = matched?.quantity ?? null;

                    let title: string;
                    if (scheduledQty && scheduledQty !== build.quantity) {
                        const diff = build.quantity - scheduledQty;
                        const sign = diff > 0 ? '+' : '';
                        title = `✅ ${build.sku} ×${build.quantity}/${scheduledQty} (${sign}${diff})`;
                    } else {
                        title = `✅ ${build.sku} ×${build.quantity}`;
                    }

                    const descLines: string[] = [`Build Complete · ${timeStr}`];
                    if (scheduledQty && scheduledQty !== build.quantity) {
                        const pct = Math.round((build.quantity / scheduledQty) * 100);
                        descLines.push(`Scheduled: ${scheduledQty} · Actual: ${build.quantity} (${pct}%)`);
                    }
                    const buildUrlBuf = Buffer.from(build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`);
                    const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/detail/${buildUrlBuf.toString('base64')}`;
                    descLines.push(`→ <a href="${finaleUrl}">Build #${build.buildId}</a>`);

                    calendarEventId = await calendar.createEvent(CALENDAR_IDS.MFG, {
                        title,
                        description: descLines.join('\n'),
                        date: buildDate,
                    });
                    console.log(`🔨 Created MFG calendar event ${calendarEventId} for build ${build.buildId}`);
                } catch (calErr: any) {
                    console.warn(`⚠️ MFG calendar write failed for build ${build.buildId}: ${calErr.message}`);
                }

                // Upsert into build_completions for the dashboard
                if (supabase) {
                    try {
                        await supabase.from('build_completions').upsert(
                            {
                                build_id: build.buildId,
                                sku: build.sku,
                                quantity: build.quantity,
                                completed_at: build.completedAt,
                                calendar_event_id: calendarEventId,
                                calendar_id: calendarEventId ? CALENDAR_IDS.MFG : null,
                            },
                            { onConflict: 'build_id' }
                        );
                    } catch (dbErr: any) {
                        console.warn(`⚠️ Failed to upsert build_completions ${build.buildId}: ${dbErr.message}`);
                    }
                }

                // Build completion logged to database only — Telegram notifications disabled
            }

            console.log(`🔨 Build completion check done — ${notified} new, ${completed.length} total in window.`);
        } catch (err: any) {
            console.error("🔨 pollBuildCompletions error:", err.message);
        }
    }

    /**
     * Poll Finale for today's received POs.
     */
    async pollPOReceivings() {
        console.log("📦 Checking for PO receivings...");
        try {
            const received = await finaleClient.getTodaysReceivedPOs();
            for (const po of received) {
                if (this.seenReceivedPOIds.has(po.orderId)) continue;
                this.seenReceivedPOIds.add(po.orderId);
                const msg = `✅ **PO Received**\n\nPO #${po.orderId} from ${po.supplier}\nValue: $${po.total.toFixed(2)}`;
                await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || "", msg, { parse_mode: "Markdown" });
            }
        } catch (err: any) {
            console.error("PO Receiving error:", err.message);
        }
    }

    /**
     * Main Purchasing Calendar Sync Loop.
     * Uses local SQLite as the primary source of truth for event mappings.
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number; cleared: number }> {
        const counts = { created: 0, updated: 0, skipped: 0, cleared: 0 };
        try {
            const finale = finaleClient;
            const supabase = createClient();
            const localDb = getLocalDb();

            // Warm the shared lead time cache + fetch POs in parallel
            const [pos] = await Promise.all([
                finale.getRecentPurchaseOrders(daysBack),
                leadTimeService.warmCache(),
            ]);

            // Attempt to get multi-PO info from Supabase if available
            let missingMultiPOs: string[] = [];
            try {
                if (supabase) {
                    const { data: multiPORows } = await supabase
                        .from('purchase_orders')
                        .select('po_number')
                        .eq('is_intended_multi', true);

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

            // Load existing mappings from Local SQLite (Reliable brain)
            const localRows = localDb.prepare('SELECT po_number, event_id, calendar_id, status, last_tracking FROM purchasing_calendar_events').all() as any[];
            const existing = new Map<string, { event_id: string; calendar_id: string; status: string; last_tracking: string }>();
            for (const row of localRows) {
                existing.set(row.po_number, row);
            }

            const calendar = new CalendarClient();

            console.log(`[cal-sync] Syncing ${allPOSet.length} POs with local state...`);
            for (const po of allPOSet) {
                if (!po.orderId || po.orderId.toLowerCase().includes('dropship')) continue;

                const status = (po.status || '').toLowerCase();
                if (!['committed', 'completed', 'received'].includes(status)) continue;

                let expectedDate: string;
                let leadProvenance: string;
                if (po.orderDate) {
                    const lt = await leadTimeService.getForVendor(po.vendorName);
                    expectedDate = this.addDays(po.orderDate, lt.days);
                    leadProvenance = lt.label;
                } else {
                    expectedDate = new Date().toISOString().split('T')[0];
                    leadProvenance = '14d default';
                }

                // Get tracking (Fallback to Finale shipments if Supabase is down)
                const { getHighConfidenceTrackingForPOs } = await import('../tracking/shipment-intelligence');
                let highConfTracking: any[] = [];
                try {
                    highConfTracking = await getHighConfidenceTrackingForPOs([po.orderId]);
                } catch {
                    highConfTracking = (po.shipments || []).map((s: any) => ({
                        trackingNumber: s.shipmentId,
                        status: s.status,
                        eta: s.receiveDate ? `${s.receiveDate}T12:00:00Z` : null
                    }));
                }

                const trackingNumbers = highConfTracking.map((t: any) => t.trackingNumber);
                const trackingStatuses = new Map<string, TrackingStatus | null>();
                for (const t of highConfTracking) {
                    trackingStatuses.set(t.trackingNumber, {
                        category: (t.status?.toLowerCase().includes('delivered') ? 'delivered' : 'shipped') as any,
                        display: t.status || 'Shipped',
                        public_url: t.carrierUrl || '',
                        estimated_delivery_at: t.eta,
                    });
                }

                const trackingHash = trackingNumbers.sort().join(',') + '|' +
                                   Array.from(trackingStatuses.values()).map(ts => ts?.display || '').join(',');

                const actualReceiveDate = resolvePurchaseOrderReceiptDate({
                    status: po.status,
                    receiveDate: po.receiveDate,
                    shipments: po.shipments,
                });

                const completionState = derivePOCompletionState({
                    finaleReceived: hasPurchaseOrderReceipt({ status: po.status, receiveDate: po.receiveDate, shipments: po.shipments }),
                    trackingDelivered: trackingNumbers.length > 0 && Array.from(trackingStatuses.values()).every(ts => ts?.category === 'delivered'),
                    hasMatchedInvoice: false,
                    reconciliationVerdict: null,
                    freightResolved: false,
                    unresolvedBlockers: [],
                });

                const latestETA = highConfTracking.map((t: any) => t.eta).filter(Boolean).sort().pop();
                const derivedExpectedDate = latestETA ? latestETA.split('T')[0] : expectedDate;

                const lifecycle = derivePurchasingLifecycle(
                    po.status,
                    Array.from(trackingStatuses.values()),
                    completionState,
                    derivedExpectedDate,
                    actualReceiveDate,
                    po.shipments,
                    { is_intended_multi: false, notes: po.notes, comments: po.comments }
                );

                const title = this.buildPOEventTitle(po, lifecycle);
                const description = await this.buildPOEventDescription(po, expectedDate, leadProvenance, trackingNumbers, trackingStatuses, lifecycle, latestETA, highConfTracking, null);
                const eventDate = getPurchasingEventDate(expectedDate, actualReceiveDate, lifecycle, latestETA);

                const existingRow = existing.get(po.orderId);
                const colorId = lifecycle.colorId;

                if (!existingRow) {
                    try {
                        const eventId = await calendar.createEvent(PURCHASING_CALENDAR_ID, { title, description, date: eventDate, colorId });
                        // Record locally
                        localDb.prepare('INSERT INTO purchasing_calendar_events (po_number, event_id, calendar_id, status, last_tracking, title) VALUES (?, ?, ?, ?, ?, ?)').run(po.orderId, eventId, PURCHASING_CALENDAR_ID, lifecycle.calendarStatus, trackingHash, title);
                        counts.created++;
                        console.log(`📅 Created PO #${po.orderId} calendar event.`);
                    } catch (e: any) {
                        console.warn(`[cal-sync] Fail PO #${po.orderId}: ${e.message}`);
                    }
                } else if (existingRow.status !== lifecycle.calendarStatus || existingRow.last_tracking !== trackingHash || ['past_due', 'exception'].includes(lifecycle.calendarStatus)) {
                    const ok = await calendar.updateEvent(existingRow.calendar_id, existingRow.event_id, { title, description, colorId, date: eventDate });
                    if (ok === null) {
                        localDb.prepare('DELETE FROM purchasing_calendar_events WHERE po_number = ?').run(po.orderId);
                    } else {
                        localDb.prepare('UPDATE purchasing_calendar_events SET status = ?, last_tracking = ?, title = ?, updated_at = CURRENT_TIMESTAMP WHERE po_number = ?').run(lifecycle.calendarStatus, trackingHash, title, po.orderId);
                        counts.updated++;
                    }
                } else {
                    counts.skipped++;
                }
            }
            console.log(`[cal-sync] Complete: ${counts.created} created, ${counts.updated} updated.`);
        } catch (err: any) {
            console.error('[cal-sync] Fatal error:', err.message);
        }
        return counts;
    }

    /**
     * Send daily summary report to Telegram.
     * Schedule: Mon-Fri only (no weekends).
     * - Monday: light, meaningful review of previous week
     * - Tuesday-Thursday: standard daily ops summary
     * - Friday: weekly wrap-up summary (WeeklySummary fires 1 min later for detailed version)
     */
    async sendDailySummary() {
        // STUB: Daily summary not yet implemented
        const dow = new Date().toLocaleString('en-US', { weekday: 'long', timeZone: 'America/Denver' });
        const isMonday = dow === 'Monday';
        const isFriday = dow === 'Friday';

        if (isMonday) {
            console.log("📊 [STUB] Preparing Monday Previous-Week Review...");
        } else if (isFriday) {
            console.log("📊 [STUB] Preparing Friday Weekly Wrap...");
        } else {
            console.log("📊 [STUB] Preparing Daily PO Summary...");
        }
    }

    /**
     * Send weekly summary report to Telegram (8:01 AM Fridays).
     * Detailed trend analysis — complements the Friday daily summary.
     */
    async sendWeeklySummary() {
        // STUB: Weekly summary not yet implemented
        console.log("📊 [STUB] Preparing Weekly Summary...");
    }

    /**
     * Sync PO conversations with Gmail threads.
     */
    async syncPOConversations() {
        console.log("📦 Syncing PO Conversations...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            const since = new Date();
            since.setDate(since.getDate() - 45);
            const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: `(label:PO OR "BuildASoil PO #") after:${sinceStr}`,
                maxResults: 100
            });

            if (!search.messages?.length) return;

            for (const m of search.messages) {
                const { data: thread } = await gmail.users.threads.get({ userId: "me", id: m.threadId!, format: 'full' });
                if (!thread.messages) continue;

                const trackingNumbers: string[] = [];
                const vendorEmails: string[] = [];
                const firstMsg = thread.messages[0];
                const subject = firstMsg.payload?.headers?.find(h => h.name === 'Subject')?.value || "";

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

                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    const msgTime = parseInt(msg.internalDate!);
                    if (!from.includes("buildasoil.com")) {
                        if (!responseAt) {
                            responseAt = msgTime;
                            responseTimeMins = Math.round((responseAt - sentAt) / 1000 / 60);
                        }
                        lastVendorMsgAt = msgTime;
                    } else if (lastVendorMsgAt && !humanReplyDetectedAt) {
                        humanReplyDetectedAt = new Date(msgTime).toISOString();
                    }
                }

                // Extract tracking...
                for (const msg of thread.messages) {
                    const bodyParts: string[] = [msg.snippet || ''];
                    if (msg.payload?.body?.data) bodyParts.push(_decodeGmailBody(msg.payload.body.data));
                    if (msg.payload?.parts) _walkMsgParts(msg.payload.parts, bodyParts);
                    const bodyText = bodyParts.join('\n');
                    const ltlCarrier = detectLTLCarrier(bodyText);

                    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                        const gRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
                        let match;
                        while ((match = gRegex.exec(bodyText)) !== null) {
                            const trackingNum = ['generic', 'pro', 'bol', 'oakharbor'].includes(carrier) ? (match[1] || match[0]) : match[0];
                            if (!trackingNum || (trackingNum.match(/\d/g)?.length ?? 0) < 2) continue;
                            let encoded = trackingNum;
                            if (carrier === 'oakharbor') encoded = `Oak Harbor Freight Lines:::${trackingNum}`;
                            else if ((carrier === 'pro' || carrier === 'bol') && ltlCarrier) encoded = `${ltlCarrier}:::${trackingNum}`;

                            if (!trackingNumbers.some(t => (t.split(':::')[1] || t) === (encoded.split(':::')[1] || encoded))) {
                                trackingNumbers.push(encoded);
                            }
                        }
                    }
                }

                // Alert and Update (Best effort if Supabase is down)
                if (trackingNumbers.length > 0 && supabase) {
                    try {
                        const { data: existing } = await supabase.from("purchase_orders").select("tracking_numbers").eq("po_number", poNumber).maybeSingle();
                        const oldTracking = existing?.tracking_numbers || [];
                        const newOnes = trackingNumbers.filter(t => !oldTracking.includes(t));
                        if (newOnes.length > 0) {
                            const merged = [...new Set([...oldTracking, ...trackingNumbers])];
                            await supabase.from("purchase_orders").upsert({
                                po_number: poNumber,
                                tracking_numbers: merged,
                                vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                                updated_at: new Date().toISOString()
                            }, { onConflict: "po_number" });

                            await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || "", `📦 **Tracking Update: PO #${poNumber}**\n${vendorName}\n\n${newOnes.join('\n')}`);
                        }
                    } catch { /* Supabase offline */ }
                }
            }
        } catch (err: any) {
            console.error("PO Sync error:", err.message);
        }
    }
}

/**
 * Helper to decode Gmail message body (Base64URL)
 */
function _decodeGmailBody(data: string): string {
    return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Helper to recursively walk multipart Gmail messages
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
