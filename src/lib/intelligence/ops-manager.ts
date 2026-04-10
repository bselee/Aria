/**
 * @file    ops-manager.ts
 * @purpose Handles background operations: PO tracking, email filtering, summaries,
 *          and daily Calendar BOM build risk analysis.
 *          Cross-posts daily/weekly summaries to both Telegram and Slack #purchasing.
 *          Posts completed build notifications to the MFG Google Calendar.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-18
 * @deps    googleapis, node-cron, telegraf, @slack/web-api, builds/build-risk
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import cron from "node-cron";
import { Telegraf } from "telegraf";
import { WebClient } from "@slack/web-api";
import { SYSTEM_PROMPT } from "../../config/persona";
import { indexOperationalContext } from "./pinecone";
import { unifiedTextGeneration } from "./llm";
import { runBuildRiskAnalysis } from "../builds/build-risk";
import { leadTimeService } from "../builds/lead-time-service";
import { APAgent } from "./ap-agent";
import { APIdentifierAgent } from "./workers/ap-identifier";
import { EmailIngestionWorker } from "./workers/email-ingestion";
import { APForwarderAgent } from "./workers/ap-forwarder";
import { TrackingAgent } from "./tracking-agent";
import { AcknowledgementAgent } from "./acknowledgement-agent";
import { SupervisorAgent } from "./supervisor-agent";
import { processQueuedStatementRun } from "../statements/service";
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../google/calendar";
import type { FullPO } from "../finale/client";
import { BuildParser } from "./build-parser";
import { FinaleClient, finaleClient } from "../finale/client";
import FirecrawlApp from "@mendable/firecrawl-js";
import { generateSelfReview, syncLearningsToMemory, runHousekeeping } from "./feedback-loop";
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
import { scanAxiomDemand } from "../purchasing/axiom-scanner";
import {
    RECEIVED_CALENDAR_RETENTION_DAYS,
    RECEIVED_DASHBOARD_RETENTION_DAYS,
    derivePurchasingLifecycle,
    getPurchasingEventDate,
    shouldKeepReceivedPurchase,
} from "../purchasing/calendar-lifecycle";
import { loadActivePurchases } from "../purchasing/active-purchases";
import { loadPOCompletionSignalIndex } from "../purchasing/po-completion-loader";
import { derivePOCompletionState } from "../purchasing/po-completion-state";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "../purchasing/po-receipt-state";
import { syncRecommendationFeedbackForPurchaseOrders } from "../purchasing/recommendation-feedback-sync";
import { derivePOLifecycleState, shouldRequestTrackingFollowUp, getFollowUpTemplate, getFollowUpTemplateL2, shouldUseL2FollowUp } from "../purchasing/derive-po-lifecycle";
import { enqueueEmailClassification, generateMorningHandoff } from "./nightshift-agent";
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
    private slack: WebClient | null;
    private slackChannel: string;
    private apAgent: APAgent;
    private apIdentifier: APIdentifierAgent;
    private emailIngestionDefault: EmailIngestionWorker;
    private emailIngestionAP: EmailIngestionWorker;
    private apForwarder: APForwarderAgent;
    private trackingAgent: TrackingAgent;
    private ackAgent: AcknowledgementAgent;
    private supervisor: SupervisorAgent;
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

    constructor(bot: Telegraf) {
        this.bot = bot;

        // DECISION(2026-02-25): Initialize Slack client alongside Telegram.
        // Slack posting is best-effort â€” if SLACK_BOT_TOKEN is missing, we
        // gracefully skip Slack without blocking the Telegram message.
        const slackToken = process.env.SLACK_BOT_TOKEN;
        this.slack = slackToken ? new WebClient(slackToken) : null;
        this.slackChannel = process.env.SLACK_MORNING_CHANNEL || "#purchasing";

        if (!this.slack) {
            console.warn("âš ï¸ OpsManager: SLACK_BOT_TOKEN not set â€” Slack cross-posting disabled.");
        }

        // Initialize dedicated AP agents
        this.apAgent = new APAgent(bot);
        this.apIdentifier = new APIdentifierAgent(bot);
        this.emailIngestionDefault = new EmailIngestionWorker("default");
        this.emailIngestionAP = new EmailIngestionWorker("ap");
        this.apForwarder = new APForwarderAgent();
        this.trackingAgent = new TrackingAgent();
        this.ackAgent = new AcknowledgementAgent("default");
        this.supervisor = new SupervisorAgent(bot);
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

        // Record start in cron_runs (fire-and-forget â€” don't block the task)
        try {
            const supabase = createClient();
            const { data } = await supabase.from('cron_runs').insert({
                task_name: taskName,
                status: 'running',
            }).select('id').single();
            cronRunId = data?.id ?? null;
        } catch { /* non-critical */ }

        try {
            await task();

            const durationMs = Math.round(performance.now() - startTime);
            recordCronRun(taskName, durationMs, 'success');

            // Update cron_runs with success
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    await supabase.from('cron_runs').update({
                        finished_at: new Date().toISOString(),
                        duration_ms: durationMs,
                        status: 'success',
                    }).eq('id', cronRunId);
                } catch { /* non-critical */ }
            }
        } catch (error: any) {
            const durationMs = Math.round(performance.now() - startTime);
            recordCronRun(taskName, durationMs, 'error', error.message);

            console.error(`ðŸš¨ [${taskName}] Crashed after ${durationMs}ms. Handing to Supervisor...`, error.message);

            // Update cron_runs with error
            if (cronRunId) {
                try {
                    const supabase = createClient();
                    await supabase.from('cron_runs').update({
                        finished_at: new Date().toISOString(),
                        duration_ms: durationMs,
                        status: 'error',
                        error_message: error.message || 'Unknown error',
                    }).eq('id', cronRunId);
                } catch { /* non-critical */ }
            }

            try {
                // Hand over to the exceptions queue
                const supabase = createClient();
                await supabase.from('ops_agent_exceptions').insert({
                    agent_name: taskName,
                    error_message: error.message || "Unknown error",
                    error_stack: error.stack || ""
                });
            } catch (queueErr) {
                console.error(`     âŒ Failed to write crash exception for ${taskName} to DB:`, queueErr);

                // Absolute fallback in case the DB is down
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId && this.bot) {
                    await this.bot.telegram.sendMessage(
                        chatId,
                        `ðŸš¨ <b>DB Unavailable - Crash Escalation</b> ðŸš¨\n\n<b>Agent:</b> ${taskName}\n<b>Error:</b> ${error.message}`,
                        { parse_mode: 'HTML' }
                    ).catch(() => { });
                }
            }
        }
    }

    getCronStatus(): Map<string, CronRunStatus> {
        return getAllCronRunStatuses();
    }

    /**
     * Returns the full HTML-formatted cron status report for Telegram.
     */
    getCronStatusReport(): string {
        return formatCronStatusReport();
    }

    /**
     * Returns a one-line compact status summary.
     */
    getCronCompactStatus(): string {
        return formatCompactStatus();
    }

    /**
     * Start all scheduled tasks
     */
    start() {
        console.log("ðŸš€ Starting Ops Manager Scheduler...");

        // Hydrate dedup Sets from Supabase/Finale so a restart doesn't re-alert on
        // builds completed or POs received in the last 2 hours.
        this.hydrateSeenSets().catch(err =>
            console.warn('[ops-manager] hydrateSeenSets failed (non-fatal):', err.message)
        );

        // DECISION(2026-04-01): ALL cron.schedule calls MUST include { timezone: "America/Denver" }.
        // node-cron 4.x has a bug where non-timezone heartbeat chains silently die at midnight
        // date rollover. Timezone-aware tasks use a different code path that survives.
        const TZ = { timezone: "America/Denver" } as const;

        // Supervisor checking errors
        cron.schedule("*/5 * * * *", () => {
            this.safeRun("Supervisor", () => this.supervisor.supervise());
        }, TZ);

        // Email Ingestion Worker grabs raw emails from Gmail to Supabase queue
        cron.schedule("*/5 * * * *", () => {
            this.safeRun("EmailIngestionDefault", () => this.emailIngestionDefault.run(50));
        }, TZ);

        // AP Email Ingestion â€” twice daily at 8 AM and 2 PM weekdays
        // DECISION(2026-03-18): Limited to 2x/day to avoid overwhelming the Google
        // API. The AP inbox receives far less volume than the default inbox, so
        // twice-daily polling is sufficient. Token guard prevents silent failures
        // until token-ap.json is created via: npx tsx src/cli/gmail-auth.ts ap
        cron.schedule("0 8,14 * * 1-5", () => {
            const apTokenPath = path.join(process.cwd(), 'token-ap.json');
            if (fs.existsSync(apTokenPath)) {
                this.safeRun("EmailIngestionAP", () => this.emailIngestionAP.run(50));
            }
        }, { timezone: "America/Denver" });

        // AP Identifier scans for unread PDFs every 15 minutes and queues them
        cron.schedule("*/15 * * * *", () => {
            this.safeRun("APIdentifierAgent", () => this.apIdentifier.identifyAndQueue());
        }, TZ);

        // AP Forwarder ships queued invoices to Bill.com every 15 minutes
        cron.schedule("2-59/15 * * * *", () => {
            this.safeRun("APForwarderAgent", () => this.apForwarder.processPendingForwards());
        }, TZ);

        // Statement reconciliation worker polls dashboard-launched runs
        cron.schedule("*/5 * * * *", () => {
            this.safeRun("StatementReconciliationAgent", async () => {
                await processQueuedStatementRun(async (message) => {
                    const chatId = process.env.TELEGRAM_CHAT_ID;
                    if (!chatId) return;
                    await this.bot.telegram.sendMessage(chatId, message);
                });
            });
        }, TZ);

        // Acknowledgement Agent runs every 12 minutes to routinely thank vendors
        cron.schedule("*/12 * * * *", () => {
            this.safeRun("AcknowledgementAgent", () => this.ackAgent.processUnreadEmails(20));
        }, TZ);

        // Daily Summary @ 8:00 AM weekdays only
        cron.schedule("0 8 * * 1-5", () => {
            this.safeRun("DailySummary", () => this.sendDailySummary());
        }, { timezone: "America/Denver" });

        // DECISION(2026-03-19): Active Purchases Ledger cron REMOVED.
        // DECISION(2026-03-20): Also removed from unified OOS Digest post per Will.
        // Active Purchases remain available via Dashboard only.

        // Friday Summary @ 8:01 AM
        cron.schedule("1 8 * * 5", () => {
            this.safeRun("WeeklySummary", () => this.sendWeeklySummary());
        }, { timezone: "America/Denver" });

        // â”€â”€ AXIOM LABEL SCANNER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // DECISION(2026-03-17): Runs purely autonomously to identify label demand
        // and add them to the queue for review on the dashboard.
        cron.schedule("15 8 * * 1-5", () => {
            this.safeRun("AxiomDemandScan", () => this.runAxiomDemandScan());
        }, { timezone: "America/Denver" });

        // â”€â”€ ULINE FRIDAY AUTO-ORDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // DECISION(2026-03-16): Fully autonomous ULINE ordering pipeline.
        // Runs every Friday at 8:30 AM Denver time. Flow:
        //   1. Scan Finale purchasing intelligence for ULINE items below reorder threshold
        //   2. Create a draft PO in Finale with those items
        //   3. Open Chrome â†’ fill ULINE Quick Order cart via Paste Items
        //   4. Send Telegram notification with full manifest
        // Will just needs to review the cart and click checkout.
        // If zero items need reordering, sends a brief "all stocked" message.
        cron.schedule("30 8 * * 5", () => {
            this.safeRun("UlineFridayOrder", () => this.runFridayUlineOrder());
        }, { timezone: "America/Denver" });

        // Purchasing Intelligence Pipeline at 9:00 AM Mon-Fri
        cron.schedule("0 9 * * 1-5", () => {
          this.safeRun("PurchasingPipeline", async () => {
            const { runPurchasingIntelligence } = await import('./purchasing-pipeline');
            await runPurchasingIntelligence({ source: 'cron', triggeredBy: 'cron' });
          });
        }, { timezone: "America/Denver" });

        // Email Maintenance (Advertisements) every hour
        cron.schedule("0 * * * *", () => {
            this.safeRun("AdMaintenance", () => this.processAdvertisements());
        }, TZ);

        // Tracking Agent polls processing queue every 60 minutes
        cron.schedule("0 * * * *", () => {
            this.safeRun("TrackingAgent", () => this.trackingAgent.processUnreadEmails());
        }, TZ);

        // Background Shipment API Refresh every 15 minutes
        cron.schedule("*/15 * * * *", () => {
            this.safeRun("ShipmentRefreshWorker", async () => {
                const { refreshActiveShipmentsBackgroundJob } = await import("../tracking/shipment-intelligence");
                await refreshActiveShipmentsBackgroundJob();
            });
        }, TZ);

        // Slack Tracking ETA Sync every 2 hours
        // DECISION(2026-03-18): Pushes live freight tracking ETAs directly into the
        // corresponding Slack Watchdog threads where Will or coworkers originally asked.
        cron.schedule("0 */2 * * *", () => {
            this.safeRun("SlackETASync", () => this.pollSlackETAUpdates());
        }, TZ);

        // PO Sync every 30 minutes
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("POSync", () => this.syncPOConversations());
        }, TZ);

        // PO-First AP Sweep (invoice reconciliation backfill) every 4 hours
        // DECISION(2026-03-18): Provides a fallback net for invoices that couldn't be
        // matched at ingestion time due to missing PO data or delay in Finale commitment.
        cron.schedule("30 */4 * * *", () => {
            this.safeRun("POSweep", () => runPOSweep(60, false));
        }, TZ);

        // â”€â”€ VENDOR RECONCILIATIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // DECISION(2026-03-18): Scheduling automated vendor reconciliations for Axiom,
        // FedEx, TeraGanix, and ULINE. Scheduled sequentially in the early AM hours
        // on weekdays to avoid interfering with Will's active Chrome sessions,
        // especially for Playwright-based scrapers like ULINE.
        
        // Axiom Reconciliation @ 1:00 AM Weekdays
        cron.schedule("0 1 * * 1-5", () => {
            this.safeRun("ReconcileAxiom", async () => {
                await this.runReconciliation("Axiom", "node --import tsx src/cli/reconcile-axiom.ts");
            });
        }, { timezone: "America/Denver" });

        // FedEx Reconciliation @ 1:30 AM Weekdays
        cron.schedule("30 1 * * 1-5", () => {
            this.safeRun("ReconcileFedEx", async () => {
                await this.runReconciliation("FedEx", "node --import tsx src/cli/reconcile-fedex.ts");
            });
        }, { timezone: "America/Denver" });

        // TeraGanix Reconciliation @ 2:00 AM Weekdays
        cron.schedule("0 2 * * 1-5", () => {
            this.safeRun("ReconcileTeraGanix", async () => {
                await this.runReconciliation("TeraGanix", "node --import tsx src/cli/reconcile-teraganix.ts");
            });
        }, { timezone: "America/Denver" });

        // ULINE Reconciliation @ 3:00 AM Weekdays
        // Needs Chrome closed. 3 AM is the safest time.
        cron.schedule("0 3 * * 1-5", () => {
            this.safeRun("ReconcileULINE", async () => {
                await this.runReconciliation("ULINE", "node --import tsx src/cli/reconcile-uline.ts");
            });
        }, { timezone: "America/Denver" });

        // Build Completion Watcher every 30 minutes
        // Polls Finale for newly-completed build orders, sends Telegram alert,
        // and appends a completion timestamp to the matching calendar event description.
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("BuildCompletionWatcher", () => this.pollBuildCompletions());
        }, TZ);

        // PO Receiving Watcher every 30 minutes
        // Polls Finale for today's newly-received purchase orders and sends Telegram alerts.
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("POReceivingWatcher", () => this.pollPOReceivings());
        }, TZ);

        // Purchasing Calendar Sync every 4 hours
        // Creates/updates calendar events for outgoing and received POs.
        // Uses 60d lookback so late/excp POs keep flowing forward each day.
        cron.schedule("0 */4 * * *", () => {
            this.safeRun("PurchasingCalendarSync", () => this.syncPurchasingCalendar(60));
        }, { timezone: "America/Denver" });

        // Morning Heartbeat @ 7:00 AM weekdays
        // DECISION(2026-03-16): After a 3-day outage with zero alerting, this
        // provides a simple "I'm alive" signal every weekday morning. If you
        // don't see this message by 7:05 AM, investigate immediately.
        cron.schedule("0 7 * * 1-5", () => {
            this.safeRun("MorningHeartbeat", async () => {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (!chatId) return;
                const mem = process.memoryUsage();
                const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
                const uptimeHrs = Math.round(process.uptime() / 3600 * 10) / 10;
                await this.bot.telegram.sendMessage(
                    chatId,
                    `â˜€ï¸ <b>Aria Morning Check-In</b>\n\n` +
                    `✅ Bot is online and healthy\n` +
                    `â± Uptime: ${uptimeHrs}h | Memory: ${heapMB}MB\n` +
                    `ðŸ“‹ Next: Build Risk (7:30), Daily Summary (8:00)`,
                    { parse_mode: "HTML" }
                );
            });
        }, { timezone: "America/Denver" });

        // Build Risk Analysis @ 7:30 AM weekdays
        // DECISION(2026-03-11): Was missing from start() despite sendBuildRiskReport()
        // being fully implemented. Caught during trigger overwatch audit.
        cron.schedule("30 7 * * 1-5", () => {
            this.safeRun("BuildRiskReport", () => this.sendBuildRiskReport());
        }, { timezone: "America/Denver" });

        // Stale Draft PO Cleanup Alert @ 9:00 AM weekdays
        // DECISION(2026-03-04): Nudges Will when draft POs sit uncommitted for >3 days.
        cron.schedule("0 9 * * 1-5", () => {
            this.safeRun("StaleDraftPOAlert", () => this.alertStaleDraftPOs());
        }, { timezone: "America/Denver" });

        // OOS Report Generator â€” polls every 5 min between 7:45â€“9:05 AM weekdays
        // DECISION(2026-03-11): Changed from fixed 8:30 cron to reactive polling.
        // Stockie email typically arrives ~8 AM. This polls every 5 min starting 7:45
        // so the report fires within minutes of arrival. The OOS-Processed label
        // prevents duplicate runs. Email is left unread for human reference.
        cron.schedule("*/5 7-9 * * 1-5", () => {
            // Runtime guard: only fire between 7:45 and 9:05 Denver time
            const now = new Date();
            const denverHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Denver' }));
            const denverMin = parseInt(now.toLocaleString('en-US', { minute: 'numeric', timeZone: 'America/Denver' }));
            const minuteOfDay = denverHour * 60 + denverMin;
            if (minuteOfDay < 7 * 60 + 45 || minuteOfDay > 9 * 60 + 5) return;

            this.safeRun("OOSReportGenerator", async () => {
                const { processStockieEmail } = await import("../reports/oos-email-trigger");
                const result = await processStockieEmail();
                if (result) {
                    const chatId = process.env.TELEGRAM_CHAT_ID;
                    if (chatId) {
                        await this.bot.telegram.sendMessage(
                            chatId,
                            `ðŸ“‹ <b>OOS Report Generated</b>\n\n` +
                            `ðŸ“Š ${result.totalItems} out-of-stock items analyzed\n` +
                            `ðŸš¨ ${result.needsOrder.length} need ordering\n` +
                            `✅ ${result.onOrder.length} on order\n` +
                            `âš ï¸ ${result.agingPOs.length} aging POs\n` +
                            `ðŸ”§ ${result.internalBuild.length} internal builds\n\n` +
                            `ðŸ“ Saved to: <code>${result.outputPath}</code>`,
                            { parse_mode: "HTML" }
                        );
                    }

                    // DECISION(2026-03-19): Single unified morning Slack post.
                    // Originally combined OOS Digest + Active Purchases into one message.
                    // DECISION(2026-03-20): Removed Active Purchases from Slack feed per Will.
                    // OOS Digest only â€” Active Purchases remain available via Dashboard.
                    if (result.slackBody) {
                        try {
                            await this.postToSlack(result.slackBody, "Morning Purchasing Digest");
                            console.log(`ðŸ“‹ [OOS] Slack morning digest posted (${result.slackBody.length} chars)`);
                        } catch (slackErr: any) {
                            console.error('âŒ Slack morning digest failed:', slackErr.message);
                        }
                    }
                }
            });
        }, { timezone: "America/Denver" });

        // AP Agent Daily Recap @ 5:00 PM MST weekdays
        // DECISION(2026-02-26): End-of-day recap provides a monitoring layer
        // so Will can review all AP Agent decisions daily. Critical during
        // early rollout to catch any misclassifications.
        cron.schedule("0 17 * * 1-5", () => {
            this.safeRun("APDailyRecap", () => this.apAgent.sendDailyRecap());
        }, { timezone: "America/Denver" });

        // â”€â”€ KAIZEN FEEDBACK LOOP CRONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        // Weekly Kaizen Self-Review â€” Fridays 8:20 AM Denver
        // DECISION(2026-03-18): Staggered from 8:15 to 8:20 to avoid collision
        // with AxiomDemandScan (8:15) and SlackPurchasesReport (8:10).
        cron.schedule("20 8 * * 5", () => this.safeRun("KaizenSelfReview", async () => {
            const report = await generateSelfReview(7);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                await this.bot.telegram.sendMessage(chatId, report, { parse_mode: "HTML" });
            }
        }), { timezone: "America/Denver" });

        // Daily Memory Sync â€” every night at 10:00 PM Denver
        cron.schedule("0 22 * * *", () => this.safeRun("KaizenMemorySync", async () => {
            const synced = await syncLearningsToMemory();
            if (synced > 0) {
                console.log(`ðŸ§  [Kaizen] Nightly sync: ${synced} learnings pushed to Pinecone`);
            }
        }), { timezone: "America/Denver" });

        // Nightly Housekeeping â€” 11:00 PM Denver (prune stale data everywhere)
        cron.schedule("0 23 * * *", () => this.safeRun("NightlyHousekeeping", async () => {
            const report = await runHousekeeping();

            // Prune cron_runs older than 30 days
            try {
                const supabase = createClient();
                const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                const { count } = await supabase.from('cron_runs')
                    .delete({ count: 'exact' })
                    .lt('started_at', cutoff);
                if (count && count > 0) {
                    console.log(`[ops-manager] Pruned ${count} cron_runs entries older than 30 days`);
                }
            } catch (err: any) {
                console.warn('[ops-manager] cron_runs pruning failed (non-fatal):', err.message);
            }

            // Only alert Will via Telegram if cleanup was surprisingly large
            if (report.totalReclaimed > 500) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    await this.bot.telegram.sendMessage(
                        chatId,
                        `ðŸ§¹ <b>Large cleanup alert:</b> ${report.totalReclaimed} rows/vectors pruned tonight. Check logs for details.`,
                        { parse_mode: "HTML" }
                    );
                }
            }
        }), { timezone: "America/Denver" });

        // Nightshift Pre-classification enqueue @ 6:00 PM Mon-Fri
        // DECISION(2026-03-24): Batch-enqueues unprocessed AP emails for local LLM overnight.
        // llama-server starts at 6:05 PM (Task Scheduler), processes the queue, shuts down at 7 AM.
        // The 8 AM AP identifier poll skips paid Sonnet calls for messages with confidence >= 0.7.
        cron.schedule("0 18 * * 1-5", () => {
            this.safeRun("NightshiftEnqueue", () => this.enqueueNightshiftEmails());
        }, { timezone: "America/Denver" });

        // Nightshift Morning Handoff @ 6:55 AM Mon-Fri
        // DECISION(2026-03-25): This is the loop closure. At 6:55 AM (5 min before
        // stop-nightshift.ps1 kills the runner at 7 AM), this generates a structured
        // shift-change report. Failed/low-confidence items become to-do items for the
        // daytime cloud LLM (Gemini/Claude). Posted to Telegram + stored in Supabase.
        cron.schedule("55 6 * * 1-5", () => {
            this.safeRun("NightshiftHandoff", async () => {
                const handoff = await generateMorningHandoff();
                if (handoff) {
                    const chatId = process.env.TELEGRAM_CHAT_ID;
                    if (chatId) {
                        await this.bot.telegram.sendMessage(
                            chatId,
                            handoff.telegramMessage,
                            { parse_mode: "HTML" }
                        );
                    }
                    console.log(`[nightshift] Morning handoff: ${handoff.totalClassified} classified, ${handoff.failedCount} failed, ${handoff.pendingTasks.length} to-do items`);
                }
            });
        }, { timezone: "America/Denver" });

        // Daily Dedup Set Reset â€” midnight Denver (OOM prevention)
        // DECISION(2026-03-09): These Sets grow by ~50-100 entries/day and are
        // never pruned during runtime. Over weeks, thousands of entries accumulate.
        // Safe to clear nightly because Sets are re-hydrated from Supabase/Finale
        // on the next relevant poll cycle, and stale dedup keys from yesterday
        // are irrelevant (build completions and PO receivings are date-scoped).
        cron.schedule("0 0 * * *", () => {
            this.safeRun("DedupSetReset", () => {
                const sizeBefore = this.seenCompletedBuildIds.size +
                    this.seenReceivedPOIds.size +
                    this.seenOutsideThreadMsgIds.size;
                this.seenCompletedBuildIds.clear();
                this.seenReceivedPOIds.clear();
                this.seenOutsideThreadMsgIds.clear();
                console.log(`[ops-manager] Daily dedup reset: cleared ${sizeBefore} entries across 3 Sets`);
            });
        }, { timezone: "America/Denver" });



    }

    /**
     * Runs a vendor reconciliation as a child process with timeout and Telegram notification.
     *
     * DECISION(2026-03-18): Centralized from 4 inline execAsync blocks to a single method.
     * Adds timeout (5 min), maxBuffer (10 MB), and Telegram notification with results.
     * Previously, reconciliation results were only logged to console â€” Will had no
     * visibility into whether overnight reconciliations succeeded or failed.
     *
     * @param vendorName  - Human-readable name ("Axiom", "FedEx", etc.)
     * @param command     - Full CLI command to execute
     */
    private async runReconciliation(vendorName: string, command: string): Promise<void> {
        const startMs = performance.now();
        const { stdout, stderr } = await execAsync(command, {
            timeout: RECONCILE_TIMEOUT_MS,
            maxBuffer: RECONCILE_MAX_BUFFER,
        });

        if (stderr && !stderr.includes("Debugger attached")) {
            console.warn(`[Reconcile${vendorName}] Stderr: ${stderr}`);
        }

        const durationSec = Math.round((performance.now() - startMs) / 1000);

        // Extract a brief summary from stdout (last 5 non-empty lines)
        const lines = stdout.split('\n').filter((l: string) => l.trim()).slice(-5);
        const summary = lines.join('\n');

        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
            await this.bot.telegram.sendMessage(
                chatId,
                `✅ <b>${vendorName} Reconciliation Complete</b>\n\n` +
                `â± Duration: ${durationSec}s\n` +
                `<pre>${summary.slice(0, 500)}</pre>`,
                { parse_mode: "HTML" }
            ).catch(() => { });
        }
    }

    /**
     * Run the full purchasing assessment pipeline: scrape dashboard → assess items → snapshot → diff.
      * Sends Telegram alerts for new HIGH_NEED items and new Pending requests since last run.
      * Delegates to purchasing-pipeline module.
     *
     * @param source      - 'cron' for automated run, 'manual' for on-demand bot command
     * @param triggeredBy - Optional user ID who triggered the manual run
     * @returns Object with Telegram message summary
     */
     async runPurchasingAssessment(source: 'cron' | 'manual' = 'cron', triggeredBy?: string): Promise<{ telegramMessage: string }> {
          const { runPurchasingIntelligence } = await import('../intelligence/purchasing-pipeline');
         return await runPurchasingIntelligence({ source, triggeredBy });
     }

    /**
     * Enqueue unprocessed AP emails into nightshift_queue for local LLM classification.
     * Called at 6 PM weekdays so the llama-server (starting at 6:05 PM) has tasks ready.
     * source_inbox='ap' filter is critical — default inbox emails never need AP classification.
     */
    private async enqueueNightshiftEmails(): Promise<void> {
        const supabase = createClient();
        const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

        const { data: emails, error } = await supabase
            .from("email_inbox_queue")
            .select("gmail_message_id, from_email, subject, body_snippet")
            .eq("processed_by_ap", false)
            .eq("source_inbox", "ap")
            .gt("created_at", cutoff)
            .limit(100);

        if (error) {
            console.error("[nightshift] enqueueNightshiftEmails error:", error.message);
            return;
        }

        if (!emails || emails.length === 0) {
            console.log("[nightshift] No pending AP emails to enqueue for nightshift");
            return;
        }

        let enqueued = 0;
        for (const email of emails) {
            await enqueueEmailClassification(
                email.gmail_message_id,
                email.from_email ?? "",
                email.subject ?? "",
                email.body_snippet ?? "",
                "ap",
            );
            enqueued++;
        }

        console.log(`[nightshift] Enqueued ${enqueued}/${emails.length} AP emails for overnight classification`);
    }

    /**
     * Move advertisements to label
     */
    async processAdvertisements() {
        console.log("ðŸ§¹ Running Advertisement Cleanup...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: "unsubscribe -label:Advertisements",
                maxResults: 50
            });

            if (!search.messages?.length) return;

            const ids = search.messages.map(m => m.id!);

            await gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                    ids,
                    addLabelIds: ["Label_20"], // Advertisements
                    removeLabelIds: ["INBOX"]
                }
            });

            console.log(`✅ Moved ${ids.length} advertisements.`);
        } catch (err: any) {
            console.error("Cleanup error:", err.message);
        }
    }

    /**
     * Sync PO conversations and tracking response times
     */
    async syncPOConversations() {
        console.log("ðŸ“¦ Syncing PO Conversations...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            // Only scan POs from the last 14 days â€” tracking arrives well within that window
            const since = new Date();
            since.setDate(since.getDate() - 14);
            const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');

            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q: `label:PO after:${sinceStr}`,
                maxResults: 50
            });

            if (!search.messages?.length) return;

            for (const m of search.messages) {
                const { data: thread } = await gmail.users.threads.get({
                    userId: "me",
                    id: m.threadId!,
                    format: 'full'
                });

                if (!thread.messages) continue;

                const firstMsg = thread.messages[0];
                const subject = firstMsg.payload?.headers?.find(h => h.name === 'Subject')?.value || "";

                // Parse PO # from subject
                const poMatch = subject.match(/BuildASoil PO #\s?(\d+)/i);
                if (!poMatch) continue;
                const poNumber = poMatch[1];

                // Extract vendor email from the "To:" header (PO emails are sent TO the vendor)
                const toHeader = firstMsg.payload?.headers?.find((h: any) => h.name === 'To')?.value || '';
                const vendorEmailMatch = toHeader.match(/<([^>]+)>/);
                const vendorEmail = (vendorEmailMatch ? vendorEmailMatch[1] : toHeader.split(',')[0].trim()).toLowerCase();

                // Calculate response time
                const sentAt = parseInt(firstMsg.internalDate!);
                let responseAt: number | null = null;
                let lastVendorMsgAt: number | null = null;
                let humanReplyDetectedAt: string | null = null;

                // Detect vendor replies and human intervention
                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    const msgTime = parseInt(msg.internalDate!);
                    if (!from.includes("buildasoil.com")) {
                        if (!responseAt) responseAt = msgTime;
                        lastVendorMsgAt = msgTime;
                    } else if (lastVendorMsgAt && !humanReplyDetectedAt) {
                        // BuildASoil replied AFTER vendor last message — human intervention detected
                        humanReplyDetectedAt = new Date(msgTime).toISOString();
                    }
                }

                // Also check if Will replied before any vendor response (human intervened early)
                if (!humanReplyDetectedAt && thread.messages.length > 1) {
                    const firstReply = thread.messages[1];
                    const firstReplyFrom = firstReply.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    if (firstReplyFrom.includes("buildasoil.com")) {
                        const firstReplyTime = parseInt(firstReply.internalDate!);
                        humanReplyDetectedAt = new Date(firstReplyTime).toISOString();
                    }
                }

                const responseTimeMins = responseAt ? Math.round((responseAt - sentAt) / 60000) : null;

                // ðŸ” Extract Tracking Numbers from full message body (snippet is too short â€” truncates numbers)
                const _decodeGmailBody = (data: string): string =>
                    Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
                const _walkMsgParts = (parts: any[], out: string[]) => {
                    for (const part of parts ?? []) {
                        if (part.mimeType === 'text/plain' && part.body?.data) out.push(_decodeGmailBody(part.body.data));
                        if (part.parts?.length) _walkMsgParts(part.parts, out);
                    }
                };
                let trackingNumbers: string[] = [];
                for (const msg of thread.messages) {
                    const bodyParts: string[] = [msg.snippet || ''];
                    const payload = msg.payload;
                    if (payload?.body?.data) bodyParts.push(_decodeGmailBody(payload.body.data));
                    if (payload?.parts) _walkMsgParts(payload.parts, bodyParts);
                    const bodyText = bodyParts.join('\n');

                    // Detect LTL carrier name once per message for PRO/BOL encoding
                    const ltlCarrier = detectLTLCarrier(bodyText);

                    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                        // Run global exec loop so we catch ALL tracking numbers, not just the first
                        const gRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
                        let match;
                        while ((match = gRegex.exec(bodyText)) !== null) {
                            // pro/bol/generic/oakharbor: group[1] is the number; others: full match[0]
                            const trackingNum = ['generic', 'pro', 'bol', 'oakharbor'].includes(carrier) ? (match[1] || match[0]) : match[0];
                            // Must contain ≥2 digits — filters pure-word false positives
                            const hasDigits = (trackingNum?.match(/\d/g)?.length ?? 0) >= 2;
                            if (!trackingNum || !hasDigits) continue;

                            // For LTL carriers: encode with carrier name if detected
                            let encoded = trackingNum;
                            if (carrier === 'oakharbor') {
                                encoded = `Oak Harbor Freight Lines:::${trackingNum}`;
                            } else if ((carrier === 'pro' || carrier === 'bol') && ltlCarrier) {
                                encoded = `${ltlCarrier}:::${trackingNum}`;
                            }

                            const rawNum = encoded.split(':::')[1] || encoded;
                            if (!trackingNumbers.some(t => (t.split(':::')[1] || t) === rawNum)) {
                                trackingNumbers.push(encoded);
                            }
                        }
                    }
                }

                // Extract vendor name from subject: "BuildASoil PO # 124350 - Vendor Name - date"
                // Declared here so it's available for both tracking alerts and vendor profiles.
                const vendorMatch = subject.match(/BuildASoil PO\s*#?\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+$/i);
                const vendorName = vendorMatch ? vendorMatch[1].trim() : subject;

                // Always read existing tracking so we can merge â€” never overwrite inbox-sourced tracking
                const { data: existingPO } = await supabase.from("purchase_orders").select("tracking_numbers, line_items").eq("po_number", poNumber).maybeSingle();
                const oldTracking = existingPO?.tracking_numbers || [];
                // Merge: inbox-backfilled numbers stay even if PO thread doesn't mention them
                const mergedTracking = [...new Set([...oldTracking, ...trackingNumbers])];

                // Alert for NEW tracking numbers
                if (trackingNumbers.length > 0) {
                    const newTracking = trackingNumbers.filter(t => !oldTracking.includes(t));

                    if (newTracking.length > 0) {
                        for (const trackingNumber of newTracking) {
                            await upsertShipmentEvidence({
                                trackingNumber,
                                poNumber,
                                vendorName,
                                source: "po_thread_sync",
                                sourceRef: thread.id,
                                confidence: 0.9,
                            });
                        }

                        // Persist tracking numbers FIRST â€” prevents duplicate alerts if two
                        // processes run concurrently (e.g. PM2 restart during a sync cycle).
                        const poLifecycle902 = derivePOLifecycleState({
                            id: poNumber,
                            hasVendorAck: responseAt !== null,
                            hasTracking: mergedTracking.length > 0,
                            trackingNumbers: mergedTracking,
                            acknowledgmentDate: responseAt ? new Date(responseAt).toISOString() : null,
                            humanReplyDetectedAt,
                        });
                        // Read existing row to conditionally set ack fields (first-write-wins)
                        const { data: existingAckRow } = await supabase
                            .from("purchase_orders")
                            .select("vendor_acknowledged_at, shipping_evidence, human_reply_detected_at")
                            .eq("po_number", poNumber)
                            .maybeSingle();

                        await supabase.from("purchase_orders").upsert({
                            po_number: poNumber,
                            vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                            vendor_response_time_minutes: responseTimeMins,
                            tracking_numbers: mergedTracking,
                            lifecycle_stage: poLifecycle902.state,
                            // First-write-wins for vendor acknowledgement
                            ...(responseAt !== null && !existingAckRow?.vendor_acknowledged_at ? {
                                vendor_acknowledged_at: new Date(responseAt).toISOString(),
                                vendor_ack_source: 'po_thread_reply',
                            } : {}),
                            // First-write-wins for human reply detection
                            ...(humanReplyDetectedAt && !existingAckRow?.human_reply_detected_at ? {
                                human_reply_detected_at: humanReplyDetectedAt,
                            } : {}),
                            updated_at: new Date().toISOString()
                        }, { onConflict: "po_number" });

                        // Format PO sent date
                        const sentDate = new Date(sentAt).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            timeZone: 'America/Denver'
                        });

                        // Fetch PO line items + Finale deep-link
                        const finale = finaleClient;
                        const poDetails = await finale.getPOLineItems(poNumber);

                        const poLine = poDetails
                            ? `PO: <a href="${poDetails.finaleUrl}">#${poNumber}</a>`
                            : `PO: #${poNumber}`;

                        const itemsLine = poDetails?.lineItems.length
                            ? `Items: ${poDetails.lineItems.map(i => `<code>${i.sku}</code> Ã—${i.qty}`).join(', ')}`
                            : "";

                        // Fetch delivery status + build message lines per tracking number
                        const trackingLines = await Promise.all(newTracking.map(async t => {
                            const ts = await getTrackingStatus(t);
                            const statusStr = ts ? `  ${ts.display}` : "";
                            const link = ts?.public_url || carrierUrl(t);
                            // Cleanup display for LTL
                            const displayT = t.includes(":::") ? t.replace(":::", " ") : t;
                            return `<a href="${link}">${displayT}</a><i>${statusStr}</i>`;
                        }));

                        let msg = `<b>Tracking Alert</b>\n\n${poLine}\nVendor: ${vendorName}\nSent: ${sentDate}`;
                        if (itemsLine) msg += `\n${itemsLine}`;
                        msg += `\n\n${trackingLines.join('\n')}`;

                        this.bot.telegram.sendMessage(
                            process.env.TELEGRAM_CHAT_ID || "",
                            msg,
                            { parse_mode: "HTML" }
                        );
                    }
                }

                // Index to Pinecone for RAG â€” sanitize nulls (Pinecone rejects null metadata values)
                const pineconeMetadata: Record<string, string | number | boolean | string[]> = {
                    po_number: poNumber,
                    subject,
                    tracking_numbers: trackingNumbers,
                };
                if (responseTimeMins !== null && responseTimeMins !== undefined) {
                    pineconeMetadata.vendor_response_time = responseTimeMins;
                }
                await indexOperationalContext(
                    `po-${poNumber}`,
                    `PO ${poNumber} for ${subject}. Sent: ${new Date(sentAt).toLocaleString()}. Response: ${responseAt ? new Date(responseAt).toLocaleString() : 'Pending'}. Tracking: ${trackingNumbers.join(", ") || 'None'}`,
                    pineconeMetadata
                );

                // Update DB (full record sync â€” use merged tracking to preserve inbox-sourced numbers)
                const poLifecycle976 = derivePOLifecycleState({
                    id: poNumber,
                    hasVendorAck: responseAt !== null,
                    hasTracking: mergedTracking.length > 0,
                    trackingNumbers: mergedTracking,
                    acknowledgmentDate: responseAt ? new Date(responseAt).toISOString() : null,
                });
                await supabase.from("purchase_orders").upsert({
                    po_number: poNumber,
                    vendor_name: vendorName,
                    vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                    vendor_response_time_minutes: responseTimeMins,
                    tracking_numbers: mergedTracking,
                    lifecycle_stage: poLifecycle976.state,
                    updated_at: new Date().toISOString()
                }, { onConflict: "po_number" });

                // Lazily populate line_items for the Slack watchdog product catalog.
                // Only fetch from Finale once per PO (existingPO.line_items is [] on first sync).
                if (!existingPO?.line_items?.length) {
                    try {
                        const { FinaleClient: FC } = await import("../finale/client");
                        const fclient = new FC();
                        const poDetails = await fclient.getPOLineItems(poNumber);
                        if (poDetails?.lineItems?.length) {
                            await supabase.from("purchase_orders").upsert({
                                po_number: poNumber,
                                line_items: poDetails.lineItems.map(i => ({ sku: i.sku, qty: i.qty })),
                                updated_at: new Date().toISOString(),
                            }, { onConflict: "po_number" });
                        }
                    } catch {
                        // Non-fatal â€” catalog will populate on next sync cycle
                    }
                }

                // Update vendor intelligence profile â€” accumulate known email addresses
                // and track whether this vendor replies to PO threads.
                // Re-extract vendor name here since it's scoped inside the newTracking block above.
                const vendorNameForProfile = (subject.match(/BuildASoil PO\s*#?\s*\d+\s*-\s*(.+?)\s*-\s*[\d/]+$/i) || [])[1]?.trim() || null;
                if (vendorNameForProfile) {
                    const vendorEmails: string[] = [];
                    for (const msg of thread.messages) {
                        const fromHeader = msg.payload?.headers?.find((h: any) => h.name === 'From')?.value || "";
                        if (fromHeader.includes("@") && !fromHeader.includes("buildasoil.com")) {
                            const emailMatch = fromHeader.match(/<([^>]+)>/);
                            const email = (emailMatch ? emailMatch[1] : fromHeader.trim()).toLowerCase();
                            if (email && !vendorEmails.includes(email)) vendorEmails.push(email);
                        }
                    }

                    const { data: existing } = await supabase
                        .from("vendor_profiles")
                        .select("vendor_emails")
                        .eq("vendor_name", vendorNameForProfile)
                        .maybeSingle();

                    const mergedEmails = [...new Set([...(existing?.vendor_emails || []), ...vendorEmails])];

                    await supabase.from("vendor_profiles").upsert({
                        vendor_name: vendorNameForProfile,
                        vendor_emails: mergedEmails,
                        communication_pattern: responseAt ? "thread_reply" : "no_response",
                        last_po_date: new Date(sentAt).toISOString(),
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "vendor_name" });
                }

                // â”€â”€ Vendor follow-up + outside-thread search (non-responders only) â”€â”€
                // DECISION(2026-03-13): Reordered logic â€” search for outside-thread
                // emails FIRST. If the vendor already communicated (even outside the PO
                // thread), skip the follow-up entirely. This prevents nagging vendors
                // like Stockie who responded in a separate thread.
                const vendorReplied = responseAt !== null;
                const poIsOlderThan3Days = sentAt < Date.now() - 3 * 86_400_000;

                if (!vendorReplied && trackingNumbers.length === 0 && poIsOlderThan3Days && vendorEmail) {
                    // 1. Outside-thread search FIRST: look for vendor replies in other Gmail threads
                    // If we find ANY communication from the vendor domain, treat them as "responded"
                    // and suppress the follow-up email.
                    let vendorCommunicatedOutsideThread = false;
                    const vendorDomain = vendorEmail.split('@')[1];
                    if (vendorDomain && !vendorDomain.includes('buildasoil.com')) {
                        try {
                            const sendDateStr = new Date(sentAt).toISOString().slice(0, 10).replace(/-/g, '/');
                            const { data: outsideSearch } = await gmail.users.messages.list({
                                userId: 'me',
                                q: `from:${vendorDomain} after:${sendDateStr} -label:PO`,
                                maxResults: 5,
                            });
                            // Dedup by thread: only alert once per outside Gmail thread per PO
                            const seenOutsideThreadIds = new Set<string>();
                            let outsideAlertCount = 0;
                            const MAX_OUTSIDE_ALERTS_PER_PO = 2;

                            for (const outsideMsg of outsideSearch?.messages || []) {
                                if (outsideAlertCount >= MAX_OUTSIDE_ALERTS_PER_PO) break;
                                if (outsideMsg.threadId === m.threadId) continue;
                                // Any email from the vendor domain counts as communication,
                                // even if it doesn't match shipping keywords.
                                vendorCommunicatedOutsideThread = true;

                                // Update lifecycle: vendor acknowledged (even without tracking)
                                const poLifecycleAck = derivePOLifecycleState({
                                    id: poNumber,
                                    hasVendorAck: true,
                                    hasTracking: trackingNumbers.length > 0,
                                    trackingNumbers,
                                });
                                supabase.from("purchase_orders").upsert({
                                    po_number: poNumber,
                                    lifecycle_stage: poLifecycleAck.state,
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: "po_number" }).then(() => { }).catch(() => { });
                                // DEDUP: Skip messages we've already alerted on (persisted across restarts)
                                if (this.seenOutsideThreadMsgIds.has(outsideMsg.id!)) continue;
                                // DEDUP: Skip if we already alerted on a different message in this same thread
                                if (outsideMsg.threadId && seenOutsideThreadIds.has(outsideMsg.threadId)) continue;

                                const { data: msgData } = await gmail.users.messages.get({
                                    userId: 'me', id: outsideMsg.id!, format: 'metadata',
                                    metadataHeaders: ['Subject', 'From'],
                                });
                                const snippet = msgData.snippet || '';
                                // Tighter keyword filter: require shipping-context patterns, not bare words
                                // like "ship" which appear in routine vendor emails about pricing/invoices.
                                const hasEta = /\b(shipped|will ship|shipment|ship date|tracking\s*#|tracking\s*number|dispatch(ed)?|deliver(ed|y|ing)|expected\s*(delivery|arrival)|est\.?\s*(delivery|arrival)|eta\b)/i.test(snippet);
                                const outsideTracking: string[] = [];
                                for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
                                    const match = snippet.match(regex);
                                    if (!match) continue;
                                    const t = carrier === 'generic' ? match[2] : match[0];
                                    if (t) outsideTracking.push(t);
                                }
                                if (hasEta || outsideTracking.length > 0) {
                                    // Mark as seen BEFORE sending to prevent duplicates on concurrent runs
                                    this.seenOutsideThreadMsgIds.add(outsideMsg.id!);
                                    if (outsideMsg.threadId) seenOutsideThreadIds.add(outsideMsg.threadId);
                                    outsideAlertCount++;
                                    // Persist to Supabase so restarts don't re-alert
                                    supabase.from('outside_thread_alerts').upsert({
                                        gmail_message_id: outsideMsg.id!,
                                        po_number: poNumber,
                                        vendor_name: vendorName,
                                        created_at: new Date().toISOString(),
                                    }, { onConflict: 'gmail_message_id' }).then(() => { }).catch(() => { });

                                    const outsideSubject = msgData.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || '(no subject)';
                                    this.bot.telegram.sendMessage(
                                        process.env.TELEGRAM_CHAT_ID || "",
                                        `ðŸ“§ Found <b>${vendorName}</b> email outside PO thread\nPO #${poNumber} | Subject: ${outsideSubject}\n"${snippet.slice(0, 250)}"`,
                                        { parse_mode: "HTML" }
                                    );
                                    if (outsideTracking.length > 0) {
                                        const merged = [...new Set([...trackingNumbers, ...outsideTracking])];
                                        for (const trackingNumber of outsideTracking) {
                                            await upsertShipmentEvidence({
                                                trackingNumber,
                                                poNumber,
                                                vendorName,
                                                source: "outside_thread_tracking",
                                                sourceRef: m.id,
                                                confidence: 0.75,
                                            });
                                        }
                                        const poLifecycle1129 = derivePOLifecycleState({
                                            id: poNumber,
                                            hasVendorAck: vendorCommunicatedOutsideThread,
                                            hasTracking: merged.length > 0,
                                            trackingNumbers: merged,
                                        });
                                        await supabase.from("purchase_orders").upsert({
                                            po_number: poNumber,
                                            tracking_numbers: merged,
                                            lifecycle_stage: poLifecycle1129.state,
                                            updated_at: new Date().toISOString(),
                                        }, { onConflict: "po_number" });
                                    }
                                }
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Outside-thread search failed for ${vendorDomain}: ${e.message}`);
                        }
                    }

                    // 2. Follow-up email in original thread (only if vendor has NOT communicated)
                    if (!vendorCommunicatedOutsideThread) {
                        try {
                            // Read existing tracking request state
                            const { data: existingFollowUpRow } = await supabase
                                .from("purchase_orders")
                                .select("tracking_request_count, shipping_evidence, follow_up_sent_at, human_reply_detected_at")
                                .eq("po_number", poNumber)
                                .maybeSingle();

                            const currentCount = existingFollowUpRow?.tracking_request_count ?? 0;
                            const evidenceCount = (existingFollowUpRow?.shipping_evidence || []).length;
                            const humanReplied = Boolean(existingFollowUpRow?.human_reply_detected_at);

                            // Skip if human has already intervened or we've exhausted follow-ups
                            if (humanReplied) {
                                console.log(`[po-sync] Skipping follow-up for PO #${poNumber} — human reply detected`);
                            } else if (!shouldRequestTrackingFollowUp(currentCount, evidenceCount, false)) {
                                // After 2 failed follow-ups: escalate to Telegram instead of silently giving up
                                // Also mark vendor as noncomm
                                console.log(`[po-sync] Escalating PO #${poNumber} to human — ${currentCount} follow-ups with no response`);
                                const sentDateStr = new Date(sentAt).toLocaleDateString('en-US', {
                                    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                                });
                                const noncommAt = new Date().toISOString();

                                await supabase.from("purchase_orders").upsert({
                                    po_number: poNumber,
                                    tracking_unavailable_at: noncommAt,
                                    vendor_noncomm_at: noncommAt,
                                    lifecycle_stage: 'tracking_unavailable',
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: "po_number" });

                                // Mark vendor as noncomm in vendor_profiles
                                await supabase.from("vendor_profiles")
                                    .update({ is_noncomm: true })
                                    .ilike("vendor_name", vendorName);

                                // Send escalation to Telegram
                                this.bot.telegram.sendMessage(
                                    process.env.TELEGRAM_CHAT_ID || "",
                                    `<b>⚠️ Noncomm Vendor</b>\n\nPO #${poNumber} to <b>${vendorName}</b> sent ${sentDateStr}\n\n${currentCount} follow-ups sent with no tracking or ETA received.\n\nLabeled: <b>NONCOMM</b>\n\n<a href="${`https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&to=${vendorEmail}`}">Reply manually</a> or investigate.`,
                                    { parse_mode: "HTML" }
                                );
                            } else {
                                // Send follow-up using rotating template (L1 or L2 based on count)
                                const sentDateStr = new Date(sentAt).toLocaleDateString('en-US', {
                                    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                                });
                                const firstMsgId = firstMsg.payload?.headers?.find((h: any) => h.name === 'Message-ID')?.value || '';

                                const bodyTemplate = shouldUseL2FollowUp(currentCount)
                                    ? getFollowUpTemplateL2(currentCount)
                                    : getFollowUpTemplate(currentCount);
                                const body = bodyTemplate
                                    .replace('{po}', poNumber)
                                    .replace('{date}', sentDateStr);

                                const rawEmail = buildFollowUpEmail({
                                    to: vendorEmail,
                                    subject: `Re: ${subject}`,
                                    inReplyTo: firstMsgId,
                                    references: firstMsgId,
                                    body,
                                });
                                await gmail.users.messages.send({
                                    userId: 'me',
                                    requestBody: { raw: Buffer.from(rawEmail).toString('base64url'), threadId: m.threadId! },
                                });
                                const followUpSentAt = new Date().toISOString();
                                const newCount = currentCount + 1;

                                const poLifecycleNew = derivePOLifecycleState({
                                    id: poNumber,
                                    hasVendorAck: false,
                                    hasTracking: false,
                                    followUpSentAt,
                                    trackingRequestCount: newCount,
                                    shippingEvidenceCount: evidenceCount,
                                });

                                await supabase.from("purchase_orders").upsert({
                                    po_number: poNumber,
                                    follow_up_sent_at: followUpSentAt,
                                    tracking_requested_at: followUpSentAt,
                                    tracking_request_count: newCount,
                                    lifecycle_stage: poLifecycleNew.state,
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: "po_number" });

                                console.log(`[po-sync] Sent follow-up #${newCount} to ${vendorEmail} for PO #${poNumber}`);
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Follow-up email failed for PO #${poNumber}: ${e.message}`);
                        }
                    } else {
                        console.log(`[po-sync] Skipping follow-up for PO #${poNumber} — vendor ${vendorName} already communicated`);
                    }

                                await supabase.from("purchase_orders").upsert(followUpUpdate, { onConflict: "po_number" });

                                // Alarm: PO in 'sent' state >24h with no vendor communication
                                const hoursSinceSent = (Date.now() - sentAt) / 3_600_000;
                                if (hoursSinceSent > 24) {
                                    console.warn(`[po-sync] ALARM: PO #${poNumber} (${vendorName}) in 'sent' state for ${Math.round(hoursSinceSent)}h with no vendor communication`);
                                }

                                console.log(`ðŸ“§ [po-sync] Sent follow-up to ${vendorEmail} for PO #${poNumber}`);
                                this.bot.telegram.sendMessage(
                                    process.env.TELEGRAM_CHAT_ID || "",
                                    `ðŸ“§ Sent ETA follow-up to <b>${vendorName}</b> for PO #${poNumber} (${sentDateStr}, no response in 3+ days)`,
                                    { parse_mode: "HTML" }
                                );
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Follow-up email failed for PO #${poNumber}: ${e.message}`);
                        }
                    } else {
                        console.log(`ðŸ“§ [po-sync] Skipping follow-up for PO #${poNumber} â€” vendor ${vendorName} already communicated outside PO thread`);
                    }
                }
            }
        } catch (err: any) {
            console.error("PO Sync error:", err.message);
        }
    }

    /**
     * Posts a message to Slack #purchasing (best-effort).
     * Failures are logged but never block the Telegram path.
     *
     * @param text   - Slack mrkdwn formatted message
     * @param label  - Human label for log messages (e.g. "Daily Summary")
     */
    private async postToSlack(text: string, label: string): Promise<void> {
        if (!this.slack) return;

        try {
            await this.slack.chat.postMessage({
                channel: this.slackChannel,
                text,
                mrkdwn: true,
            });
            console.log(`✅ ${label} posted to Slack ${this.slackChannel}`);
        } catch (err: any) {
            // Non-fatal: Telegram message was already sent
            console.error(`âŒ Slack post failed (${label}):`, err.data?.error || err.message);
        }
    }

    /**
     * Generate and send the daily summary to Telegram + Slack.
     */
    async sendDailySummary() {
        console.log("ðŸ“Š Preparing Daily PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("yesterday");

        const summary = await this.generateLLMSummary("Daily", opsData);
        const telegramMsg = `ðŸ“Š **Morning Operations Summary**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // DECISION(2026-03-19): Daily Summary removed from Slack.
        // Now Telegram-only. Slack gets the unified OOS Digest morning post instead.
    }

    /**
     * Generate and send the weekly summary (Friday) to Telegram + Slack.
     */
    async sendWeeklySummary() {
        console.log("ðŸ“… Preparing Weekly PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("week");

        const summary = await this.generateLLMSummary("Weekly", opsData);
        const telegramMsg = `ðŸ—“ï¸ **Friday Weekly Operations Review**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // DECISION(2026-03-19): Weekly Summary removed from Slack.
        // Now Telegram-only. Slack gets the unified OOS Digest morning post instead.
    }

    /**
     * Gets the active purchases list (used by Dashboard API and Slack).
     */
    async getActivePurchasesList(daysBack: number = 60) {
        return loadActivePurchases(finaleClient, daysBack);
    }

    /**
     * Build and post the Active Purchases Ledger to Slack.
     */
    async postActivePurchasesToSlack() {
        console.log("ðŸ›’ Preparing Active Purchases Slack Ledger...");
        if (!this.slack) {
            console.log("Skipping Slack ledger: Slack not configured");
            return;
        }

        try {
            // Slack ledger only shows the trailing 14 days (two weeks) of POs to reduce noise
            const purchases = await this.getActivePurchasesList(14);
            if (purchases.length === 0) return; // Silent if no active purchases

            let msg = `*Active Purchases*\n_Running list of incoming shipments from the last 14 days (auto-clears ${RECEIVED_DASHBOARD_RETENTION_DAYS} days after receipt)_\n\n`;

            for (const p of purchases) {
                const rcvd = p.isReceived;
                const icon = this.poStatusEmoji(p.status);

                let block = `${icon} *<${p.finaleUrl}|PO# ${p.orderId}>* â€” ${p.vendorName}\n`;

                // Keep the layout identical to the Purchasing Calendar
                if (rcvd && p.receiveDate) {
                    const expectedMs = new Date(p.expectedDate).getTime();
                    const actualMs = new Date(p.receiveDate).getTime();
                    const diff = Math.round((actualMs - expectedMs) / 86_400_000);
                    const timing = diff === 0 ? 'on time' : diff > 0 ? `${diff}d late` : `${Math.abs(diff)}d early`;
                    block += `> Ordered: ${this.fmtDate(p.orderDate)} | Received: ${this.fmtDate(p.receiveDate)} (${timing})\n`;
                } else {
                    block += `> Ordered: ${this.fmtDate(p.orderDate)} | Expected: ${this.fmtDate(p.expectedDate)} (${p.leadProvenance})\n`;
                    // Any future tracking links/data injected here until units arrive and are received
                    if (p.trackingNumbers && p.trackingNumbers.length > 0) {
                        const tracLinks = p.trackingNumbers.map((t: string) => `<${carrierUrl(t)}|${t}>`);
                        block += `> Tracking: ${tracLinks.join(" | ")}\n`;
                    } else {
                        block += `> Tracking: _Awaiting Tracking_\n`;
                    }
                }

                // Truncate item list identically
                const itemLines = p.items.slice(0, 5).map((i: any) => `${i.productId} Ã— ${i.quantity.toLocaleString()}`);
                if (p.items.length > 5) itemLines.push(`+ ${p.items.length - 5} more`);
                block += `> Items: ${itemLines.join(', ')}\n`;

                block += `> Total: $${p.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;

                msg += block + "\n";
            }

            await this.postToSlack(msg, "Active Purchases");
        } catch (e: any) {
            console.error(`âŒ Active Purchases posting failed:`, e.message);
        }
    }


    /**
     * Run the Calendar BOM build risk analysis and post results.
     * Fetches production calendars â†’ parses events â†’ explodes BOMs â†’ checks stock.
     * Posts to both Telegram and Slack #purchasing.
     *
     * DECISION(2026-02-25): This runs at 7:30 AM weekdays, 30 min before
     * the daily summary. Errors are caught and reported but never block
     * the rest of the OpsManager schedule.
     */
    /**
     * On startup, pre-populate the dedup Sets so a bot restart doesn't re-alert
     * on completions/receivings that already fired in the current session.
     *
     * Builds: query `build_completions` for the last 2 hours.
     * POs:    query Finale for today's received POs (low volume, safe to re-query).
     */
    private async hydrateSeenSets(): Promise<void> {
        // Hydrate build completions: load today's completions from Supabase (midnight MT â†’ now)
        // Using today rather than 2h prevents re-alerting after a mid-day restart.
        try {
            const db = createClient();
            if (db) {
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);  // local midnight â€” conservative, always earlier than MT midnight
                const since = todayMidnight.toISOString();
                const { data } = await db
                    .from('build_completions')
                    .select('build_id')
                    .gte('created_at', since);
                if (data) {
                    for (const row of data) this.seenCompletedBuildIds.add(row.build_id);
                    console.log(`[ops-manager] Hydrated ${data.length} recent build completions into dedup set.`);
                }
            }
        } catch (err: any) {
            console.warn('[ops-manager] Build completions hydration failed:', err.message);
        }

        // Hydrate PO receivings: load today's received PO IDs from Finale
        try {
            const finale = finaleClient;
            const todayPOs = await finale.getTodaysReceivedPOs();
            for (const po of todayPOs) this.seenReceivedPOIds.add(po.orderId);
            console.log(`[ops-manager] Hydrated ${todayPOs.length} today's received POs into dedup set.`);
        } catch (err: any) {
            console.warn('[ops-manager] PO receivings hydration failed:', err.message);
        }

        // Hydrate outside-thread email dedup: load recently alerted message IDs from Supabase
        try {
            const db = createClient();
            if (db) {
                const { data } = await db
                    .from('outside_thread_alerts')
                    .select('gmail_message_id')
                    .gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString());
                if (data) {
                    for (const row of data) this.seenOutsideThreadMsgIds.add(row.gmail_message_id);
                    console.log(`[ops-manager] Hydrated ${data.length} outside-thread alerts into dedup set.`);
                }
            }
        } catch (err: any) {
            console.warn('[ops-manager] Outside-thread alerts hydration failed:', err.message);
        }
    }

    /**
     * Poll Finale for today's newly-received purchase orders (runs every 30 min).
     * Sends a Telegram notification for each PO not previously seen.
     * Deduplication via `seenReceivedPOIds` (hydrated from Finale on startup).
     */
    async pollPOReceivings(): Promise<void> {
        try {
            const finale = finaleClient;
            const received = await finale.getTodaysReceivedPOs();

            for (const po of received) {
                if (this.seenReceivedPOIds.has(po.orderId)) continue;
                this.seenReceivedPOIds.add(po.orderId);

                const itemCount = po.items.reduce((s, i) => s + i.quantity, 0);
                const skuList = po.items
                    .slice(0, 5)
                    .map(i => `\`${i.productId}\``)
                    .join(', ');
                const moreItems = po.items.length > 5 ? ` +${po.items.length - 5} more` : '';

                const msg =
                    `ðŸ“¦ *PO Received*\n` +
                    `PO: \`${po.orderId}\`  |  Supplier: ${po.supplier}\n` +
                    `Units: ${itemCount.toLocaleString()}  |  Value: $${po.total.toLocaleString()}\n` +
                    `SKUs: ${skuList}${moreItems}`;

                this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || '',
                    msg,
                    { parse_mode: 'Markdown' }
                ).catch((e: any) => console.warn('[po-watcher] Telegram send failed:', e.message));

                // Update the purchasing calendar event for this PO (best-effort)
                setImmediate(async () => {
                    try {
                        const supabase = createClient();
                        if (!supabase) return;
                        const { data: calRow } = await supabase
                            .from('purchasing_calendar_events')
                            .select('event_id, calendar_id')
                            .eq('po_number', po.orderId)
                            .single();
                        if (!calRow) return;

                        const completionSignals = await loadPOCompletionSignalIndex(supabase, [po.orderId]);
                        const completionSignal = completionSignals.get(po.orderId);
                        const completionState = derivePOCompletionState({
                            finaleReceived: true,
                            trackingDelivered: false,
                            hasMatchedInvoice: completionSignal?.hasMatchedInvoice || false,
                            reconciliationVerdict: completionSignal?.reconciliationVerdict || null,
                            freightResolved: completionSignal?.freightResolved || false,
                            unresolvedBlockers: completionSignal?.unresolvedBlockers || [],
                        });
                        const lifecycle = derivePurchasingLifecycle('completed', [], completionState);
                        const receivedDateKey = po.receiveDate
                            ? po.receiveDate.toString().split('T')[0]
                            : new Date().toISOString().split('T')[0];
                        const title = this.buildPOEventTitle({
                            orderId: po.orderId,
                            vendorName: po.supplier,
                            status: 'completed',
                        } as FullPO, lifecycle);
                        const description = await this.buildPOEventDescription(
                            {
                                orderId: po.orderId,
                                vendorName: po.supplier,
                                status: 'completed',
                                orderDate: po.orderDate || '',
                                receiveDate: po.receiveDate || new Date().toISOString(),
                                total: po.total || 0,
                                items: po.items || [],
                                finaleUrl: po.finaleUrl,
                            } as FullPO,
                            po.orderDate || receivedDateKey,
                            'receipt update',
                            [],
                            undefined,
                            lifecycle
                        );

                        const calendar = new CalendarClient();
                        await calendar.updateEventTitleAndDescription(
                            calRow.calendar_id,
                            calRow.event_id,
                            title,
                            description,
                            lifecycle.colorId,
                            receivedDateKey
                        );

                        await supabase.from('purchasing_calendar_events')
                            .update({ status: lifecycle.calendarStatus, updated_at: new Date().toISOString() })
                            .eq('po_number', po.orderId);

                        console.log(`ðŸ“… [po-watcher] Calendar event updated for PO ${po.orderId}`);
                    } catch (e: any) {
                        console.warn('[po-watcher] Calendar update failed:', e.message);
                    }
                });

                console.log(`ðŸ“¦ [po-watcher] PO received: ${po.orderId} from ${po.supplier} (${itemCount} units)`);

                // â”€â”€ Receiving Discrepancy Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // DECISION(2026-03-04): Compare received qty vs ordered qty per item.
                // Flag shorts and overs via Telegram so they don't go unnoticed.
                const discrepancies: string[] = [];
                for (const item of po.items) {
                    const ordered = item.orderedQuantity ?? 0;
                    const received = item.quantity;
                    if (ordered > 0 && received !== ordered) {
                        const diff = received - ordered;
                        const pct = Math.round((diff / ordered) * 100);
                        const icon = diff < 0 ? 'ðŸ”´' : 'ðŸŸ¡';
                        discrepancies.push(`${icon} \`${item.productId}\`: ordered ${ordered.toLocaleString()} â†’ received ${received.toLocaleString()} (${diff > 0 ? '+' : ''}${diff.toLocaleString()}, ${pct > 0 ? '+' : ''}${pct}%)`);
                    }
                }
                if (discrepancies.length > 0) {
                    const discMsg =
                        `âš ï¸ *Receiving Discrepancy â€” PO #${po.orderId}*\n` +
                        `Supplier: ${po.supplier}\n\n` +
                        discrepancies.join('\n');
                    this.bot.telegram.sendMessage(
                        process.env.TELEGRAM_CHAT_ID || '',
                        discMsg,
                        { parse_mode: 'Markdown' }
                    ).catch((e: any) => console.warn('[po-watcher] Discrepancy alert failed:', e.message));
                }
            }
        } catch (err: any) {
            console.error('[po-watcher] pollPOReceivings error:', err.message);
        }
    }

    /**
     * Alert on stale draft POs (uncommitted for >3 days).
     * Runs daily at 9 AM weekdays via cron.
     *
     * DECISION(2026-03-04): Simple daily nudge so forgotten drafts don't
     * sit forever. Lists each stale draft with vendor, age, and a Finale link.
     */
    async alertStaleDraftPOs(): Promise<void> {
        try {
            const finale = finaleClient;
            const stale = await finale.getStaleDraftPOs(3);

            if (stale.length === 0) {
                console.log('[ops-manager] No stale draft POs found.');
                return;
            }

            const lines = stale.map(po => {
                const dateStr = po.orderDate
                    ? new Date(po.orderDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '?';
                return `â€¢ PO #${po.orderId} â€” ${po.supplier} (${po.ageDays}d old, ${po.itemCount} items, $${po.total.toLocaleString()}) [${dateStr}]`;
            });

            const msg =
                `ðŸ“‹ *${stale.length} Stale Draft PO${stale.length > 1 ? 's' : ''}*\n` +
                `_Uncommitted for 3+ days â€” commit or delete:_\n\n` +
                lines.join('\n');

            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || '',
                msg,
                { parse_mode: 'Markdown' }
            ).catch((e: any) => console.warn('[ops-manager] Stale draft alert failed:', e.message));

            console.log(`ðŸ“‹ [ops-manager] Sent stale draft alert for ${stale.length} PO(s).`);
        } catch (err: any) {
            console.error('[ops-manager] alertStaleDraftPOs error:', err.message);
        }
    }

    /**
     * Poll Finale for recently completed build orders (runs every 30 min).
     *
     * On completion detected:
     *   1. Sends a Telegram notification to Will
     *   2. Appends "✅ Completed: [timestamp]" to the matching Google Calendar event description
     *
     * Calendar writes are best-effort â€” description-only PATCH, no color/title changes.
     * Finale endpoint discovery is required; see src/cli/test-finale-builds.ts.
     */
    async pollBuildCompletions() {
        try {
            const finale = finaleClient;
            const since = new Date(Date.now() - 31 * 60 * 1000); // 31 min ago (overlaps slightly to avoid gaps)
            const completed = await finale.getRecentlyCompletedBuilds(since);

            if (completed.length === 0) return;

            // Fetch calendar builds once so we can match by SKU + date
            const calendar = new CalendarClient();
            const parser = new BuildParser();
            const events = await calendar.getAllUpcomingBuilds(60); // wider window â€” build may be today
            const parsedBuilds = await parser.extractBuildPlan(events);

            for (const build of completed) {
                if (this.seenCompletedBuildIds.has(build.buildId)) continue;
                this.seenCompletedBuildIds.add(build.buildId);

                const completedAt = new Date(build.completedAt);
                const timeStr = completedAt.toLocaleString('en-US', {
                    month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                    timeZone: 'America/Denver',
                });

                // Match to a calendar event (same SKU, within Â±1 day of build date)
                const buildDate = completedAt.toISOString().split('T')[0];
                const matched = parsedBuilds.find(p =>
                    p.sku === build.sku &&
                    p.eventId !== null &&
                    Math.abs(new Date(p.buildDate).getTime() - completedAt.getTime()) < 2 * 86400000
                );

                // Build the Finale deep-link URL for this build
                const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
                // VERIFIED(2026-03-04): buildUrl comes from GraphQL; Finale route is build/detail/{base64}
                const buildApiPath = build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`;
                const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/detail/${Buffer.from(buildApiPath).toString('base64')}`;

                if (matched?.eventId && matched.calendarId) {
                    // Dedup: skip if this event already has a completion annotation
                    try {
                        const existingEvent = await calendar.getEventRaw(matched.calendarId, matched.eventId);
                        const existingDesc = existingEvent?.description || '';
                        const existingTitle = existingEvent?.summary || '';
                        if (existingDesc.includes('Completed:') || existingTitle.startsWith('✅') || existingTitle.startsWith('ðŸŸ¡')) {
                            console.log(`â­ï¸ [build-watcher] ${build.sku} already annotated, skipping`);
                        } else {
                            const scheduledQty = matched.quantity;
                            // Determine icon: ðŸŸ¡ partial if under scheduled, ✅ if met or exceeded
                            const icon = (scheduledQty && build.quantity < scheduledQty) ? 'ðŸŸ¡' : '✅';

                            // 1. Prepend icon to title so it's visible on calendar grid
                            const newTitle = `${icon} ${existingTitle}`;

                            // 2. Build description annotation with Finale link
                            let completionNote: string;
                            if (scheduledQty && scheduledQty !== build.quantity) {
                                const pct = Math.round((build.quantity / scheduledQty) * 100);
                                completionNote = `${icon} Completed: ${timeStr} â€” ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
                            } else {
                                completionNote = `${icon} Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
                            }
                            completionNote += `\nâ†’ <a href="${finaleUrl}">Build #${build.buildId}</a>`;

                            const newDesc = existingDesc
                                ? `${existingDesc}\n${completionNote}`
                                : completionNote;

                            await calendar.updateEventTitleAndDescription(
                                matched.calendarId,
                                matched.eventId,
                                newTitle,
                                newDesc
                            );
                        }
                    } catch (e: any) {
                        console.warn(`[build-watcher] Calendar annotation failed for ${build.sku}: ${e.message}`);
                    }
                }

                // Persist to Supabase so the dashboard shows the completion indicator
                setImmediate(async () => {
                    const db = createClient();
                    if (!db) return;
                    await db.from('build_completions').upsert({
                        build_id: build.buildId,
                        sku: build.sku,
                        quantity: build.quantity,
                        completed_at: build.completedAt,
                        calendar_event_id: matched?.eventId ?? null,
                        calendar_id: matched?.calendarId ?? null,
                    }, { onConflict: 'build_id', ignoreDuplicates: true });
                });

                // DECISION(2026-03-04): Removed the separate MFG calendar event creation.
                // Build completions are now annotated directly onto the existing build plan
                // event (above) to avoid duplicate entries on the same calendar day.

                console.log(`✅ [build-watcher] Build complete: ${build.sku} Ã— ${build.quantity} @ ${timeStr}`);
            }
        } catch (err: any) {
            console.error('[build-watcher] pollBuildCompletions error:', err.message);
        }
    }

    async sendBuildRiskReport() {
        console.log("ðŸ­ Running daily Calendar BOM Build Risk Analysis...");

        try {
            const report = await runBuildRiskAnalysis(30, (msg) => {
                console.log(`[build-risk-cron] ${msg}`);
            });

            // 1. Send Telegram version
            const telegramMsg = report.telegramMessage;
            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                telegramMsg,
                { parse_mode: "Markdown" }
            );

            // 2. (Slack cross-post removed â€” OOS digest and dashboard/calendar cover this)

            // 3. If critical items exist, send a follow-up with action items
            if (report.criticalCount > 0) {
                const urgentMsg = `ðŸš¨ *${report.criticalCount} CRITICAL stockout risk(s) detected!*\n` +
                    `_These components will stock out within 14 days and have no incoming POs._\n` +
                    `_Check the build risk report above for details, or run \`/buildrisk\` for the full analysis._`;

                this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    urgentMsg,
                    { parse_mode: "Markdown" }
                );
            }

            // Restock detection: compare today's risk vs yesterday's snapshot.
            // Any component that was CRITICAL/WARNING and is now OK â†’ send Telegram
            // alert and append a note to the affected calendar events.
            setImmediate(async () => {
                const { getLastSnapshot, saveBuildRiskSnapshot } = await import('../builds/build-risk-logger');
                const lastSnapshot = await getLastSnapshot();

                if (lastSnapshot) {
                    const restocked: string[] = [];
                    for (const [sku, demand] of report.components.entries()) {
                        const prev = lastSnapshot[sku];
                        if (prev && (prev.riskLevel === 'CRITICAL' || prev.riskLevel === 'WARNING') && demand.riskLevel === 'OK') {
                            restocked.push(sku);
                        }
                    }

                    if (restocked.length > 0) {
                        // Telegram alert
                        const restockMsg = `✅ *Component Restock Alert*\n` +
                            restocked.map(sku => `â€¢ \`${sku}\` â€” back in stock, was ${lastSnapshot[sku].riskLevel}`).join('\n') +
                            `\n_Affected builds are no longer blocked by these components._`;
                        this.bot.telegram.sendMessage(
                            process.env.TELEGRAM_CHAT_ID || '',
                            restockMsg,
                            { parse_mode: 'Markdown' }
                        ).catch((e: any) => console.warn('[restock] Telegram send failed:', e.message));

                        // Calendar description write-back for each affected build event
                        const calClient = new CalendarClient();
                        const parser = new BuildParser();
                        const events = await calClient.getAllUpcomingBuilds(60);
                        const parsedBuilds = await parser.extractBuildPlan(events);
                        const today = new Date().toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver'
                        });

                        for (const sku of restocked) {
                            const demand = report.components.get(sku);
                            if (!demand) continue;
                            // `usedIn` contains finished-good SKUs that use this raw component
                            for (const fgSku of demand.usedIn) {
                                const build = parsedBuilds.find(p => p.sku === fgSku && p.eventId !== null);
                                if (build?.eventId && build.calendarId) {
                                    await calClient.appendToEventDescription(
                                        build.calendarId,
                                        build.eventId,
                                        `✅ ${sku} replenished â€” Build now Green (${today})`
                                    );
                                }
                            }
                        }
                    }
                }

                // â”€â”€ Blocked-build calendar annotations â”€â”€
                // DECISION(2026-03-04): For each CRITICAL/WARNING component, annotate
                // the affected calendar build events with a concise warning showing the
                // blocking component, any PO on order + ETA, and whether it arrives in
                // time. Zero LLM tokens. Deduped via proactive_alerts so we don't
                // re-annotate the same build for the same shortage every day.
                try {
                    const cal = new CalendarClient();
                    const bp = new BuildParser();
                    const ev = await cal.getAllUpcomingBuilds(60);
                    const builds = await bp.extractBuildPlan(ev);
                    const todayLabel = new Date().toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                    });

                    // Dedup: check which (componentSku, buildEventId) pairs we've already annotated
                    const db = createClient();
                    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    const { data: recentAlerts } = db
                        ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff24h)
                        : { data: [] };
                    const alertedSet = new Set((recentAlerts ?? []).map((r: any) => `${r.sku}:${r.risk_level}`));

                    const atRisk = Array.from(report.components.entries()).filter(
                        ([, d]) => d.riskLevel === 'CRITICAL' || d.riskLevel === 'WARNING'
                    );

                    let annotated = 0;
                    for (const [compSku, demand] of atRisk) {
                        // Skip if we already annotated this component today
                        if (alertedSet.has(`${compSku}:cal-block`)) continue;

                        for (const fgSku of demand.usedIn) {
                            const build = builds.find(p => p.sku === fgSku && p.eventId !== null);
                            if (!build?.eventId || !build.calendarId) continue;

                            // â”€â”€ Build the annotation â”€â”€
                            const icon = demand.riskLevel === 'CRITICAL' ? 'ðŸ”´' : 'ðŸŸ¡';
                            const daysLabel = demand.stockoutDays !== null
                                ? `${demand.stockoutDays}d to stockout`
                                : 'low stock';

                            let note = `${icon} ${compSku} â€” ${daysLabel}`;

                            if (demand.incomingPOs.length > 0) {
                                const po = demand.incomingPOs[0]; // most relevant PO
                                // Estimate arrival: orderDate + leadTimeDays
                                let etaStr = '';
                                let arrivesBefore = false;
                                if (demand.leadTimeDays !== null && po.orderDate) {
                                    const orderMs = new Date(po.orderDate).getTime();
                                    const etaMs = orderMs + demand.leadTimeDays * 86400000;
                                    const eta = new Date(etaMs);
                                    etaStr = eta.toLocaleDateString('en-US', {
                                        month: 'short', day: 'numeric', timeZone: 'America/Denver',
                                    });
                                    const buildMs = new Date(build.buildDate + 'T12:00:00').getTime();
                                    arrivesBefore = etaMs <= buildMs;
                                }

                                const poLabel = `PO#${po.orderId} from ${po.supplier} (${po.quantity.toLocaleString()} units)`;
                                if (etaStr) {
                                    note += `\n   ${arrivesBefore ? '✅' : 'âš ï¸'} ${poLabel} ETA ~${etaStr}`;
                                    if (!arrivesBefore) {
                                        const buildMs = new Date(build.buildDate + 'T12:00:00').getTime();
                                        const etaMs = new Date(po.orderDate).getTime() + (demand.leadTimeDays ?? 0) * 86400000;
                                        const daysLate = Math.ceil((etaMs - buildMs) / 86400000);
                                        note += ` â€” arrives ~${daysLate}d after build`;
                                    }
                                } else {
                                    note += `\n   ðŸ“¦ ${poLabel} on order`;
                                }

                                if (demand.incomingPOs.length > 1) {
                                    note += ` (+${demand.incomingPOs.length - 1} more PO${demand.incomingPOs.length > 2 ? 's' : ''})`;
                                }
                            } else {
                                note += '\n   â›” No PO on order';
                            }

                            note += ` (${todayLabel})`;

                            await cal.appendToEventDescription(build.calendarId, build.eventId, note);
                            annotated++;
                        }

                        // Mark as annotated so we don't repeat tomorrow
                        if (db) {
                            await db.from('proactive_alerts').upsert({
                                sku: compSku,
                                alert_type: 'cal-block',
                                risk_level: 'cal-block',
                                stockout_days: demand.stockoutDays,
                                alerted_at: new Date().toISOString(),
                            }, { onConflict: 'sku,alert_type' });
                        }
                    }

                    if (annotated > 0) {
                        console.log(`ðŸ“… [build-risk] Annotated ${annotated} calendar event(s) with component shortage warnings.`);
                    }
                } catch (err: any) {
                    console.warn('[build-risk] Calendar block annotation failed (non-fatal):', err.message);
                }

                await saveBuildRiskSnapshot(report);

                // Smart reorder prescriptions â€” fires as a follow-up Telegram message.
                // Deduped: only sends if (sku, 'reorder') hasn't been alerted in the last 20 hours.
                try {
                    const { generateReorderPrescriptions, formatPrescriptionsTelegram } = await import('../builds/reorder-engine');
                    const prescriptions = await generateReorderPrescriptions(report.components, report.fgVelocity);
                    if (prescriptions.length > 0) {
                        const db = createClient();
                        const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                        const { data: recent } = db
                            ? await db.from('proactive_alerts').select('sku,risk_level').gte('alerted_at', cutoff)
                            : { data: [] };
                        const recentSet = new Set((recent ?? []).map((r: any) => `${r.sku}:${r.risk_level}`));
                        const fresh = prescriptions.filter(p => !recentSet.has(`${p.componentSku}:${p.riskLevel}`));
                        if (fresh.length > 0) {
                            const msg = formatPrescriptionsTelegram(fresh);
                            this.bot.telegram.sendMessage(
                                process.env.TELEGRAM_CHAT_ID || '',
                                msg,
                                { parse_mode: 'Markdown' }
                            ).catch((e: any) => console.warn('[prescriptions] Telegram failed:', e.message));
                            if (db) {
                                await db.from('proactive_alerts').upsert(
                                    fresh.map(p => ({
                                        sku: p.componentSku,
                                        alert_type: 'reorder',
                                        risk_level: p.riskLevel,
                                        stockout_days: p.stockoutDays,
                                        suggested_order_qty: p.suggestedOrderQty,
                                        days_after_order: p.daysAfterOrder,
                                        alerted_at: new Date().toISOString(),
                                    })),
                                    { onConflict: 'sku,alert_type' }
                                );
                            }
                            console.log(`ðŸ§  [reorder] Sent ${fresh.length} prescription${fresh.length > 1 ? 's' : ''}.`);
                        }
                    }
                } catch (err: any) {
                    console.warn('[reorder] prescription engine failed (non-fatal):', err.message);
                }
            });

            console.log(`✅ Build risk report sent: ðŸ”´ ${report.criticalCount} Â· ðŸŸ¡ ${report.warningCount} Â· ðŸ‘€ ${report.watchCount} Â· ✅ ${report.okCount}`);
        } catch (err: any) {
            console.error("âŒ Build risk analysis failed:", err.message);

            // Report the failure to Telegram so Will knows
            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                `âš ï¸ _Daily build risk analysis failed: ${err.message}_\n_Run \`/buildrisk\` manually to troubleshoot._`,
                { parse_mode: "Markdown" }
            );
        }
    }

    private async getOperationsStatsForTimeframe(timeframe: "yesterday" | "week") {
        const supabase = createClient();
        const date = new Date();
        if (timeframe === "yesterday") date.setDate(date.getDate() - 1);
        else date.setDate(date.getDate() - 7);
        const isoDate = date.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        // For weekly reports AND daily week-to-date data, calculate Monday of current week â†’ tomorrow
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        const finaleStartDate = monday.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        let finaleEndDate: string | undefined;
        let queryStartDate = isoDate;

        if (timeframe === "week") {
            const tomorrow = new Date(now);
            tomorrow.setDate(now.getDate() + 1);
            finaleEndDate = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            queryStartDate = monday.toISOString().split("T")[0];
        } else {
            // For yesterday, we still want week-to-date totals, so we fetch everything from Monday to Today
            const today = new Date(now);
            finaleEndDate = today.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            queryStartDate = monday.toISOString().split("T")[0];
        }

        try {
            const [pos, invoices, documents] = await Promise.all([
                supabase.from("purchase_orders").select("po_number, vendor_name, total, status, created_at").gte("created_at", queryStartDate).limit(100),
                supabase.from("invoices").select("invoice_number, vendor_name, amount_due, status, created_at").gte("created_at", queryStartDate).limit(50),
                supabase.from("documents").select("type, status, email_from, email_subject, action_required, created_at").gte("created_at", queryStartDate).limit(20)
            ]);

            // Grab Finale received and committed PO data â€” use full week range for both reports
            let finaleReceivedPOs: any[] = [];
            let finaleCommittedPOs: any[] = [];
            // DECISION(2026-03-23): Also fetch last week's committed POs so the morning
            // summary includes prior-week spend for comparison. Uses the previous
            // Mondayâ†’Sunday window. Only fetched for daily reports (weekly already covers it).
            let lastWeekCommittedPOs: any[] = [];
            try {
                const finale = finaleClient;

                // Previous week range: Monâ†’Sun before current week
                const prevMonday = new Date(monday);
                prevMonday.setDate(prevMonday.getDate() - 7);
                const prevSunday = new Date(monday); // Current Monday = end of previous week
                const prevMondayStr = prevMonday.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
                const prevSundayStr = prevSunday.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

                const fetchPromises: Promise<any>[] = [
                    finale.getTodaysReceivedPOs(finaleStartDate, finaleEndDate),
                    finale.getTodaysCommittedPOs(finaleStartDate, finaleEndDate),
                ];

                // Only add last-week fetch for daily reports
                if (timeframe === "yesterday") {
                    fetchPromises.push(finale.getTodaysCommittedPOs(prevMondayStr, prevSundayStr));
                }

                const results = await Promise.all(fetchPromises);
                finaleReceivedPOs = results[0];
                finaleCommittedPOs = results[1];
                if (results[2]) lastWeekCommittedPOs = results[2];
            } catch (err) {
                console.warn("Could not fetch Finale PO activity for summary", err);
            }

            // Unread emails: daily only â€” not relevant for weekly review
            let unreadCount = 0;
            let unreadSubjects: string[] = [];
            if (timeframe === "yesterday") {
                try {
                    const auth = await getAuthenticatedClient("default");
                    const gmail = GmailApi({ version: "v1", auth });
                    const { data } = await gmail.users.messages.list({
                        userId: "me",
                        q: "is:unread -label:Advertisements -label:SPAM INBOX",
                        maxResults: 5
                    });
                    unreadCount = data.resultSizeEstimate || (data.messages ? data.messages.length : 0);

                    if (data.messages && data.messages.length > 0) {
                        for (const m of data.messages) {
                            const msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
                            const subject = msg.data.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
                            unreadSubjects.push(subject);
                        }
                    }
                } catch (gmailErr) {
                    console.warn("Could not fetch unread emails for summary:", gmailErr);
                }
            }

            // Compute last week's total spend for the summary
            const lastWeekTotalSpend = lastWeekCommittedPOs.reduce((sum: number, po: any) => sum + (po.total || 0), 0);

            const dailySlices = timeframe === "yesterday"
                ? buildDailyFinaleSlices({
                    finaleReceivingsWtd: finaleReceivedPOs,
                    finaleCommittedWtd: finaleCommittedPOs,
                    yesterdayIsoDate: isoDate,
                })
                : null;

            return {
                timeframe,
                purchase_orders_db: pos.data || [],
                finale_receivings: finaleReceivedPOs,
                finale_committed: finaleCommittedPOs,
                finale_receivings_wtd: dailySlices?.finale_receivings_wtd || finaleReceivedPOs,
                finale_receivings_yesterday: dailySlices?.finale_receivings_yesterday || finaleReceivedPOs,
                finale_committed_wtd: dailySlices?.finale_committed_wtd || finaleCommittedPOs,
                finale_committed_yesterday: dailySlices?.finale_committed_yesterday || finaleCommittedPOs,
                last_week_committed: lastWeekCommittedPOs,
                last_week_total_spend: lastWeekTotalSpend,
                invoices: invoices.data || [],
                documents: documents.data || [],
                unread_emails: { count: unreadCount, subjects: unreadSubjects }
            };
        } catch (err) {
            return {
                timeframe,
                purchase_orders_db: [],
                finale_receivings: [],
                finale_committed: [],
                finale_receivings_wtd: [],
                finale_receivings_yesterday: [],
                finale_committed_wtd: [],
                finale_committed_yesterday: [],
                last_week_committed: [],
                last_week_total_spend: 0,
                invoices: [],
                documents: [],
                unread_emails: { count: 0, subjects: [] },
            };
        }
    }

    private async generateLLMSummary(title: string, data: any) {
        const isWeekly = data.timeframe === "week";
        const isEmpty = !data.purchase_orders_db?.length && !data.invoices?.length && !data.documents?.length
            && data.unread_emails?.count === 0 && (!data.finale_receivings || data.finale_receivings.length === 0);
        if (isEmpty) return "No operations tracked in the system for this timeframe.";

        const prompt = isWeekly
            ? `Generate a concise Friday Weekly Operations Review for BuildASoil from the data below.

INCLUDE (in this order):
1. **Weekly Receivings** â€” List EVERY PO received this week. For each: vendor name, PO number, total units received, dollar amount, and key SKUs. End with a total (# POs, total units, total $).
2. **POs Committed This Week** â€” List each new PO placed: vendor, PO number, dollar amount. End with total spend.
3. **Notable items** â€” Any anomalies, large orders, or action items worth flagging.

DO NOT include: vendors-contacted/invoiced section, unread emails, document processing stats.
Format with clean markdown bullets. Be specific with numbers â€” no vague summaries.
Data: ${JSON.stringify(data)}`
            : `Summarize the following operations activity for the Daily Morning report.
The data provided contains explicit week-to-date and yesterday-only Finale slices.
Your summary MUST include WEEKLY TOTALS for the week so far, AND only name yesterday's specific receivings and committed POs from the explicit *_yesterday arrays.

Focus on: 
- Total spend/amount due (Week-to-date and Yesterday specific).
- Finale receivings (Use finale_receivings_wtd for totals, AND finale_receivings_yesterday for yesterday's specific POs received).
- Committed POs (Use finale_committed_wtd for totals, AND finale_committed_yesterday for yesterday's specific POs placed).
- **Last Week's PO Spend** â€” The data includes "last_week_committed" (list of committed POs from the previous Monâ€“Sun) and "last_week_total_spend" (their sum). Show this as a one-liner: "Last Week Committed: X POs Â· $Y total". This gives Will a quick comparison.
- Unread actionable email count (current snapshot).

DO NOT include a vendors-contacted/invoiced section.
Format cleanly with markdown bullets. Be concise but actionable. If a section has no data, skip it.
Data: ${JSON.stringify(data)}`;

        try {
            return await unifiedTextGeneration({
                system: SYSTEM_PROMPT,
                prompt
            });
        } catch (err) {
            return "Unable to generate intelligent summary at this time.";
        }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // PURCHASING CALENDAR SYNC
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Build the status emoji prefix for a PO based on its Finale status string.
     */
    private poStatusEmoji(status: string): string {
        const s = (status || '').toLowerCase();
        if (s === 'completed') return '✅';
        if (s === 'cancelled') return '❌';
        return '🔴';
    }

    /**
     * Format a YYYY-MM-DD or ISO date string as "Mar 3, 2026".
     */
    private fmtDate(dateStr: string | null | undefined): string {
        if (!dateStr) return 'Unknown';
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    /**
     * Add N calendar days to a YYYY-MM-DD string, returns YYYY-MM-DD.
     */
    private addDays(dateStr: string, days: number): string {
        const d = new Date(dateStr);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().split('T')[0];
    }

    /**
     * Build the calendar event title for a PO.
     * DECISION(2026-03-11): Unreceived POs get ðŸ”´ prefix for visual urgency.
     */
    private buildPOEventTitle(po: FullPO, lifecycle = derivePurchasingLifecycle(po.status, [], null, undefined, po.receiveDate, po.shipments)): string {
        let skuStr = '';
        if (po.items && po.items.length > 0) {
            const skus = po.items.map(i => i.productId).slice(0, 2).join(', ');
            skuStr = po.items.length > 2 ? ` [${skus} +${po.items.length - 2}]` : ` [${skus}]`;
        }
        return `${lifecycle.prefixText} PO #${po.orderId} - ${po.vendorName}${skuStr}`;
    }

    /**
     * Build the calendar event description for a PO.
     */
    private async buildPOEventDescription(
        po: FullPO,
        expectedDate: string,
        leadProvenance: string,
        trackingNumbers: string[],
        prefetchedStatuses?: Map<string, TrackingStatus | null>,
        lifecycle = derivePurchasingLifecycle(po.status, Array.from(prefetchedStatuses?.values() || []), null, expectedDate, po.receiveDate, po.shipments),
        latestETA?: string,
        highConfTracking?: Array<{ trackingNumber: string; carrier: string; status: string; eta?: string; carrierUrl?: string; updatedAt?: string }>,
        lifecycleData?: Record<string, any> | null
    ): Promise<string> {
        const isReceived = lifecycle.isReceived;
        const isCancelled = lifecycle.isCancelled;

        const lines: string[] = [];

        // Always show placement date with vendor
        lines.push(`Placed with Vendor: ${this.fmtDate(po.orderDate)}`);

        // Always show expected receipt if not cancelled
        if (!isCancelled) {
            if (latestETA && !isReceived) {
                lines.push(`Expected Receipt: <b>${this.fmtDate(latestETA)}</b> <i>(Updated via Live Carrier Tracking)</i>`);
                lines.push(`Original Expected: ${this.fmtDate(expectedDate)} (${leadProvenance})`);
            } else {
                lines.push(`Expected Receipt: ${this.fmtDate(expectedDate)} (${leadProvenance})`);
            }
        }

        // Show actual receipt if received, with timing vs expected
        if (isReceived) {
            // Find the latest received shipment for receiver info
            const receivedShipments = (po.shipments || []).filter(s =>
                String(s.status || '').toLowerCase().includes('received') && s.receiveDate
            );
            const latestShip = receivedShipments.sort((a, b) =>
                String(b.receiveDate).localeCompare(String(a.receiveDate))
            )[0];

            if (latestShip) {
                const recvDate = this.fmtDate(latestShip.receiveDate!);
                lines.push(`Received: ${recvDate}`);
            } else if (po.receiveDate) {
                lines.push(`Received: ${this.fmtDate(po.receiveDate)}`);
            } else {
                lines.push(`Received`);
            }
        } else {
            lines.push(`Actual Receipt: Not yet received`);
        }

        const rawData = highConfTracking || [];
        // Dedup by tracking number to prevent doubled display
        const seen = new Set<string>();
        const trackingData = rawData.filter(t => {
            if (!t.trackingNumber || seen.has(t.trackingNumber)) return false;
            seen.add(t.trackingNumber);
            return true;
        });
        if (trackingData.length > 0) {
            lines.push(`\nLIVE TRACKING`);
            for (const t of trackingData) {
                const etaStr = t.eta ? `<b>ETA: ${new Date(t.eta).toLocaleDateString()}</b>` : '';
                const link = `<a href="${t.carrierUrl || '#' }">${t.trackingNumber}</a> (${t.carrier})`;

                lines.push(`• ${link}`);
                lines.push(`  Status: ${t.status}`);
                if (etaStr) lines.push(`  ${etaStr}`);
            }
            lines.push(``); // Spacer
        } else if (!isReceived && !isCancelled) {
            lines.push(`\nTracking: Awaiting tracking from vendor\n`);
        }

        // Line items — max 5 + overflow count
        const itemLines = po.items.slice(0, 5).map(i => `${i.productId} × ${i.quantity.toLocaleString()}`);
        if (po.items.length > 5) itemLines.push(`+ ${po.items.length - 5} more`);
        lines.push(`Items: ${itemLines.join(', ')}`);

        // DECISION(2026-03-11): Removed monetary Total from calendar events per user request.

        lines.push(`Status: ${lifecycle.statusLabel}`);

        // Lifecycle evidence summary from purchase_orders lifecycle columns
        if (lifecycleData?.lifecycle_stage && lifecycleData.lifecycle_stage !== 'sent') {
            const stageLabels: Record<string, string> = {
                vendor_acknowledged: 'Vendor Acknowledged',
                tracking_unavailable: 'Tracking Unavailable',
                moving_with_tracking: 'In Transit',
                ap_follow_up: 'AP Follow-up',
            };
            const stageLabel = stageLabels[lifecycleData.lifecycle_stage] || lifecycleData.lifecycle_stage;
            let lifecycleLine = `Lifecycle: ${stageLabel}`;
            if (lifecycleData.last_movement_summary) {
                lifecycleLine += ` — ${lifecycleData.last_movement_summary}`;
            }
            lines.push(lifecycleLine);
        }

        if (lifecycle.isDeliveredAwaitingReceipt) {
            lines.push(`ACTION REQUIRED: TRACKING SHOWS DELIVERED - VERIFY RECEIVING IN FINALE`);
        } else if (!isReceived && !isCancelled) {
            lines.push(`NOT YET RECEIVED`);
        }

        lines.push(`→ <a href="${po.finaleUrl}">PO# ${po.orderId}</a>`);

        return lines.join('\n');
    }

    /**
     * Sync all recent purchase orders to the purchasing Google Calendar.
     * - Creates a new all-day event (on the expected arrival date) for each new PO
     * - Updates the event title/description in place when status changes
     * - Expected arrival date: Finale's deliverDate â†’ vendor median lead time â†’ 14d default
     *
     * Runs every 4 hours via cron. Also called by the backfill script.
     * Never throws â€” all errors are logged and swallowed.
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number; cleared: number }> {
        const counts = { created: 0, updated: 0, skipped: 0, cleared: 0 };
        try {
            const finale = finaleClient;
            const supabase = createClient();
            if (!supabase) {
                console.warn('[cal-sync] Supabase unavailable â€” skipping purchasing calendar sync');
                return counts;
            }

            // Warm the shared lead time cache + fetch POs in parallel
            const [pos] = await Promise.all([
                finale.getRecentPurchaseOrders(daysBack),
                leadTimeService.warmCache(),
            ]);

            if (pos.length === 0) {
                console.log('[cal-sync] No recent POs found');
                return counts;
            }

            // Load existing Supabase rows into a Map for O(1) lookup
            const { data: existingRows } = await supabase
                .from('purchasing_calendar_events')
                .select('po_number, event_id, calendar_id, status, last_tracking');
            const existing = new Map<string, { event_id: string; calendar_id: string; status: string; last_tracking: string }>();
            for (const row of existingRows ?? []) {
                existing.set(row.po_number, row);
            }

            // Also fetch all tracking numbers and lifecycle data from purchase_orders for the recent POs
            const { data: poRows } = await supabase
                .from('purchase_orders')
                .select('po_number, tracking_numbers, lifecycle_stage, last_movement_summary, tracking_unavailable_at, vendor_acknowledged_at')
                .in('po_number', pos.map(p => p.orderId).filter(Boolean));
            const trackingMap = new Map<string, string[]>();
            const lifecycleMap = new Map<string, Record<string, any>>();
            for (const row of poRows ?? []) {
                trackingMap.set(row.po_number, row.tracking_numbers || []);
                lifecycleMap.set(row.po_number, row);
            }
            const shipmentMap = new Map<string, Awaited<ReturnType<typeof listShipmentsForPurchaseOrders>>[number][]>();
            const shipmentRecords = await listShipmentsForPurchaseOrders(pos.map(p => p.orderId).filter(Boolean));
            for (const shipment of shipmentRecords) {
                for (const poNumber of shipment.po_numbers || []) {
                    if (!shipmentMap.has(poNumber)) shipmentMap.set(poNumber, []);
                    shipmentMap.get(poNumber)!.push(shipment);
                }
            }

            const calendar = new CalendarClient();
            const completionSignals = await loadPOCompletionSignalIndex(supabase, pos.map(p => p.orderId).filter(Boolean));
            const feedbackSync = await syncRecommendationFeedbackForPurchaseOrders(
                pos
                    .filter(po => Boolean(po.orderId))
                    .map(po => ({
                        vendorName: po.vendorName,
                        poNumber: po.orderId,
                        lines: (po.items || []).map(item => ({
                            sku: item.productId,
                            qty: item.quantity,
                        })),
                        completionSignal: completionSignals.get(po.orderId) ?? null,
                    })),
            );

            if (feedbackSync.updatedVendors > 0) {
                console.log(
                    `[cal-sync] Updated purchasing feedback memory for ${feedbackSync.updatedVendors} vendor(s); skipped ${feedbackSync.skippedRecords} incomplete record(s)`,
                );
            }

            for (const po of pos) {
                if (!po.orderId) continue;
                // Skip dropship POs â€” they're pass-through orders, not BuildASoil inventory
                if (po.orderId.toLowerCase().includes('dropship')) continue;
                // Only show committed or received â€” skip drafts and cancelled
                // Show committed, completed, and received POs
                if (!['committed', 'completed', 'received'].includes((po.status || '').toLowerCase())) continue;

                // Determine expected arrival date.
                // NOTE: Finale's dueDate is payment terms (Net 30 etc), NOT delivery estimate â€” ignored.
                // Priority: vendor history median (â‰¥3 completed POs) â†’ 14d global default.
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

                // Get tracking array for this PO
                // Use high-confidence tracking exclusively for calendar consistency
                const { getHighConfidenceTrackingForPOs } = await import('../tracking/shipment-intelligence');
                const highConfTracking = await getHighConfidenceTrackingForPOs([po.orderId]);
                const trackingNumbers = highConfTracking.map((t: any) => t.trackingNumber);

                const trackingStatuses = new Map<string, TrackingStatus | null>();
                for (const t of highConfTracking) {
                    trackingStatuses.set(t.trackingNumber, {
                        category: (t.status.toLowerCase().includes('delivered') ? 'delivered' : 'shipped') as any,
                        display: t.status,
                        public_url: t.carrierUrl || '',
                        estimated_delivery_at: t.eta,
                    });
                }

                // Hash = sorted "num:status" pairs â€” changes when EasyPost status changes
                // Simplified hash - forces update when tracking changes
                const trackingHash = trackingNumbers.sort().join(',') + '|' +
                                   Array.from(trackingStatuses.values()).map(ts => ts?.display || '').join(',');

                const completionSignal = completionSignals.get(po.orderId);
                let actualReceiveDate = resolvePurchaseOrderReceiptDate({
                    status: po.status,
                    receiveDate: po.receiveDate,
                    shipments: po.shipments,
                });
                const completionState = derivePOCompletionState({
                    finaleReceived: hasPurchaseOrderReceipt({
                        status: po.status,
                        receiveDate: po.receiveDate,
                        shipments: po.shipments,
                    }),
                    trackingDelivered: Array.from(trackingStatuses.values()).length > 0 &&
                        Array.from(trackingStatuses.values()).every(ts => ts?.category === 'delivered'),
                    hasMatchedInvoice: completionSignal?.hasMatchedInvoice || false,
                    reconciliationVerdict: completionSignal?.reconciliationVerdict || null,
                    freightResolved: completionSignal?.freightResolved || false,
                    unresolvedBlockers: completionSignal?.unresolvedBlockers || [],
                });
                const latestETA = highConfTracking
                    .map((t: any) => t.eta)
                    .filter(Boolean)
                    .sort()
                    .pop();
                if (actualReceiveDate) {
                    po.receiveDate = actualReceiveDate;
                }

                const derivedExpectedDate = latestETA ? latestETA.split('T')[0] : expectedDate;
                const lifecycle = derivePurchasingLifecycle(po.status, Array.from(trackingStatuses.values()), completionState, derivedExpectedDate, actualReceiveDate, po.shipments);
                const title = this.buildPOEventTitle(po, lifecycle);
                const poLifecycleData = lifecycleMap.get(po.orderId);
                const description = await this.buildPOEventDescription(po, expectedDate, leadProvenance, trackingNumbers, trackingStatuses, lifecycle, latestETA, highConfTracking, poLifecycleData);
                const newStatus = lifecycle.calendarStatus;
                const eventDate = getPurchasingEventDate(expectedDate, actualReceiveDate, lifecycle, latestETA);

                const existingRow = existing.get(po.orderId);

                const colorId = lifecycle.colorId;

                if (!existingRow) {
                    // New PO â€” create calendar event
                    try {
                        const eventId = await calendar.createEvent(PURCHASING_CALENDAR_ID, {
                            title,
                            description,
                            date: eventDate,
                            colorId,
                        });
                        await supabase.from('purchasing_calendar_events').insert({
                            po_number: po.orderId,
                            event_id: eventId,
                            calendar_id: PURCHASING_CALENDAR_ID,
                            status: newStatus,
                            last_tracking: trackingHash
                        });
                        counts.created++;
                        console.log(`ðŸ“… [cal-sync] Created event for PO #${po.orderId} (${po.vendorName}) on ${eventDate}`);
                    } catch (e: any) {
                        console.warn(`[cal-sync] Could not create event for PO #${po.orderId}: ${e.message}`);
                    }
                } else if (existingRow.status !== newStatus || existingRow.last_tracking !== trackingHash || lifecycle.calendarStatus === 'past_due' || lifecycle.calendarStatus === 'exception') {
                    // Status changed, tracking changed, or past-due/exception POs need date flow-forward
                    await calendar.updateEventTitleAndDescription(
                        existingRow.calendar_id,
                        existingRow.event_id,
                        title,
                        description,
                        lifecycle.colorId,
                        eventDate
                    );
                    await supabase.from('purchasing_calendar_events')
                        .update({ status: newStatus, last_tracking: trackingHash, updated_at: new Date().toISOString() })
                        .eq('po_number', po.orderId);
                    counts.updated++;
                    console.log(`📝 [cal-sync] Updated event for PO #${po.orderId}: status=${newStatus} (${lifecycle.prefixText})`);
                } else {
                    counts.skipped++;
                }
            }

            console.log(`[cal-sync] Done â€” ${counts.created} created, ${counts.updated} updated, ${counts.cleared} cleared, ${counts.skipped} skipped`);
        } catch (err: any) {
            console.error('[cal-sync] syncPurchasingCalendar error:', err.message);
        }
        return counts;
    }

    /**
     * Friday morning autonomous ULINE ordering pipeline.
     *
     * DECISION(2026-03-16): Full end-to-end automation:
     *   1. Scan Finale purchasing intelligence for ULINE items below threshold
     *   2. Create draft PO in Finale
     *   3. Fill ULINE Quick Order cart via Chrome automation
     *   4. Send Telegram notification with manifest, PO link, and cart status
     *
     * Runs via cron at 8:30 AM Denver every Friday. Never throws â€” errors are
     * caught and reported via Telegram. Will just reviews cart and checks out.
     */
    async runFridayUlineOrder() {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) return;

        console.log('[uline-friday] ðŸ›’ Starting Friday ULINE auto-order...');

        const { runAutonomousUlineOrder } = await import('../../cli/order-uline');
        const result = await runAutonomousUlineOrder();

        // Case 1: Pipeline error
        if (!result.success) {
            await this.bot.telegram.sendMessage(
                chatId,
                `ðŸš¨ <b>ULINE Friday Order â€” Failed</b>\n\n` +
                `<b>Error:</b> <code>${result.error || 'Unknown error'}</code>\n\n` +
                `Run manually: <code>node --import tsx src/cli/order-uline.ts --auto-reorder --create-po</code>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Case 2: Nothing to order
        if (result.itemCount === 0) {
            await this.bot.telegram.sendMessage(
                chatId,
                `✅ <b>ULINE Friday Order â€” All Stocked</b>\n\n` +
                `Purchasing intelligence scanned all ULINE items.\n` +
                `Everything is above reorder threshold â€” no order needed this week. ðŸŽ‰`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Case 3: Items ordered â€” build rich notification
        const itemLines = result.items
            .map(i => {
                const qtyLabel = i.finaleEachQty === i.effectiveEachQty
                    ? `${i.qty}`
                    : `${i.qty} <i>(Finale ${i.finaleEachQty} ea â†’ ${i.effectiveEachQty} ea)</i>`;
                return `  <code>${i.ulineModel}</code> Ã— ${qtyLabel}  ($${(i.qty * i.unitPrice).toFixed(2)})`;
            })
            .join('\n');

        const poLine = result.finalePO && result.finaleUrl
            ? `ðŸ“„ <a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
            : result.finalePO
                ? `ðŸ“„ Finale PO #${result.finalePO}`
                : 'âš ï¸ PO creation skipped';

        const cartIcon = result.cartVerificationStatus === 'verified'
            ? 'ðŸ›’'
            : result.cartVerificationStatus === 'partial'
                ? 'âš ï¸'
                : 'ðŸŸ¡';

        let msg = `ðŸ›’ <b>ULINE Friday Order â€” Ready for Checkout</b>\n\n`;
        msg += `${poLine}\n`;
        msg += `ðŸ’° Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n`;
        msg += `ðŸ“¦ ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n`;
        msg += `${itemLines}\n\n`;
        msg += `${cartIcon} Cart: ${result.cartResult}\n`;
        if (result.priceUpdatesApplied > 0) {
            msg += `ðŸ’° Draft PO price sync: ${result.priceUpdatesApplied} line item update(s) applied\n`;
        }
        msg += `\n`;
        msg += `<i>Review your ULINE cart and checkout when ready.</i>\n`;
        msg += `<i>ðŸ”— <a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a></i>`;

        await this.bot.telegram.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            // @ts-expect-error Telegraf types lag behind Bot API
            disable_web_page_preview: true,
        });

        console.log(`[uline-friday] ✅ Telegram notification sent (${result.itemCount} items, $${result.estimatedTotal.toFixed(2)})`);
    }

    /**
     * â”€â”€ AXIOM DEMAND SCANNER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     * Periodically scans Finale for suggested reorder quantities for Axiom labels,
     * and queues them up in Supabase for user review on the dashboard.
     */
    async runAxiomDemandScan() {
        console.log(`[ops-manager] Starting Axiom Demand Scan...`);
        try {
            const result = await scanAxiomDemand(finaleClient);
            console.log(`[ops-manager] Completed Axiom Demand Scan: ${result.queuedCount} items queued/updated.`);

            if (result.queuedCount > 0) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    await this.bot.telegram.sendMessage(
                        chatId,
                        `ðŸ·ï¸ <b>Axiom Labels Demand Scan</b>\n\nQueued/Updated ${result.queuedCount} items for reorder.\n<a href="https://buildasoil.dash.app/">Review on Dashboard</a>`,
                        { parse_mode: 'HTML' } // Use standard dash link since Aria dashboard doesn't exist yet/used murp.app
                    ).catch((e: any) => console.warn('[ops-manager] Axiom scan alert failed:', e.message));
                }
            }
        } catch (error: any) {
             console.error(`[ops-manager] Axiom Demand Scan error:`, error.message);
        }
    }

    /**
     * â”€â”€ SLACK ETA SYNC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     * Periodically queries sys_chat_logs for POs requested in Slack threads,
     * checks live tracking ETAs for those POs, and pushes ETA updates
     * to the exact original Slack thread if the ETA display string changed.
     */
    private async pollSlackETAUpdates() {
        const supabase = createClient();
        if (!supabase) return;

        console.log("ðŸšš [Slack ETA Sync] Checking for live ETA updates...");

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        // Find POs mentioned in Slack in the last 30 days that have channelId and threadTs
        const { data: logs, error: logsError } = await supabase
            .from('sys_chat_logs')
            .select('metadata')
            .eq('source', 'slack')
            .gte('created_at', thirtyDaysAgo.toISOString())
            .not('metadata->activePO', 'is', null);

        if (logsError || !logs || logs.length === 0) return;

        // Group unique Slack channels/threads by active PO
        const poToThreads = new Map<string, Set<string>>();
        for (const log of logs) {
            const m = log.metadata;
            if (m && m.activePO && m.channelId && m.threadTs) {
                const po = m.activePO;
                const threadKey = `${m.channelId}:::${m.threadTs}`;
                if (!poToThreads.has(po)) poToThreads.set(po, new Set());
                poToThreads.get(po)!.add(threadKey);
            }
        }

        if (poToThreads.size === 0) return;

        let sentUpdatesCount = 0;

        // Check tracking for each mapped PO
        for (const [poNumber, threads] of poToThreads.entries()) {
            const { data: po } = await supabase
                .from('purchase_orders')
                .select('tracking_numbers, status, last_eta_update')
                .eq('po_number', poNumber)
                .neq('status', 'received')
                .not('tracking_numbers', 'eq', '{}')
                .maybeSingle();

            if (!po || !po.tracking_numbers || po.tracking_numbers.length === 0) continue;

            const previousETAs = (po.last_eta_update as Record<string, string>) || {};
            const newETAs: Record<string, string> = { ...previousETAs };
            let hasUpdates = false;
            const messagesToSend: string[] = [];

            // Check live ETA for each tracking number on the PO
            for (const t of po.tracking_numbers) {
                const ts = await getTrackingStatus(t);
                if (!ts) continue;

                // Did the public-facing status change? (e.g. "In transit" -> "Out for delivery")
                const currentStatus = ts.display;
                if (previousETAs[t] !== currentStatus) {
                    newETAs[t] = currentStatus;
                    hasUpdates = true;
                    
                    const carrier = t.includes(":::") ? t.split(":::")[0] : isFedExNumber(t) ? "FedEx" : "Carrier";
                    const displayNum = t.includes(":::") ? t.split(":::")[1] : t;
                    const link = ts.public_url ? `<${ts.public_url}|${displayNum}>` : displayNum;
                    
                    messagesToSend.push(`ðŸšš *PO#${poNumber} Update*: ${carrier} tracking ${link} is now *${currentStatus}*`);
                }
            }

            // Post ETA update directly into the original Slack thread where the user asked
            if (hasUpdates && messagesToSend.length > 0) {
                const combinedMessage = messagesToSend.join('\n');
                
                if (this.slack) {
                    for (const threadKey of threads) {
                        const [channel, thread_ts] = threadKey.split(":::");
                        try {
                            await this.slack.chat.postMessage({
                                channel,
                                thread_ts,
                                text: combinedMessage
                            });
                            console.log(`  ðŸ’¬ [Slack Watchdog] Pushed ETA update to thread for PO#${poNumber}`);
                            sentUpdatesCount++;
                        } catch (err: any) {
                            console.error(`  âŒ Failed to post ETA to Slack thread: ${err.message}`);
                        }
                    }
                }

                // Persist the new state so we don't send duplicate alerts
                const updateRes = await supabase.from('purchase_orders')
                    .update({ last_eta_update: newETAs })
                    .eq('po_number', poNumber);
                    
                if (updateRes.error) {
                    console.error(`  âŒ Failed to save last_eta_update for PO#${poNumber}:`, updateRes.error.message);
                }
            }
        }

        if (sentUpdatesCount > 0) {
            console.log(`ðŸšš [Slack ETA Sync] Sent ${sentUpdatesCount} thread updates.`);
        }
    }
}
