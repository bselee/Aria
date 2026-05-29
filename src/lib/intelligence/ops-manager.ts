import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { getLocalDb } from "../storage/local-db";
import { type ScheduledTask } from "node-cron";
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
    /**
     * Live singleton instance, set in the constructor. Used by
     * src/cron/jobs/index.ts to dispatch handlers without DI.
     */
    static singleton: OpsManager | null = null;

    public bot: Telegraf;
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
        OpsManager.singleton = this;

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

        // HERMIA(2026-05-28): Detect crash loops on boot — alerts Will via Telegram
        // if aria-bot restarted 3+ times in 5 minutes.
        import("@/lib/ops/crash-loop-detector").then(
            ({ detectAndAlertCrashLoop }) => detectAndAlertCrashLoop(this.bot).catch(() => {}),
        ).catch(() => {});

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
    /**
     * Hook called by src/cron/runner on each successful tick. Fires heartbeat
     * to OversightAgent so the dashboard "agent healthy" signal stays fresh.
     * Also notifies HermesOrchestrator so /hermia stays current in real-time.
     * Best-effort — never throws.
     */
    public async cronHookSuccess(taskName: string): Promise<void> {
        try {
            await this.oversightAgent?.registerHeartbeat(this.agentName, taskName, { lastSuccess: new Date() });
        } catch (e: any) {
            console.warn(`[ops-manager] cronHookSuccess(${taskName}) heartbeat failed: ${e.message}`);
        }
        // HERMIA(2026-05-29): Bridge cron outcomes to orchestrator agent registry
        try {
            const { getOrchestrator } = await import("@/lib/intelligence/hermes-orchestrator");
            await getOrchestrator().notifyCronOutcome(taskName, true);
        } catch { /* non-fatal */ }
    }

    /**
     * Hook called by src/cron/runner on each failed tick. Fires heartbeat with
     * the error AND escalates via SupervisorAgent. Best-effort — never throws.
     */
    public async cronHookFailure(taskName: string, error: any): Promise<void> {
        try {
            await this.oversightAgent?.registerHeartbeat(this.agentName, taskName, { lastError: String(error?.message ?? error) });
        } catch (e: any) {
            console.warn(`[ops-manager] cronHookFailure(${taskName}) heartbeat failed: ${e.message}`);
        }
        // HERMIA(2026-05-29): Bridge cron failures to orchestrator agent registry
        try {
            const { getOrchestrator } = await import("@/lib/intelligence/hermes-orchestrator");
            await getOrchestrator().notifyCronOutcome(taskName, false, String(error?.message ?? error));
        } catch { /* non-fatal */ }
        try {
            this.supervisor.reportAgentException(taskName, error);
        } catch (e: any) {
            console.warn(`[ops-manager] cronHookFailure(${taskName}) supervisor escalate failed: ${e.message}`);
        }
    }

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
     *
     * DECISION(2026-05-05): Cron registration moved into the typed registry at
     * src/cron/jobs/index.ts (defineJob entries) and started by
     * startCronRunner() in the boot path. This method is now a no-op kept for
     * backward compatibility with callers like start-bot.ts. The singleton
     * field is set in the constructor; cron handlers reach OpsManager via
     * OpsManager.singleton.
     */
    registerJobs() {
        // Intentionally empty. See src/cron/jobs/index.ts.
        console.log("✅ OpsManager: cron registration delegated to src/cron/jobs.");
    }

    /** Wraps closeFinishedTasks() with a count log. */
    public async runCloseFinishedTasks(): Promise<void> {
        const closed = await closeFinishedTasks();
        if (closed > 0) {
            console.log(`[OpsManager] closeFinishedTasks: closed ${closed} task(s)`);
        }
    }

    /** Self-heal Layer A: tripwires (migration drift, etc.). */
    public async runMigrationTripwire(): Promise<void> {
        const { runAllTripwires } = await import("./tripwires");
        const { applyTripwireResults } = await import("./tripwire-runner");
        const results = await runAllTripwires();
        await applyTripwireResults(results);
        const failing = results.filter(r => !r.ok).length;
        if (failing > 0) {
            console.log(`[OpsManager] tripwires: ${failing}/${results.length} failing`);
        }
    }

    /** Self-heal Layer C: dispatch queued playbooks. Reads env at call time. */
    public async runTaskSelfHealer(): Promise<void> {
        const { runOnce } = await import("./playbooks/runner");
        const summary = await runOnce({
            allow: {
                dbWrite: process.env.PLAYBOOK_ALLOW_DB_WRITE === "1",
                forcePush: process.env.PLAYBOOK_ALLOW_FORCE_PUSH === "1",
            },
        });
        if (summary.attempted > 0) {
            console.log("[OpsManager] TaskSelfHealer:", summary);
        }
    }

    /**
     * Watcher: identify Finale POs that satisfy all auto-complete gates AND
     * have been settled for ≥48h, then mark them ORDER_COMPLETED. Default OFF
     * via PO_AUTO_COMPLETE_ENABLED env — runs in dry-run mode otherwise.
     * Activity row written only on actual completion (no chatter on skips).
     */
    public async runPOAutoCompleteWatcher(): Promise<void> {
        const { runPOAutoCompleteWatcher } = await import("../purchasing/po-auto-complete");
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
            import("../builds/po-arrival-risk"),
            import("../purchasing/active-purchases"),
            import("../finale/client"),
        ]);
        const [activePOs, intel] = await Promise.all([
            loadActivePurchases(finaleClient),
            finaleClient.getPurchasingIntelligence(),
        ]);
        const items = intel.flatMap((g) => g.items);
        // Precision filter: skip POs the vendor has already invoiced for.
        // For vendors like Axiom (invoice = paid + shipped) and any vendor
        // who sends invoices on dispatch, the invoice IS the "they shipped"
        // signal even if the PO completionState is still in_transit.
        const poNumbers = activePOs.map((p) => p.orderId).filter(Boolean) as string[];
        const poNumbersWithInvoice = await loadInvoiceMatchedPOs(poNumbers);
        const risks = detectAtRiskPOs({
            activePOs,
            purchasingItems: items,
            poNumbersWithInvoice,
        });
        if (risks.length === 0) {
            console.log("[OpsManager] POArrivalRiskCheck: no at-risk POs");
            return;
        }
        const result = await writeAtRiskActivityRows(risks);
        console.log(
            `[OpsManager] POArrivalRiskCheck: ${risks.length} at-risk POs ` +
            `(inserted=${result.inserted} updated=${result.updated} failed=${result.failed})`,
        );
    }

    /** Phase 1 issue ledger: project recent tasks into agent_issue rows. */
    public async runIssueProjection(): Promise<void> {
        const { runIssueProjection } = await import("./issue-projection-cron");
        const summary = await runIssueProjection();
        if (summary.issues_created_or_advanced > 0 || summary.tasks_linked > 0) {
            console.log("[OpsManager] IssueProjection:", summary);
        }
    }

    /** Plan task 4: issue orchestrator. Gated by ISSUE_ORCHESTRATOR_ENABLED. */
    public async runIssueOrchestrator(): Promise<void> {
        const { runIssueOrchestratorOnce } = await import("./issue-orchestrator");
        const summary = await runIssueOrchestratorOnce({ limit: 10 });
        if (summary.evaluated > 0) {
            console.log("[OpsManager] IssueOrchestrator:", summary);
        }
    }

    /** Housekeeping wrapper. */
    public async runHousekeeping(): Promise<void> {
        await runHousekeeping();
    }

    /** PO-First AP Sweep wrapper. */
    public async runPOSweep(): Promise<void> {
        await runPOSweep(60, false);
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

    /** Purchasing calendar sync wrapper (60-day window). */
    public async runPurchasingCalendarSync(): Promise<void> {
        await this.syncPurchasingCalendar(60);
    }

    /**
     * Watchdog: alert if any vendor hasn't had a successful reconciliation run in 24h.
     */
    async checkMissingReconciliationRuns(): Promise<void> {
        const VENDORS = ['ULINE', 'FedEx', 'TeraGanix', 'Axiom', 'AAA'];
        const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const sb = createClient();
        if (!sb) return;

        for (const vendor of VENDORS) {
            const { data } = await sb
                .from('reconciliation_runs')
                .select('id, status, started_at')
                .eq('vendor', vendor)
                .gte('started_at', ONE_DAY_AGO)
                .in('status', ['success', 'partial'])
                .order('started_at', { ascending: false })
                .limit(1);

            if (!data || data.length === 0) {
                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    `⚠️ No successful ${vendor} reconciliation run in the last 24h. ` +
                    `Last run may have failed or not run. Check reconciliation_runs table.`
                );
            }
        }
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
     * Enqueue work for Nightshift hosted classification.
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
    public async runReconciliation(vendorName: string, command: string) {
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
     *
     * Activity-feed-backed dedup (2026-05-15): the in-memory Set was never
     * hydrated on startup despite the original comment claiming so — every
     * pm2 restart re-fired every PO received today, producing the "multiple
     * Telegram alerts for same receiving" flood. New flow:
     *   1. Skip POs that already have a PO_RECEIVED row in ap_activity_log
     *      (last 48h, keyed by orderId in metadata).
     *   2. Write the PO_RECEIVED row BEFORE sending Telegram — so any crash
     *      after the row is written but before the alert fires doesn't get
     *      a re-send on the next tick.
     *   3. In-memory Set kept as a fast-path cache (avoid the DB read on
     *      already-seen POs within the same process), but it's no longer
     *      the source of truth.
     */
    async pollPOReceivings() {
        console.log("📦 Checking for PO receivings...");
        try {
            const received = await finaleClient.getTodaysReceivedPOs();
            if (received.length === 0) return;

            const supabase = createClient();
            // Resolve POs already alerted in the last 48h via Activity.
            // 48h window covers same-day cron ticks + the rare late-evening
            // receipt that pages into the next morning.
            const alreadyAlertedPoIds = new Set<string>();
            if (supabase) {
                try {
                    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                    const ids = received.map(po => po.orderId);
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
                if (this.seenReceivedPOIds.has(po.orderId)) continue;
                if (alreadyAlertedPoIds.has(po.orderId)) {
                    // Already alerted in a prior tick or before restart — cache locally and skip.
                    this.seenReceivedPOIds.add(po.orderId);
                    continue;
                }

                // Write Activity row FIRST so the dedup record exists even if
                // the Telegram send fails midway. Subsequent ticks will see
                // this row and skip.
                if (supabase) {
                    try {
                        await supabase.from("ap_activity_log").insert({
                            email_from: po.supplier,
                            email_subject: `PO ${po.orderId} received`,
                            intent: "PO_RECEIVED",
                            action_taken: `PO #${po.orderId} from ${po.supplier} received — $${po.total.toFixed(2)}`,
                            metadata: { poId: po.orderId, supplier: po.supplier, total: po.total },
                        });
                    } catch (err: any) {
                        console.warn(`[pollPOReceivings] Activity write failed for PO ${po.orderId}:`, err.message);
                        // Don't bail — still alert; the in-memory Set provides
                        // soft dedup within this process.
                    }
                }

                this.seenReceivedPOIds.add(po.orderId);
                // 2026-05-15: Telegram per-receiving alert removed — Activity
                // feed is the spine, daily summary rolls these up. Will's
                // ask: "Only need errors and a summary at most." The Activity
                // row written above is the audit trail; the morning summary
                // (sendDailySummary) picks up today's PO_RECEIVED rows.
            }
        } catch (err: any) {
            console.error("PO Receiving error:", err.message);
            // Errors still alert — Will explicitly kept "errors" on Telegram.
            try {
                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    `⚠️ pollPOReceivings error: ${err.message}`,
                );
            } catch { /* swallow */ }
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
     *
     * Phase 1a Task 5: AP reconciliation observability block prepended to the digest.
     */
    async sendDailySummary() {
        const dow = new Date().toLocaleString('en-US', { weekday: 'long', timeZone: 'America/Denver' });
        const isMonday = dow === 'Monday';
        const isFriday = dow === 'Friday';

        if (isMonday) {
            console.log("📊 Preparing Monday Previous-Week Review...");
        } else if (isFriday) {
            console.log("📊 Preparing Friday Weekly Wrap...");
        } else {
            console.log("📊 Preparing Daily PO Summary...");
        }

        const chatId = process.env.TELEGRAM_CHAT_ID || "";
        const blocks: string[] = [];

        // Block 1: AP reconciliation observability.
        try {
            const reconStatusModule = await import("@/lib/runtime/observability/recon-status");
            const reconStatusAny = reconStatusModule as any;
            const formatMorningApBlock =
                reconStatusModule.formatMorningApBlock ??
                reconStatusAny.default?.formatMorningApBlock ??
                reconStatusAny["module.exports"]?.formatMorningApBlock;
            if (typeof formatMorningApBlock !== "function") {
                throw new Error("formatMorningApBlock export unavailable");
            }
            const apBlock = await formatMorningApBlock();
            if (apBlock && String(apBlock).trim().length > 0) {
                blocks.push(String(apBlock).trim());
            }
        } catch (err: any) {
            console.warn("[OpsManager] AP morning block failed (non-fatal):", err.message);
            blocks.push(`📬 AP: error ${err.message}`);
        }

        // Block 2: POs in flight — count by lifecycle stage.
        try {
            const purchases = await loadActivePurchases(finaleClient, 60);
            const counts = new Map<string, number>();
            for (const p of purchases) {
                const stage = (p as any).lifecycleStage || "unknown";
                counts.set(stage, (counts.get(stage) ?? 0) + 1);
            }
            const total = purchases.length;
            const lines = [`📦 *POs in flight* (${total} total)`];
            const ordered = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
            for (const [stage, count] of ordered) {
                lines.push(`  • ${stage}: ${count}`);
            }
            if (ordered.length === 0) {
                lines.push("  • none");
            }
            blocks.push(lines.join("\n"));
        } catch (err: any) {
            console.warn("[OpsManager] POs-in-flight block failed:", err.message);
            blocks.push(`📦 POs in flight: error ${err.message}`);
        }

        // Block 2.5: PO receivings in last 24h (rolls up what used to be
        // per-event Telegram pings — Activity is the spine, this block is
        // the daily digest).
        try {
            const supabase = createClient();
            if (supabase) {
                const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
                const { data } = await supabase
                    .from("ap_activity_log")
                    .select("metadata")
                    .eq("intent", "PO_RECEIVED")
                    .gte("created_at", since)
                    .limit(100);
                const rows = (data ?? []) as Array<{ metadata: any }>;
                if (rows.length === 0) {
                    blocks.push("📦 *Received today*: none");
                } else {
                    const totalValue = rows.reduce((s, r) => s + (Number(r.metadata?.total) || 0), 0);
                    const sample = rows.slice(0, 3).map(r => `  • PO #${r.metadata?.poId} — ${r.metadata?.supplier ?? "?"} ($${(Number(r.metadata?.total) || 0).toFixed(0)})`);
                    const more = rows.length > 3 ? `\n  • …+${rows.length - 3} more` : "";
                    blocks.push(`📦 *Received today* (${rows.length}, $${totalValue.toFixed(0)})\n${sample.join("\n")}${more}`);
                }
            }
        } catch (err: any) {
            console.warn("[OpsManager] Receivings block failed:", err.message);
        }

        // Block 3: Builds today (next 24h).
        try {
            const calendar = new CalendarClient();
            const events = await calendar.getAllUpcomingBuilds(2);
            const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD
            const tomorrow = new Date(Date.now() + 86400000)
                .toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const todays = events.filter(e => e.startDate === today || e.startDate === tomorrow);
            if (todays.length === 0) {
                blocks.push(`🏗 *Builds today*: none scheduled in the next 24h`);
            } else {
                const sample = todays.slice(0, 3).map(e => `  • ${e.startDate}: ${e.title || "(untitled)"}`);
                const more = todays.length > 3 ? `\n  • …+${todays.length - 3} more` : "";
                blocks.push(`🏗 *Builds today* (${todays.length} in next 24h)\n${sample.join("\n")}${more}`);
            }
        } catch (err: any) {
            console.warn("[OpsManager] Builds-today block failed:", err.message);
            blocks.push(`🏗 Builds today: not available (${err.message})`);
        }

        // Block 4: Tasks awaiting Will.
        try {
            const needs = await agentTask.listTasks({ status: ["NEEDS_APPROVAL"], limit: 200 });
            const failedWill = (await agentTask.listTasks({ status: ["FAILED"], owner: "will", limit: 200 })) ?? [];
            const total = needs.length + failedWill.length;
            const lines = [`✋ *Tasks awaiting Will* (${total} total)`];
            if (total === 0) {
                lines.push("  • inbox clear");
            } else {
                if (needs.length > 0) lines.push(`  • needs approval: ${needs.length}`);
                if (failedWill.length > 0) lines.push(`  • failed (Will-owned): ${failedWill.length}`);
                const top = [...needs, ...failedWill].slice(0, 3);
                for (const t of top) {
                    const goal = String((t as any).goal || (t as any).type || "task").slice(0, 80);
                    lines.push(`    – ${goal}`);
                }
            }
            blocks.push(lines.join("\n"));
        } catch (err: any) {
            console.warn("[OpsManager] Tasks-awaiting-Will block failed:", err.message);
            blocks.push(`✋ Tasks awaiting Will: error ${err.message}`);
        }

        // Assemble + cap under ~3000 chars, then send as a single Telegram message.
        let body = blocks.join("\n\n");
        const MAX_CHARS = 3000;
        if (body.length > MAX_CHARS) {
            body = body.slice(0, MAX_CHARS - 20) + "\n…(truncated)";
        }
        if (chatId && body.length > 0) {
            try {
                await this.bot.telegram.sendMessage(chatId, body, { parse_mode: "Markdown" });
            } catch (err: any) {
                console.warn("[OpsManager] daily summary send failed, retrying without markdown:", err.message);
                try {
                    await this.bot.telegram.sendMessage(chatId, body);
                } catch (err2: any) {
                    console.error("[OpsManager] daily summary send failed completely:", err2.message);
                }
            }
        }
    }

    /**
     * Send weekly summary report to Telegram (8:01 AM Fridays).
     * Detailed trend analysis — complements the Friday daily summary.
     */
    async sendWeeklySummary() {
        console.log("📊 Preparing Weekly Summary (Aria vs Finale retro)...");
        try {
            const { summarizeAriaVsFinale } = await import("../purchasing/calibration-engine");
            const summary = await summarizeAriaVsFinale(7);
            const chatId = process.env.TELEGRAM_CHAT_ID || "";

            if (summary.totalSamples === 0) {
                if (chatId) {
                    await this.bot.telegram.sendMessage(chatId,
                        "📊 *Weekly Reorder Retro*\n\nNo calibrated recommendations in the last 7 days yet — calibration loop needs received POs to score against. Check back next week.",
                        { parse_mode: "Markdown" }
                    );
                }
                return;
            }

            const lines: string[] = [];
            lines.push("📊 *Weekly Reorder Retro — Aria vs Finale*");
            lines.push(`Calibrated samples: ${summary.totalSamples} (${summary.coveredSamples} comparable to Finale)`);
            if (summary.medianAriaErrorPct != null) {
                lines.push(`Aria median error: ${summary.medianAriaErrorPct >= 0 ? "+" : ""}${summary.medianAriaErrorPct.toFixed(0)}%`);
            }
            if (summary.medianFinaleErrorPct != null) {
                lines.push(`Finale median error: ${summary.medianFinaleErrorPct >= 0 ? "+" : ""}${summary.medianFinaleErrorPct.toFixed(0)}%`);
            }
            lines.push(`Aria under Finale: ${summary.ariaUnderFinaleCount} · Aria over: ${summary.ariaOverFinaleCount}`);

            if (summary.bestAriaWins.length > 0) {
                lines.push("\n*Best Aria wins (saved over Finale):*");
                for (const w of summary.bestAriaWins.slice(0, 3)) {
                    lines.push(`  • ${w.productId} (${w.vendorName ?? "?"}) — Aria ${w.ariaErrorPct >= 0 ? "+" : ""}${w.ariaErrorPct}% vs Finale ${w.finaleErrorPct >= 0 ? "+" : ""}${w.finaleErrorPct}%`);
                }
            }
            if (summary.worstAriaMisses.length > 0) {
                lines.push("\n*Worst Aria misses (>=25% error):*");
                for (const m of summary.worstAriaMisses.slice(0, 3)) {
                    lines.push(`  • ${m.productId} (${m.vendorName ?? "?"}) — recommended ${m.recommendedQty}, actual ${m.actualConsumed} (${m.errorPct >= 0 ? "+" : ""}${m.errorPct}%)`);
                }
            }

            if (chatId) {
                await this.bot.telegram.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
            }
        } catch (err: any) {
            console.error("[weekly-summary] failed:", err.message);
        }
    }

    /**
     * Phase 2/3 calibration loop. Runs daily at 8:30 AM. Each step is
     * best-effort — none should be allowed to block the others.
     */
    async runQtyCalibration() {
        const { attachReceivedPOsToRecommendations, recomputeVendorCalibrationStats } = await import("../purchasing/calibration-engine");
        const { cleanupExpiredReservations } = await import("../purchasing/calibration");

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
     */
    async syncPOConversations() {
        console.log("📦 Syncing PO Conversations...");
        const trackingUpdatesBatch: Array<{ poNumber: string; vendorName: string; newOnes: string[] }> = [];
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
                let firstResponderAddress: string | null = null;

                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    const msgTime = parseInt(msg.internalDate!);
                    if (!from.includes("buildasoil.com")) {
                        if (!responseAt) {
                            responseAt = msgTime;
                            responseTimeMins = Math.round((responseAt - sentAt) / 1000 / 60);
                            // Pull just the address out of "Name <addr@host>" or "addr@host"
                            const addrMatch = from.match(/<([^>]+)>/) ?? from.match(/([^\s<>"',]+@[^\s<>"',]+)/);
                            if (addrMatch) firstResponderAddress = addrMatch[1].trim();
                        }
                        lastVendorMsgAt = msgTime;
                    } else if (lastVendorMsgAt && !humanReplyDetectedAt) {
                        humanReplyDetectedAt = new Date(msgTime).toISOString();
                    }
                }

                // Extract tracking + ETA from vendor replies. We gather one
                // representative vendor-reply body so the LLM ETA extractor
                // sees the most-recent vendor message (likely to contain the
                // current ship promise).
                let firstVendorBody: string | null = null;
                let firstVendorSubject: string | null = null;
                for (const msg of thread.messages) {
                    const bodyParts: string[] = [msg.snippet || ''];
                    if (msg.payload?.body?.data) bodyParts.push(_decodeGmailBody(msg.payload.body.data));
                    if (msg.payload?.parts) _walkMsgParts(msg.payload.parts, bodyParts);
                    const bodyText = bodyParts.join('\n');
                    const fromH = msg.payload?.headers?.find(h => h.name === 'From')?.value || '';
                    if (firstVendorBody == null && !fromH.toLowerCase().includes('buildasoil.com')) {
                        firstVendorBody = bodyText;
                        firstVendorSubject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || null;
                    }
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

                // Verify PO send + alert on tracking — best-effort, Supabase may be offline
                if (supabase) {
                    try {
                        const { data: existing } = await supabase
                            .from("purchase_orders")
                            .select("tracking_numbers, po_sent_verified_at, po_sent_verified_source, po_sent_verified_evidence, vendor_stated_eta_extracted_at")
                            .eq("po_number", poNumber)
                            .maybeSingle();
                        const oldTracking = existing?.tracking_numbers || [];
                        const newOnes = trackingNumbers.filter(t => !oldTracking.includes(t));

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

                        // Close the read↔write loop: every vendor reply on a PO thread
                        // counts as an acknowledgment, even when no tracking numbers
                        // landed in it. The Purchases panel reads vendor_acknowledged_at
                        // to render the "✓ Vendor ack" chip.
                        if (responseAt) {
                            upsert.vendor_acknowledged_at = new Date(responseAt).toISOString();
                            upsert.vendor_ack_source = 'thread_reply';
                        }
                        if (humanReplyDetectedAt) {
                            upsert.human_reply_detected_at = humanReplyDetectedAt;
                        }

                        // LLM ETA extraction — only when we have a fresh vendor reply
                        // body and the PO doesn't already have a recent extracted ETA.
                        const existingEta = (existing as any)?.vendor_stated_eta_extracted_at;
                        const tooRecent = existingEta && (Date.now() - new Date(existingEta).getTime()) < 5 * 86_400_000;
                        if (firstVendorBody && responseAt && !tooRecent) {
                            try {
                                const { extractETAFromText } = await import('@/lib/purchasing/eta-extractor');
                                const eta = await extractETAFromText({
                                    body: firstVendorBody,
                                    subject: firstVendorSubject ?? undefined,
                                });
                                if (eta.confidence !== 'low' && (eta.etaDate || eta.shipDate)) {
                                    upsert.vendor_stated_eta = eta.etaDate;
                                    upsert.vendor_stated_ship_date = eta.shipDate;
                                    upsert.vendor_stated_eta_confidence = eta.confidence;
                                    upsert.vendor_stated_eta_extracted_at = new Date().toISOString();
                                    upsert.vendor_stated_eta_rationale = eta.rationale;
                                }
                            } catch (etaErr: any) {
                                console.warn('[po-sync] ETA extract failed:', etaErr?.message ?? etaErr);
                            }
                        }

                        if (!alreadyHighConfidence && sentISO) {
                            const evidence = {
                                type: "po_send",
                                source: "gmail_outbox",
                                at: sentISO,
                                detail: `label:PO outbox — ${subject}`,
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

                        // Self-correcting routing: a vendor replied → trust the
                        // responder address as the new orders_email. Skips noisy
                        // re-confirms, self-addresses, manual overrides.
                        if (responseAt && firstResponderAddress && vendorName) {
                            try {
                                const { recordVendorOrdersEmailFromReply } = await import("@/lib/purchasing/po-sender");
                                const r = await recordVendorOrdersEmailFromReply(vendorName, firstResponderAddress);
                                if (r.updated) {
                                    console.log(`[po-sync] orders_email ${r.reason} for ${vendorName} → ${firstResponderAddress.toLowerCase()}`);
                                }
                            } catch (err: any) {
                                console.warn(`[po-sync] orders_email write-back failed for ${vendorName}: ${err?.message ?? err}`);
                            }
                        }

                        // Batch tracking updates into a single end-of-run message
                        // instead of one Telegram per PO. trackingUpdatesBatch is
                        // collected and flushed below.
                        if (newOnes.length > 0) {
                            trackingUpdatesBatch.push({ poNumber, vendorName, newOnes });
                        }
                    } catch { /* Supabase offline */ }
                }
            }

            // Flush tracking-updates batch as ONE Telegram message at the end
            // of the run. Was firing one message per PO per cycle — too noisy.
            if (trackingUpdatesBatch.length > 0) {
                const lines = trackingUpdatesBatch.map(b =>
                    `• #${b.poNumber} ${b.vendorName}: ${b.newOnes.join(', ')}`
                );
                const msg = `📦 *Tracking Updates* (${trackingUpdatesBatch.length})\n\n${lines.join('\n')}`;
                try {
                    await this.bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID || "", msg, { parse_mode: 'Markdown' });
                } catch (e: any) {
                    console.warn('[po-sync] tracking batch send failed:', e.message);
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
