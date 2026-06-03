import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { getLocalDb, dedupSeen, dedupMark, dedupCount } from "../storage/local-db";
import { type ScheduledTask } from "node-cron";
import { Telegraf } from "telegraf";
import { WebClient } from "@slack/web-api";
import { SYSTEM_PROMPT } from "../../config/persona";
import { indexOperationalContext } from "./pinecone";
import { unifiedTextGeneration } from "./llm";
import { OversightAgent } from "./oversight-agent";
import { SupervisorAgent } from "./supervisor-agent";
import { CommsService } from "./services/comms-service";
import { POService } from "./services/po-service";
import { APService } from "./services/ap-service";
import { APIdentifierAgent } from "./workers/ap-identifier";
import { EmailIngestionWorker } from "./workers/email-ingestion";
import { APForwarderAgent } from "./workers/ap-forwarder";
import { TrackingAgent } from "./tracking-agent";
import { AcknowledgementAgent } from "./acknowledgement-agent";
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
} from "../carriers/tracking-service";
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
} from "../scheduler/cron-registry";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { listShipmentsForPurchaseOrders, upsertShipmentEvidence } from "../tracking/shipment-intelligence";
import { runEmailPollingCycle } from "./email-polling-cycle";
import { memoryLayerManager } from "./memory-layer-manager";
import { runBuildRiskAnalysis } from "../builds/build-risk";
import { leadTimeService } from "../builds/lead-time-service";

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
    private commsService: CommsService;
    private poService: POService;
    private apService: APService;
    private agentName = "ops-manager";
    // KAIZEN(2026-05-29): In-memory dedup Sets replaced with SQLite dedup_cache.
    // dedupSeen() / dedupMark() from local-db.ts. Survives restarts, no boot
    // hydration needed. Namespaces: 'build_completions' (90d TTL), 'received_pos' (7d TTL).
    // Previously these were private Sets hydrated from Supabase on startup.

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
            console.warn("\u26a0\ufe0f OpsManager: SLACK_BOT_TOKEN not set \u2014 Slack cross-posting disabled.");
        }

        // Initialize dedicated AP agents
        this.apIdentifier = new APIdentifierAgent(bot);
        this.emailIngestionDefault = new EmailIngestionWorker("default");
        this.emailIngestionAP = new EmailIngestionWorker("ap");
        this.apForwarder = new APForwarderAgent(bot);
        this.trackingAgent = new TrackingAgent();
        this.ackAgent = new AcknowledgementAgent("default");
        this.supervisor = new SupervisorAgent(bot);

        // Initialize OversightAgent FIRST — other services depend on it
        this.oversightAgent = new OversightAgent();

        // Initialize service layer for focused responsibilities
        this.commsService = new CommsService(bot);
        this.poService = new POService(bot);
        this.apService = new APService(
            this.apIdentifier,
            this.emailIngestionDefault,
            this.emailIngestionAP,
            this.apForwarder,
            this.ackAgent,
            this.oversightAgent,
        );
        this.registerOversightRecoveries();

        // HERMIA(2026-05-28): Detect crash loops on boot — alerts Will via Telegram
        // if aria-bot restarted 3+ times in 5 minutes.
        import("@/lib/ops/crash-loop-detector").then(
            ({ detectAndAlertCrashLoop }) => detectAndAlertCrashLoop(this.bot).catch(() => {}),
        ).catch(() => {});

        // KAIZEN(2026-05-29): Dedup now handled by SQLite dedup_cache.
        // No boot hydration needed — DB queries check historical entries directly.
        const buildCount = dedupCount("build_completions");
        if (buildCount > 0) {
            console.log(`\u{1F528} Loaded ${buildCount} dedup entries for build_completions from SQLite`);
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
        // HERMIA(2026-05-29): Bridge outcomes to orchestrator agent registry
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
            // HERMIA(2026-06-03): await — supervisor.reportAgentException is now
            // async (writes to ops_agent_exceptions table). Fire-and-forget was
            // the pre-refactor contract when it was a no-op; now it can throw
            // async (e.g. supabase insert error), and the surrounding try/catch
            // only catches sync throws. Awaiting here surfaces any error to the
            // existing warn-log. The function itself swallows + logs its own
            // errors, so this catch is purely defensive.
            await this.supervisor.reportAgentException(taskName, error);
        } catch (e: any) {
            console.warn(`[ops-manager] cronHookFailure(${taskName}) supervisor escalate failed: ${e.message}`);
        }
    }

    private async safeRun(taskName: string, task: () => Promise<any> | any) {
        const startTime = performance.now();
        let cronRunId: number | null = null;
        const startedAtIso = new Date().toISOString();

        // Record start in cron_runs (fire-and-forget — don\'t block the task)
        try {
            const supabase = createClient();
            if (supabase) {
                const { data } = await supabase.from("cron_runs").insert({
                    task_name: taskName,
                    status: "running",
                }).select("id").single();
                cronRunId = data?.id ?? null;
            }
        } catch { /* non-critical */ }

        try {
            await task();

            const durationMs = Math.round(performance.now() - startTime);
            recordCronRun(taskName, durationMs, "success");

            // Update cron_runs with success
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    if (supabase) {
                        await supabase.from("cron_runs").update({
                            finished_at: new Date().toISOString(),
                            duration_ms: durationMs,
                            status: "success",
                        }).eq("id", cronRunId);
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
            recordCronRun(taskName, durationMs, "error", error.message);

            // Update cron_runs with failure
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    if (supabase) {
                        await supabase.from("cron_runs").update({
                            finished_at: new Date().toISOString(),
                            duration_ms: durationMs,
                            status: "error",
                            error_message: error.message,
                        }).eq("id", cronRunId);
                    }
                } catch { /* non-critical */ }

                // Mirror to control-plane hub. Failure-only — successful runs do not
                // generate hub rows by design.
                try {
                    const task = await agentTask.incrementOrCreate({
                        sourceTable: "cron_runs",
                        sourceId: String(cronRunId),
                        type: "cron_failure",
                        goal: `Cron ${taskName} failed: ${String(error?.message || error).slice(0, 120)}`,
                        status: "FAILED",
                        owner: "aria",
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
                        await supabase.from("cron_runs")
                            .update({ task_id: task.id })
                            .eq("id", cronRunId);
                    }
                } catch { /* hub write is best-effort */ }
            }

            console.error(`\u274c Cron Task Failed: ${taskName}`, error.message);
            // Escalate to Supervisor (fire-and-forget; reportAgentException
            // swallows its own errors so this cannot reject — but we add
            // .catch defensively to silence any future contract change)
            this.supervisor.reportAgentException(taskName, error).catch((e: any) => {
                console.warn(`[ops-manager] safeRun(${taskName}) supervisor escalate failed: ${e.message}`);
            });
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
     * backward compatibility with callers like start-bot.ts.
     */
    registerJobs() {
        // Intentionally empty. See src/cron/jobs/index.ts.
        console.log("\u2705 OpsManager: cron registration delegated to src/cron/jobs.");
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

    // ════════════════════════════════════════════════════════════════════════
    // PO Service Delegation Gateway
    // All PO operations are delegated to POService (Phase 2/3 extraction).
    // ════════════════════════════════════════════════════════════════════════

    public async runPOAutoCompleteWatcher(): Promise<void> {
        return this.poService.runPOAutoCompleteWatcher();
    }

    public async runPOArrivalRiskCheck(): Promise<void> {
        return this.poService.runPOArrivalRiskCheck();
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
        return this.poService.runPOSweep();
    }

    /** Vendor reconciliation wrappers. */
    public async runReconcileAxiom(): Promise<void> {
        return this.poService.runReconcileAxiom();
    }
    public async runReconcileFedEx(): Promise<void> {
        return this.poService.runReconcileFedEx();
    }
    public async runReconcileTeraGanix(): Promise<void> {
        return this.poService.runReconcileTeraGanix();
    }
    public async runReconcileULINE(): Promise<void> {
        return this.poService.runReconcileULINE();
    }

    /** Purchasing calendar sync wrapper (60-day window). */
    public async runPurchasingCalendarSync(): Promise<void> {
        return this.poService.runPurchasingCalendarSync();
    }

    /** Watchdog: alert if any vendor hasn\'t had a successful reconciliation run in 24h. */
    async checkMissingReconciliationRuns(): Promise<void> {
        return this.poService.checkMissingReconciliationRuns();
    }

    /**
     * Periodically poll AP inbox for new invoices.
     * Delegates to APService.
     */
    async pollAPInbox() {
        return this.apService.pollAPInbox();
    }

    /**
     * Daily Build Risk Analysis.
     * DECISION(2026-04-14): saveBuildRiskSnapshot call added — was missing,
     * so dashboard BuildRiskPanel/BuildSchedulePanel never had any data to show
     * (they read from build_risk_snapshots, which only got written by /buildrisk
     * command, never by the 7:30 AM cron).
     */
    async runDailyBuildRisk() {
        console.log("\u{1F4E6} Running Daily Build Risk Analysis...");
        try {
            const results = await runBuildRiskAnalysis();
            const { saveBuildRiskSnapshot } = await import("../builds/build-risk-logger");
            await saveBuildRiskSnapshot(results);
        } catch (err: any) {
            console.error("Build Risk error:", err.message);
        }
    }

    /**
     * Enqueue work for Nightshift hosted classification.
     */
    async enqueueNightshiftWork() {
        console.log("\u{1F319} Enqueuing work for Nightshift...");
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
        console.log("\u{1F9E0} Indexing operational context...");
        try {
            await indexOperationalContext();
        } catch (err: any) {
            console.error("Indexing error:", err.message);
        }
    }

    /**
     * Poll Finale for newly completed production builds.
     * Delegates to POService.
     */
    async pollBuildCompletions() {
        return this.poService.pollBuildCompletions();
    }

    /**
     * Poll Finale for today\'s received POs.
     * Delegates to POService.
     */
    async pollPOReceivings() {
        return this.poService.pollPOReceivings();
    }

    /**
     * Main Purchasing Calendar Sync Loop.
     * Delegates to POService.
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number; cleared: number }> {
        return this.poService.syncPurchasingCalendar(daysBack);
    }

    /**
     * Send daily summary report to Telegram.
     * Delegates to commsService for domain-specific logic.
     * Schedule: Mon-Fri only (no weekends).
     */
    async sendDailySummary() {
        return this.commsService.sendDailySummary();
    }

    /**
     * Send weekly summary report to Telegram (8:01 AM Fridays).
     * Delegates to commsService for domain-specific logic.
     */
    async sendWeeklySummary() {
        return this.commsService.sendWeeklySummary();
    }

    /**
     * Phase 2/3 calibration loop. Runs daily at 8:30 AM.
     * Delegates to POService.
     */
    async runQtyCalibration() {
        return this.poService.runQtyCalibration();
    }

    /**
     * Sync PO conversations with Gmail threads.
     * Delegates to POService.
     */
    async syncPOConversations() {
        return this.poService.syncPOConversations();
    }
}
