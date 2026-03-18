/**
 * @file    ops-manager.ts
 * @purpose Handles background operations: PO tracking, email filtering, summaries,
 *          and daily Calendar BOM build risk analysis.
 *          Cross-posts daily/weekly summaries to both Telegram and Slack #purchasing.
 *          Posts completed build notifications to the MFG Google Calendar.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-04
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
import { CalendarClient, CALENDAR_IDS, PURCHASING_CALENDAR_ID } from "../google/calendar";
import type { FullPO } from "../finale/client";
import { BuildParser } from "./build-parser";
import { FinaleClient, finaleClient } from "../finale/client";
import FirecrawlApp from "@mendable/firecrawl-js";
import { generateSelfReview, syncLearningsToMemory, runHousekeeping } from "./feedback-loop";
import { scanAxiomDemand } from "../purchasing/axiom-scanner";
import { runPOSweep } from "../matching/po-sweep";

const TRACKING_PATTERNS = {
    ups: /\b1Z[0-9A-Z]{16}\b/i,
    // FedEx: 12-digit express, 15-digit ground, or 96XXXXXXXXXXXXXXXXXX (20-digit SmartPost)
    fedex: /\b(96\d{18}|\d{15}|\d{12})\b/,
    usps: /\b(94|92|93|95)\d{20}\b/,
    dhl: /\bJD\d{18}\b/i,
    // generic: require '#' or ':' separator — prevents "tracking information" false matches
    // keyword is non-capturing (?:...) so match[1] is always the tracking number
    generic: /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/i,
    // LTL freight identifiers — whitespace required after keyword
    pro: /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/i,
    bol: /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/i,
};

// LTL carrier keyword detection — ordered by specificity (most specific first)
const LTL_CARRIER_KEYWORDS: [RegExp, string][] = [
    [/\bold\s+dominion\s+freight\b/i, "Old Dominion"],
    [/\bold\s+dominion\b/i, "Old Dominion"],
    [/\bodfl\b/i, "Old Dominion"],
    [/\bdayton\s+freight\b/i, "Dayton Freight"],
    [/\bfedex\s+freight\b/i, "FedEx Freight"],
    [/\br\s*&\s*l\s+carriers?\b/i, "R&L Carriers"],
    [/\brl\s+carriers?\b/i, "R&L Carriers"],
    [/\bxpo\s+logistics\b/i, "XPO Logistics"],
    [/\bxpo\b/i, "XPO Logistics"],
    [/\btforce\s+freight\b/i, "TForce Freight"],
    [/\bups\s+freight\b/i, "TForce Freight"],
    [/\byrc\s+freight\b/i, "YRC Freight"],
    [/\byellow\s+freight\b/i, "Yellow Freight"],
    [/\bcentral\s+transport\b/i, "Central Transport"],
    [/\babf\s+freight\b/i, "ABF Freight"],
    [/\barcbest\b/i, "ArcBest"],
    [/\bestes\s+express\b/i, "Estes"],
    [/\bestes\b/i, "Estes"],
    [/\bsaia\b/i, "Saia"],
];

function detectLTLCarrier(text: string): string | null {
    for (const [pattern, name] of LTL_CARRIER_KEYWORDS) {
        if (pattern.test(text)) return name;
    }
    return null;
}

export type TrackingCategory = 'delivered' | 'out_for_delivery' | 'in_transit' | 'exception';
export interface TrackingStatus { category: TrackingCategory; display: string; public_url?: string; }


const LTL_DIRECT_LINKS: Record<string, string> = {
    "Old Dominion Freight Line": "https://www.odfl.com/trace/Trace.jsp?pro={PRO}",
    "Old Dominion": "https://www.odfl.com/trace/Trace.jsp?pro={PRO}",
    "Saia": "https://www.saia.com/tracking?pro={PRO}",
    "Estes": "https://www.estes-express.com/tracking?pro={PRO}",
    "R&L Carriers": "https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro={PRO}",
    "XPO Logistics": "https://app.xpo.com/track/pro/{PRO}",
    "Dayton Freight": "https://www.daytonfreight.com/tracking/?pro={PRO}",
    "FedEx Freight": "https://www.fedex.com/fedextrack/?tracknumbers={PRO}",
    "UPS Freight": "https://www.tforcefreight.com/ltl/apps/Tracking?type=P&HAWB={PRO}",
    "TForce Freight": "https://www.tforcefreight.com/ltl/apps/Tracking?type=P&HAWB={PRO}",
    "YRC Freight": "https://my.yrc.com/tools/track/shipments?referenceNumber={PRO}",
    "Yellow Freight": "https://my.yrc.com/tools/track/shipments?referenceNumber={PRO}",
    "Central Transport": "https://www.centraltransport.com/forms/tracking.aspx?pro={PRO}",
    "ABF Freight": "https://arcb.com/tools/tracking.html?pro={PRO}",
    "ArcBest": "https://arcb.com/tools/tracking.html?pro={PRO}"
};

function carrierUrl(trackingNumber: string): string {
    // Check if it's an LLM-encoded string (Carrier:::Number)
    if (trackingNumber.includes(":::")) {
        const [carrierName, actualNumber] = trackingNumber.split(":::", 2);

        // Find a matching LTL direct link if available
        const knownCarrier = Object.keys(LTL_DIRECT_LINKS).find(k =>
            carrierName.toLowerCase().includes(k.toLowerCase())
        );

        if (knownCarrier) {
            return LTL_DIRECT_LINKS[knownCarrier].replace("{PRO}", encodeURIComponent(actualNumber));
        }

        // Fallback for an unknown LTL carrier that we still scraped
        return `https://parcelsapp.com/en/tracking/${actualNumber}`;
    }

    if (/^1Z/i.test(trackingNumber)) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    if (/^(94|92|93|95)/.test(trackingNumber)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    if (/^JD/i.test(trackingNumber)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
    if (/\b(96\d{18}|\d{15}|\d{12})\b/.test(trackingNumber)) return `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`;
    // Fallback for PRO, BOL, or generic 
    return `https://parcelsapp.com/en/tracking/${trackingNumber}`;
}

/**
 * Parse delivery status from carrier page markdown using regex — no LLM.
 */
function parseTrackingContent(content: string): TrackingStatus | null {
    // Delivered — check first; most definitive
    const deliveredDate = content.match(
        /delivered\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (deliveredDate) return { category: 'delivered', display: `Delivered ${deliveredDate[1]}` };
    if (/\bdelivered\b/i.test(content)) return { category: 'delivered', display: 'Delivered' };

    // Out for delivery
    if (/out\s+for\s+delivery/i.test(content))
        return { category: 'out_for_delivery', display: 'Out for delivery' };

    // Exception / delay
    if (/\bexception\b|\bdelay(ed)?\b|unable to deliver/i.test(content))
        return { category: 'exception', display: 'Delivery exception' };

    // Estimated / scheduled / expected delivery date — optional day-of-week prefix handled
    const eta = content.match(
        /(?:estimated|scheduled|expected)\s+delivery[:\s]+(?:[A-Z][a-z]+,\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (eta) return { category: 'in_transit', display: `Expected ${eta[1]}` };

    // "by end of day <date>"
    const eod = content.match(/by\s+end\s+of\s+(?:business\s+)?day[,\s]+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
    if (eod) return { category: 'in_transit', display: `Expected by ${eod[1]}` };

    // Generic in-transit signals
    if (/in\s+transit|on\s+the\s+way|picked\s+up|departed/i.test(content))
        return { category: 'in_transit', display: 'In transit' };

    return null;
}

import EasyPostClient from "@easypost/api";

// FedEx OAuth token cache — avoid re-authing on every call (tokens last 1h)
let _fedexToken: string | null = null;
let _fedexTokenExpiry = 0;

/**
 * Detect if a tracking number looks like FedEx format.
 * 12-digit, 15-digit, 20-digit, or 96-prefix numbers.
 */
function isFedExNumber(num: string): boolean {
    return /^\d{12}$/.test(num) || /^\d{15}$/.test(num) || /^96\d{18,20}$/.test(num) || /^\d{20}$/.test(num);
}

/**
 * Track a FedEx shipment directly via FedEx Track API (free with account credentials).
 * No per-call cost — uses BuildASoil's own FedEx developer account.
 */
async function getFedExTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    try {
        // Refresh OAuth token if expired
        if (!_fedexToken || Date.now() >= _fedexTokenExpiry) {
            const authRes = await fetch('https://apis.fedex.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(),
            });
            if (!authRes.ok) throw new Error(`FedEx auth ${authRes.status}: ${await authRes.text()}`);
            const auth = await authRes.json() as { access_token: string; expires_in: number };
            _fedexToken = auth.access_token;
            _fedexTokenExpiry = Date.now() + (auth.expires_in - 60) * 1000; // 60s buffer
        }

        const trackRes = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${_fedexToken}`,
                'X-locale': 'en_US',
            },
            body: JSON.stringify({
                trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
                includeDetailedScans: false,
            }),
        });

        if (!trackRes.ok) throw new Error(`FedEx track ${trackRes.status}: ${await trackRes.text()}`);
        const data = await trackRes.json() as any;

        const result = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
        if (!result) return null;

        const statusCode: string = result.latestStatusDetail?.code ?? '';
        const dates: any[] = result.dateAndTimes ?? [];
        const deliveredEntry = dates.find((d: any) => d.type === 'ACTUAL_DELIVERY');
        const estEntry = result.estimatedDeliveryTimeWindow?.window?.ends;

        switch (statusCode) {
            case 'DL': {
                let display = 'Delivered';
                if (deliveredEntry?.dateTime) {
                    const d = new Date(deliveredEntry.dateTime);
                    display = `Delivered ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'delivered', display, public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            }
            case 'OD':
                return { category: 'out_for_delivery', display: 'Out for delivery', public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            case 'DE':
                return { category: 'exception', display: 'Delivery exception', public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            default: {
                let display = 'In transit';
                if (estEntry) {
                    const e = new Date(estEntry);
                    display = `Expected ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'in_transit', display, public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            }
        }
    } catch (err: any) {
        console.warn(`[tracking-api] FedEx direct track failed for ${trackingNumber}: ${err.message}`);
        return null;
    }
}

/**
 * Fetch tracking status directly from EasyPost API.
 * Returns null if tracking fails.
 */
async function getLTLTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    // trackingNumber must be "CarrierName:::PRO#" format
    if (!trackingNumber.includes(":::")) return null;
    const url = carrierUrl(trackingNumber);
    // parcelsapp fallback means unknown carrier — skip fetch
    if (url.includes("parcelsapp.com")) return null;

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const html = await res.text();
        // Strip HTML tags, collapse whitespace
        const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
        const parsed = parseTrackingContent(text);
        if (parsed) return { ...parsed, public_url: url };
    } catch (e: any) {
        // Timeout, network error, JS-only page — silently ignore, link is still clickable
    }
    return null;
}

export async function getTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    const rawNumber = trackingNumber.includes(":::") ? trackingNumber.split(":::", 2)[1] : trackingNumber;

    // LTL (:::) — try carrier page fetch first (free, no credentials)
    if (trackingNumber.includes(":::")) {
        return getLTLTrackingStatus(trackingNumber);
    }

    // Parcel FedEx — direct FedEx API (free with account credentials)
    if (isFedExNumber(rawNumber)) {
        return getFedExTrackingStatus(rawNumber);
    }

    const apiKey = process.env.EASYPOST_API_KEY;
    if (!apiKey) return null;

    try {
        const client = new EasyPostClient(apiKey);

        let reqParam: any = { tracking_code: trackingNumber };

        const tracker = await client.Tracker.create(reqParam);

        // EasyPost statuses: unknown, pre_transit, in_transit, out_for_delivery, delivered, available_for_pickup, return_to_sender, failure, cancelled, error
        switch (tracker.status) {
            case "delivered": {
                // Return actual delivered date
                let dDisplay = "Delivered";
                if (tracker.updated_at) {
                    const d = new Date(tracker.updated_at);
                    dDisplay = `Delivered ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                }
                return { category: 'delivered', display: dDisplay, public_url: tracker.public_url };
            }
            case "out_for_delivery":
                return { category: 'out_for_delivery', display: 'Out for delivery', public_url: tracker.public_url };
            case "failure":
            case "error":
            case "return_to_sender":
            case "cancelled":
                return { category: 'exception', display: 'Delivery exception', public_url: tracker.public_url };
            case "in_transit":
            case "pre_transit":
            default: {
                let dDisplay = "In transit";
                if (tracker.est_delivery_date) {
                    const e = new Date(tracker.est_delivery_date);
                    dDisplay = `Expected ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
                }
                return { category: 'in_transit', display: dDisplay, public_url: tracker.public_url };
            }
        }
    } catch (err: any) {
        // Suppress billing/insufficient funds errors so it doesn't pollute the logs
        if (err.message && err.message.includes("Insufficient funds")) {
            console.warn(`[tracking-api] EasyPost billing error for ${trackingNumber} — add card to clear.`);
        } else {
            console.warn(`[tracking-api] Failed to track ${trackingNumber}: ${err.message}`);
        }
        return null;
    }
}

/**
 * Build an RFC 2822 raw email string for a vendor follow-up reply.
 * Returns a raw MIME email suitable for Gmail's `users.messages.send` (before base64url encoding).
 */
function buildFollowUpEmail(opts: {
    to: string;
    subject: string;
    inReplyTo: string;
    references: string;
    body: string;
}): string {
    const lines = [
        `From: bill.selee@buildasoil.com`,
        `To: ${opts.to}`,
        `Subject: ${opts.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
    ];
    if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) lines.push(`References: ${opts.references}`);
    lines.push('', opts.body);
    return lines.join('\r\n');
}

/**
 * Main Operations Manager Class
 */
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
        // Slack posting is best-effort — if SLACK_BOT_TOKEN is missing, we
        // gracefully skip Slack without blocking the Telegram message.
        const slackToken = process.env.SLACK_BOT_TOKEN;
        this.slack = slackToken ? new WebClient(slackToken) : null;
        this.slackChannel = process.env.SLACK_MORNING_CHANNEL || "#purchasing";

        if (!this.slack) {
            console.warn("⚠️ OpsManager: SLACK_BOT_TOKEN not set — Slack cross-posting disabled.");
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
     * Safely executes a scheduled task, catching unhandled errors and handing them off 
     * to the Supervisor exception queue instead of crashing silently or blindly alerting.
     */
    private async safeRun(taskName: string, task: () => Promise<any> | any) {
        try {
            await task();
        } catch (error: any) {
            console.error(`🚨 [${taskName}] Crashed during execution. Handing to Supervisor...`, error.message);
            try {
                // Hand over to the exceptions queue
                const supabase = createClient();
                await supabase.from('ops_agent_exceptions').insert({
                    agent_name: taskName,
                    error_message: error.message || "Unknown error",
                    error_stack: error.stack || ""
                });
            } catch (queueErr) {
                console.error(`     ❌ Failed to write crash exception for ${taskName} to DB:`, queueErr);

                // Absolute fallback in case the DB is down
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId && this.bot) {
                    await this.bot.telegram.sendMessage(
                        chatId,
                        `🚨 <b>DB Unavailable - Crash Escalation</b> 🚨\n\n<b>Agent:</b> ${taskName}\n<b>Error:</b> ${error.message}`,
                        { parse_mode: 'HTML' }
                    ).catch(() => { });
                }
            }
        }
    }

    /**
     * Start all scheduled tasks
     */
    start() {
        console.log("🚀 Starting Ops Manager Scheduler...");

        // Hydrate dedup Sets from Supabase/Finale so a restart doesn't re-alert on
        // builds completed or POs received in the last 2 hours.
        this.hydrateSeenSets().catch(err =>
            console.warn('[ops-manager] hydrateSeenSets failed (non-fatal):', err.message)
        );

        // Supervisor checking errors
        cron.schedule("*/5 * * * *", () => {
            this.safeRun("Supervisor", () => this.supervisor.supervise());
        });

        // Email Ingestion Worker grabs raw emails from Gmail to Supabase queue
        cron.schedule("*/5 * * * *", () => {
            this.safeRun("EmailIngestionDefault", () => this.emailIngestionDefault.run(50));
            // TODO(will)[2026-03-11]: Re-enable when token-ap.json is created via:
            //   npx tsx src/cli/gmail-auth.ts ap
            // Disabled because the AP Gmail account isn't authorized yet.
            this.safeRun("EmailIngestionAP", () => this.emailIngestionAP.run(50));
        });

        // AP Identifier scans for unread PDFs every 15 minutes and queues them
        cron.schedule("*/15 * * * *", () => {
            this.safeRun("APIdentifierAgent", () => this.apIdentifier.identifyAndQueue());
        });

        // AP Forwarder ships queued invoices to Bill.com every 15 minutes
        cron.schedule("2-59/15 * * * *", () => {
            this.safeRun("APForwarderAgent", () => this.apForwarder.processPendingForwards());
        });

        // Acknowledgement Agent runs every 12 minutes to routinely thank vendors
        cron.schedule("*/12 * * * *", () => {
            this.safeRun("AcknowledgementAgent", () => this.ackAgent.processUnreadEmails(20));
        });

        // Daily Summary @ 8:00 AM weekdays only
        cron.schedule("0 8 * * 1-5", () => {
            this.safeRun("DailySummary", () => this.sendDailySummary());
        }, { timezone: "America/Denver" });

        // Active Purchases Ledger to Slack @ 8:15 AM weekdays
        cron.schedule("15 8 * * 1-5", () => {
            this.safeRun("SlackPurchasesReport", () => this.postActivePurchasesToSlack());
        }, { timezone: "America/Denver" });

        // Friday Summary @ 8:01 AM
        cron.schedule("1 8 * * 5", () => {
            this.safeRun("WeeklySummary", () => this.sendWeeklySummary());
        }, { timezone: "America/Denver" });

        // ── AXIOM LABEL SCANNER ─────────────────────────────
        // DECISION(2026-03-17): Runs purely autonomously to identify label demand
        // and add them to the queue for review on the dashboard.
        cron.schedule("15 8 * * 1-5", () => {
            this.safeRun("AxiomDemandScan", () => this.runAxiomDemandScan());
        }, { timezone: "America/Denver" });

        // ── ULINE FRIDAY AUTO-ORDER ──────────────────────────
        // DECISION(2026-03-16): Fully autonomous ULINE ordering pipeline.
        // Runs every Friday at 8:30 AM Denver time. Flow:
        //   1. Scan Finale purchasing intelligence for ULINE items below reorder threshold
        //   2. Create a draft PO in Finale with those items
        //   3. Open Chrome → fill ULINE Quick Order cart via Paste Items
        //   4. Send Telegram notification with full manifest
        // Will just needs to review the cart and click checkout.
        // If zero items need reordering, sends a brief "all stocked" message.
        cron.schedule("30 8 * * 5", () => {
            this.safeRun("UlineFridayOrder", () => this.runFridayUlineOrder());
        }, { timezone: "America/Denver" });

        // Email Maintenance (Advertisements) every hour
        cron.schedule("0 * * * *", () => {
            this.safeRun("AdMaintenance", () => this.processAdvertisements());
        });

        // Tracking Agent polls processing queue every 60 minutes
        cron.schedule("0 * * * *", () => {
            this.safeRun("TrackingAgent", () => this.trackingAgent.processUnreadEmails());
        });

        // PO Sync every 30 minutes
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("POSync", () => this.syncPOConversations());
        });

        // PO-First AP Sweep (invoice reconciliation backfill) every 4 hours
        // DECISION(2026-03-18): Provides a fallback net for invoices that couldn't be
        // matched at ingestion time due to missing PO data or delay in Finale commitment.
        cron.schedule("30 */4 * * *", () => {
            this.safeRun("POSweep", () => runPOSweep(60, false));
        });

        // Build Completion Watcher every 30 minutes
        // Polls Finale for newly-completed build orders, sends Telegram alert,
        // and appends a completion timestamp to the matching calendar event description.
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("BuildCompletionWatcher", () => this.pollBuildCompletions());
        });

        // PO Receiving Watcher every 30 minutes
        // Polls Finale for today's newly-received purchase orders and sends Telegram alerts.
        cron.schedule("*/30 * * * *", () => {
            this.safeRun("POReceivingWatcher", () => this.pollPOReceivings());
        });

        // Purchasing Calendar Sync every 4 hours
        // Creates/updates calendar events for outgoing and received POs.
        cron.schedule("0 */4 * * *", () => {
            this.safeRun("PurchasingCalendarSync", () => this.syncPurchasingCalendar());
        });

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
                    `☀️ <b>Aria Morning Check-In</b>\n\n` +
                    `✅ Bot is online and healthy\n` +
                    `⏱ Uptime: ${uptimeHrs}h | Memory: ${heapMB}MB\n` +
                    `📋 Next: Build Risk (7:30), Daily Summary (8:00)`,
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

        // OOS Report Generator — polls every 5 min between 7:45–9:05 AM weekdays
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
                            `📋 <b>OOS Report Generated</b>\n\n` +
                            `📊 ${result.totalItems} out-of-stock items analyzed\n` +
                            `🚨 ${result.needsOrder.length} need ordering\n` +
                            `✅ ${result.onOrder.length} on order\n` +
                            `⚠️ ${result.agingPOs.length} aging POs\n` +
                            `🔧 ${result.internalBuild.length} internal builds\n\n` +
                            `📁 Saved to: <code>${result.outputPath}</code>`,
                            { parse_mode: "HTML" }
                        );
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

        // ── KAIZEN FEEDBACK LOOP CRONS ─────────────────────

        // Weekly Kaizen Self-Review — Fridays 8:15 AM Denver
        cron.schedule("15 8 * * 5", () => this.safeRun("KaizenSelfReview", async () => {
            const report = await generateSelfReview(7);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                await this.bot.telegram.sendMessage(chatId, report, { parse_mode: "HTML" });
            }
        }), { timezone: "America/Denver" });

        // Daily Memory Sync — every night at 10:00 PM Denver
        cron.schedule("0 22 * * *", () => this.safeRun("KaizenMemorySync", async () => {
            const synced = await syncLearningsToMemory();
            if (synced > 0) {
                console.log(`🧠 [Kaizen] Nightly sync: ${synced} learnings pushed to Pinecone`);
            }
        }), { timezone: "America/Denver" });

        // Nightly Housekeeping — 11:00 PM Denver (prune stale data everywhere)
        cron.schedule("0 23 * * *", () => this.safeRun("NightlyHousekeeping", async () => {
            const report = await runHousekeeping();
            // Only alert Will via Telegram if cleanup was surprisingly large
            if (report.totalReclaimed > 500) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    await this.bot.telegram.sendMessage(
                        chatId,
                        `🧹 <b>Large cleanup alert:</b> ${report.totalReclaimed} rows/vectors pruned tonight. Check logs for details.`,
                        { parse_mode: "HTML" }
                    );
                }
            }
        }), { timezone: "America/Denver" });

        // Daily Dedup Set Reset — midnight Denver (OOM prevention)
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
     * Move advertisements to label
     */
    async processAdvertisements() {
        console.log("🧹 Running Advertisement Cleanup...");
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
        console.log("📦 Syncing PO Conversations...");
        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            // Only scan POs from the last 14 days — tracking arrives well within that window
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

                for (const msg of thread.messages.slice(1)) {
                    const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "";
                    if (!from.includes("buildasoil.com")) {
                        responseAt = parseInt(msg.internalDate!);
                        break;
                    }
                }

                const responseTimeMins = responseAt ? Math.round((responseAt - sentAt) / 60000) : null;

                // 🔍 Extract Tracking Numbers from full message body (snippet is too short — truncates numbers)
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
                            // pro/bol/generic: group[1] is the number; others: full match[0]
                            const trackingNum = ['generic', 'pro', 'bol'].includes(carrier) ? (match[1] || match[0]) : match[0];
                            // Must contain ≥2 digits — filters pure-word false positives
                            const hasDigits = (trackingNum?.match(/\d/g)?.length ?? 0) >= 2;
                            if (!trackingNum || !hasDigits) continue;
                            // For PRO/BOL: encode with carrier name if detected in same message
                            const encoded = (carrier === 'pro' || carrier === 'bol') && ltlCarrier
                                ? `${ltlCarrier}:::${trackingNum}`
                                : trackingNum;
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

                // Always read existing tracking so we can merge — never overwrite inbox-sourced tracking
                const { data: existingPO } = await supabase.from("purchase_orders").select("tracking_numbers, line_items").eq("po_number", poNumber).maybeSingle();
                const oldTracking = existingPO?.tracking_numbers || [];
                // Merge: inbox-backfilled numbers stay even if PO thread doesn't mention them
                const mergedTracking = [...new Set([...oldTracking, ...trackingNumbers])];

                // Alert for NEW tracking numbers
                if (trackingNumbers.length > 0) {
                    const newTracking = trackingNumbers.filter(t => !oldTracking.includes(t));

                    if (newTracking.length > 0) {
                        // Persist tracking numbers FIRST — prevents duplicate alerts if two
                        // processes run concurrently (e.g. PM2 restart during a sync cycle).
                        await supabase.from("purchase_orders").upsert({
                            po_number: poNumber,
                            vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                            vendor_response_time_minutes: responseTimeMins,
                            tracking_numbers: mergedTracking,
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
                            ? `Items: ${poDetails.lineItems.map(i => `<code>${i.sku}</code> ×${i.qty}`).join(', ')}`
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

                // Index to Pinecone for RAG — sanitize nulls (Pinecone rejects null metadata values)
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

                // Update DB (full record sync — use merged tracking to preserve inbox-sourced numbers)
                await supabase.from("purchase_orders").upsert({
                    po_number: poNumber,
                    vendor_name: vendorName,
                    vendor_response_at: responseAt ? new Date(responseAt).toISOString() : null,
                    vendor_response_time_minutes: responseTimeMins,
                    tracking_numbers: mergedTracking,
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
                        // Non-fatal — catalog will populate on next sync cycle
                    }
                }

                // Update vendor intelligence profile — accumulate known email addresses
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

                // ── Vendor follow-up + outside-thread search (non-responders only) ──
                // DECISION(2026-03-13): Reordered logic — search for outside-thread
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
                                        `📧 Found <b>${vendorName}</b> email outside PO thread\nPO #${poNumber} | Subject: ${outsideSubject}\n"${snippet.slice(0, 250)}"`,
                                        { parse_mode: "HTML" }
                                    );
                                    if (outsideTracking.length > 0) {
                                        const merged = [...new Set([...trackingNumbers, ...outsideTracking])];
                                        await supabase.from("purchase_orders").upsert({
                                            po_number: poNumber,
                                            tracking_numbers: merged,
                                            updated_at: new Date().toISOString(),
                                        }, { onConflict: "po_number" });
                                    }
                                }
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Outside-thread search failed for ${vendorDomain}: ${e.message}`);
                        }
                    }

                    // 2. Follow-up email in original thread (once per PO, only if vendor
                    //    has NOT communicated at all — including outside-thread emails)
                    if (!vendorCommunicatedOutsideThread) {
                        try {
                            const { data: poRow } = await supabase
                                .from("purchase_orders")
                                .select("follow_up_sent_at")
                                .eq("po_number", poNumber)
                                .maybeSingle();

                            if (!poRow?.follow_up_sent_at) {
                                const sentDateStr = new Date(sentAt).toLocaleDateString('en-US', {
                                    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver',
                                });
                                const firstMsgId = firstMsg.payload?.headers?.find((h: any) => h.name === 'Message-ID')?.value || '';
                                const rawEmail = buildFollowUpEmail({
                                    to: vendorEmail,
                                    subject: `Re: ${subject}`,
                                    inReplyTo: firstMsgId,
                                    references: firstMsgId,
                                    body: `Hi,\n\nFollowing up on PO #${poNumber} sent ${sentDateStr}. Could you share an expected ship date or tracking number?\n\nThank you!`,
                                });
                                await gmail.users.messages.send({
                                    userId: 'me',
                                    requestBody: { raw: Buffer.from(rawEmail).toString('base64url'), threadId: m.threadId! },
                                });
                                await supabase.from("purchase_orders").upsert({
                                    po_number: poNumber,
                                    follow_up_sent_at: new Date().toISOString(),
                                    updated_at: new Date().toISOString(),
                                }, { onConflict: "po_number" });
                                console.log(`📧 [po-sync] Sent follow-up to ${vendorEmail} for PO #${poNumber}`);
                                this.bot.telegram.sendMessage(
                                    process.env.TELEGRAM_CHAT_ID || "",
                                    `📧 Sent ETA follow-up to <b>${vendorName}</b> for PO #${poNumber} (${sentDateStr}, no response in 3+ days)`,
                                    { parse_mode: "HTML" }
                                );
                            }
                        } catch (e: any) {
                            console.warn(`[po-sync] Follow-up email failed for PO #${poNumber}: ${e.message}`);
                        }
                    } else {
                        console.log(`📧 [po-sync] Skipping follow-up for PO #${poNumber} — vendor ${vendorName} already communicated outside PO thread`);
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
            console.error(`❌ Slack post failed (${label}):`, err.data?.error || err.message);
        }
    }

    /**
     * Generate and send the daily summary to Telegram + Slack.
     */
    async sendDailySummary() {
        console.log("📊 Preparing Daily PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("yesterday");

        const summary = await this.generateLLMSummary("Daily", opsData);
        const telegramMsg = `📊 **Morning Operations Summary**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // 2. Cross-post to Slack #purchasing
        const slackMsg = `:chart_with_upwards_trend: *Morning Operations Summary*\n\n${summary}`;
        await this.postToSlack(slackMsg, "Daily Summary");
    }

    /**
     * Generate and send the weekly summary (Friday) to Telegram + Slack.
     */
    async sendWeeklySummary() {
        console.log("📅 Preparing Weekly PO Summary...");
        const opsData = await this.getOperationsStatsForTimeframe("week");

        const summary = await this.generateLLMSummary("Weekly", opsData);
        const telegramMsg = `🗓️ **Friday Weekly Operations Review**\n\n${summary}`;

        // 1. Always send to Telegram first (primary channel)
        this.bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID || "",
            telegramMsg,
            { parse_mode: "Markdown" }
        );

        // 2. Cross-post to Slack #purchasing
        const slackMsg = `:calendar: *Friday Weekly Operations Review*\n\n${summary}`;
        await this.postToSlack(slackMsg, "Weekly Summary");
    }

    /**
     * Gets the active purchases list (used by Dashboard API and Slack).
     */
    async getActivePurchasesList(daysBack: number = 60) {
        // Fetch last N days of POs to ensure we get active ones
        const pos = await finaleClient.getRecentPurchaseOrders(daysBack);
        await leadTimeService.warmCache();

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        // Fetch tracking from Supabase
        const supabase = createClient();
        const poNumbers = pos.map(p => p.orderId).filter(Boolean);
        const trackingMap = new Map<string, string[]>();

        if (supabase && poNumbers.length > 0) {
            try {
                for (let i = 0; i < poNumbers.length; i += 100) {
                    const chunk = poNumbers.slice(i, i + 100);
                    const { data: dbPOs } = await supabase
                        .from("purchase_orders")
                        .select("po_number, tracking_numbers")
                        .in("po_number", chunk);

                    for (const dp of dbPOs || []) {
                        trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                    }
                }
            } catch (e: any) {
                console.warn("[ops-manager] active purchases tracking fetch failed:", e.message);
            }
        }

        const activePos = [];

        function addDaysLoc(dateStr: string, days: number): string {
            const d = new Date(dateStr);
            d.setUTCDate(d.getUTCDate() + days);
            return d.toISOString().split("T")[0];
        }

        for (const po of pos) {
            if (!po.orderId) continue;
            // Skip dropship POs
            if (po.orderId.toLowerCase().includes("dropship")) continue;

            const status = (po.status || "").toLowerCase();
            // Only show committed or completed — skip drafts and cancelled
            if (!["committed", "completed"].includes(status)) continue;

            const isReceived = status === "completed";

            // If received, auto-remove after 5 days
            if (isReceived && po.receiveDate) {
                const recDate = new Date(po.receiveDate);
                recDate.setHours(0, 0, 0, 0);
                const diffTime = Math.abs(now.getTime() - recDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays > 5) {
                    continue; // skip received > 5 days ago
                }
            }

            // Calculate expected date like the calendar
            let expectedDate: string;
            let leadProvenance: string;

            if (po.orderDate) {
                const lt = await leadTimeService.getForVendor(po.vendorName);
                expectedDate = addDaysLoc(po.orderDate, lt.days);
                leadProvenance = lt.label;
            } else {
                expectedDate = new Date().toISOString().split("T")[0];
                leadProvenance = "14d default";
            }

            activePos.push({
                ...po,
                expectedDate,
                leadProvenance,
                isReceived,
                trackingNumbers: trackingMap.get(po.orderId) || []
            });
        }

        activePos.sort((a, b) => {
            const da = new Date(a.orderDate || 0).getTime();
            const db = new Date(b.orderDate || 0).getTime();
            return db - da; // newest first
        });

        return activePos;
    }

    /**
     * Build and post the Active Purchases Ledger to Slack.
     */
    async postActivePurchasesToSlack() {
        console.log("🛒 Preparing Active Purchases Slack Ledger...");
        if (!this.slack) {
            console.log("Skipping Slack ledger: Slack not configured");
            return;
        }

        try {
            // Slack ledger only shows the trailing 14 days (two weeks) of POs to reduce noise
            const purchases = await this.getActivePurchasesList(14);
            if (purchases.length === 0) return; // Silent if no active purchases

            let msg = `:ledger: *Active Purchases Ledger*\n_Running list of incoming shipments from the last 14 days (auto-clears 5 days after receipt)_\n\n`;

            for (const p of purchases) {
                const rcvd = p.isReceived;
                const icon = this.poStatusEmoji(p.status);

                let block = `${icon} *<${p.finaleUrl}|PO# ${p.orderId}>* — ${p.vendorName}\n`;

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
                const itemLines = p.items.slice(0, 5).map((i: any) => `${i.productId} × ${i.quantity.toLocaleString()}`);
                if (p.items.length > 5) itemLines.push(`+ ${p.items.length - 5} more`);
                block += `> Items: ${itemLines.join(', ')}\n`;

                block += `> Total: $${p.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;

                msg += block + "\n";
            }

            await this.postToSlack(msg, "Active Purchases Ledger");
        } catch (e: any) {
            console.error(`❌ Active Purchases Ledger failed:`, e.message);
        }
    }


    /**
     * Run the Calendar BOM build risk analysis and post results.
     * Fetches production calendars → parses events → explodes BOMs → checks stock.
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
        // Hydrate build completions: load today's completions from Supabase (midnight MT → now)
        // Using today rather than 2h prevents re-alerting after a mid-day restart.
        try {
            const db = createClient();
            if (db) {
                const todayMidnight = new Date();
                todayMidnight.setHours(0, 0, 0, 0);  // local midnight — conservative, always earlier than MT midnight
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
                    `📦 *PO Received*\n` +
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

                        const receivedDate = po.receiveDate
                            ? new Date(po.receiveDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                            : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                        const title = `✅ PO #${po.orderId} — ${po.supplier}`;
                        const itemLines = po.items.slice(0, 5)
                            .map(i => `${i.productId} × ${i.quantity.toLocaleString()}`)
                            .join('\n');
                        const moreStr = po.items.length > 5 ? `\n+ ${po.items.length - 5} more` : '';
                        const description =
                            `Ordered: ${po.orderDate ? new Date(po.orderDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown'} | Received: ${receivedDate}\n` +
                            `Items:\n${itemLines}${moreStr}\n` +
                            `Total: $${po.total.toLocaleString()}\n` +
                            `Status: Received\n` +
                            `→ <a href="${po.finaleUrl}">PO# ${po.orderId}</a>`;

                        const calendar = new CalendarClient();
                        await calendar.updateEventTitleAndDescription(calRow.calendar_id, calRow.event_id, title, description);

                        await supabase.from('purchasing_calendar_events')
                            .update({ status: 'received', updated_at: new Date().toISOString() })
                            .eq('po_number', po.orderId);

                        console.log(`📅 [po-watcher] Calendar event updated for PO ${po.orderId}`);
                    } catch (e: any) {
                        console.warn('[po-watcher] Calendar update failed:', e.message);
                    }
                });

                console.log(`📦 [po-watcher] PO received: ${po.orderId} from ${po.supplier} (${itemCount} units)`);

                // ── Receiving Discrepancy Detection ──────────────────────────
                // DECISION(2026-03-04): Compare received qty vs ordered qty per item.
                // Flag shorts and overs via Telegram so they don't go unnoticed.
                const discrepancies: string[] = [];
                for (const item of po.items) {
                    const ordered = item.orderedQuantity ?? 0;
                    const received = item.quantity;
                    if (ordered > 0 && received !== ordered) {
                        const diff = received - ordered;
                        const pct = Math.round((diff / ordered) * 100);
                        const icon = diff < 0 ? '🔴' : '🟡';
                        discrepancies.push(`${icon} \`${item.productId}\`: ordered ${ordered.toLocaleString()} → received ${received.toLocaleString()} (${diff > 0 ? '+' : ''}${diff.toLocaleString()}, ${pct > 0 ? '+' : ''}${pct}%)`);
                    }
                }
                if (discrepancies.length > 0) {
                    const discMsg =
                        `⚠️ *Receiving Discrepancy — PO #${po.orderId}*\n` +
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
                return `• PO #${po.orderId} — ${po.supplier} (${po.ageDays}d old, ${po.itemCount} items, $${po.total.toLocaleString()}) [${dateStr}]`;
            });

            const msg =
                `📋 *${stale.length} Stale Draft PO${stale.length > 1 ? 's' : ''}*\n` +
                `_Uncommitted for 3+ days — commit or delete:_\n\n` +
                lines.join('\n');

            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || '',
                msg,
                { parse_mode: 'Markdown' }
            ).catch((e: any) => console.warn('[ops-manager] Stale draft alert failed:', e.message));

            console.log(`📋 [ops-manager] Sent stale draft alert for ${stale.length} PO(s).`);
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
     * Calendar writes are best-effort — description-only PATCH, no color/title changes.
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
            const events = await calendar.getAllUpcomingBuilds(60); // wider window — build may be today
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

                // Match to a calendar event (same SKU, within ±1 day of build date)
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
                        if (existingDesc.includes('Completed:') || existingTitle.startsWith('✅') || existingTitle.startsWith('🟡')) {
                            console.log(`⏭️ [build-watcher] ${build.sku} already annotated, skipping`);
                        } else {
                            const scheduledQty = matched.quantity;
                            // Determine icon: 🟡 partial if under scheduled, ✅ if met or exceeded
                            const icon = (scheduledQty && build.quantity < scheduledQty) ? '🟡' : '✅';

                            // 1. Prepend icon to title so it's visible on calendar grid
                            const newTitle = `${icon} ${existingTitle}`;

                            // 2. Build description annotation with Finale link
                            let completionNote: string;
                            if (scheduledQty && scheduledQty !== build.quantity) {
                                const pct = Math.round((build.quantity / scheduledQty) * 100);
                                completionNote = `${icon} Completed: ${timeStr} — ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
                            } else {
                                completionNote = `${icon} Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
                            }
                            completionNote += `\n→ <a href="${finaleUrl}">Build #${build.buildId}</a>`;

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

                console.log(`✅ [build-watcher] Build complete: ${build.sku} × ${build.quantity} @ ${timeStr}`);
            }
        } catch (err: any) {
            console.error('[build-watcher] pollBuildCompletions error:', err.message);
        }
    }

    async sendBuildRiskReport() {
        console.log("🏭 Running daily Calendar BOM Build Risk Analysis...");

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

            // 2. Cross-post Slack version to #purchasing
            await this.postToSlack(report.slackMessage, "Build Risk Report");

            // 3. If critical items exist, send a follow-up with action items
            if (report.criticalCount > 0) {
                const urgentMsg = `🚨 *${report.criticalCount} CRITICAL stockout risk(s) detected!*\n` +
                    `_These components will stock out within 14 days and have no incoming POs._\n` +
                    `_Check the build risk report above for details, or run \`/buildrisk\` for the full analysis._`;

                this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID || "",
                    urgentMsg,
                    { parse_mode: "Markdown" }
                );
            }

            // Restock detection: compare today's risk vs yesterday's snapshot.
            // Any component that was CRITICAL/WARNING and is now OK → send Telegram
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
                            restocked.map(sku => `• \`${sku}\` — back in stock, was ${lastSnapshot[sku].riskLevel}`).join('\n') +
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
                                        `✅ ${sku} replenished — Build now Green (${today})`
                                    );
                                }
                            }
                        }
                    }
                }

                // ── Blocked-build calendar annotations ──
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

                            // ── Build the annotation ──
                            const icon = demand.riskLevel === 'CRITICAL' ? '🔴' : '🟡';
                            const daysLabel = demand.stockoutDays !== null
                                ? `${demand.stockoutDays}d to stockout`
                                : 'low stock';

                            let note = `${icon} ${compSku} — ${daysLabel}`;

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
                                    note += `\n   ${arrivesBefore ? '✅' : '⚠️'} ${poLabel} ETA ~${etaStr}`;
                                    if (!arrivesBefore) {
                                        const buildMs = new Date(build.buildDate + 'T12:00:00').getTime();
                                        const etaMs = new Date(po.orderDate).getTime() + (demand.leadTimeDays ?? 0) * 86400000;
                                        const daysLate = Math.ceil((etaMs - buildMs) / 86400000);
                                        note += ` — arrives ~${daysLate}d after build`;
                                    }
                                } else {
                                    note += `\n   📦 ${poLabel} on order`;
                                }

                                if (demand.incomingPOs.length > 1) {
                                    note += ` (+${demand.incomingPOs.length - 1} more PO${demand.incomingPOs.length > 2 ? 's' : ''})`;
                                }
                            } else {
                                note += '\n   ⛔ No PO on order';
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
                        console.log(`📅 [build-risk] Annotated ${annotated} calendar event(s) with component shortage warnings.`);
                    }
                } catch (err: any) {
                    console.warn('[build-risk] Calendar block annotation failed (non-fatal):', err.message);
                }

                await saveBuildRiskSnapshot(report);

                // Smart reorder prescriptions — fires as a follow-up Telegram message.
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
                            console.log(`🧠 [reorder] Sent ${fresh.length} prescription${fresh.length > 1 ? 's' : ''}.`);
                        }
                    }
                } catch (err: any) {
                    console.warn('[reorder] prescription engine failed (non-fatal):', err.message);
                }
            });

            console.log(`✅ Build risk report sent: 🔴 ${report.criticalCount} · 🟡 ${report.warningCount} · 👀 ${report.watchCount} · ✅ ${report.okCount}`);
        } catch (err: any) {
            console.error("❌ Build risk analysis failed:", err.message);

            // Report the failure to Telegram so Will knows
            this.bot.telegram.sendMessage(
                process.env.TELEGRAM_CHAT_ID || "",
                `⚠️ _Daily build risk analysis failed: ${err.message}_\n_Run \`/buildrisk\` manually to troubleshoot._`,
                { parse_mode: "Markdown" }
            );
        }
    }

    private async getOperationsStatsForTimeframe(timeframe: "yesterday" | "week") {
        const supabase = createClient();
        const date = new Date();
        if (timeframe === "yesterday") date.setDate(date.getDate() - 1);
        else date.setDate(date.getDate() - 7);
        const isoDate = date.toISOString().split("T")[0];

        // For weekly reports AND daily week-to-date data, calculate Monday of current week → tomorrow
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

            // Grab Finale received and committed PO data — use full week range for both reports
            let finaleReceivedPOs: any[] = [];
            let finaleCommittedPOs: any[] = [];
            try {
                const finale = finaleClient;
                const [receivedPOs, committedPOs] = await Promise.all([
                    finale.getTodaysReceivedPOs(finaleStartDate, finaleEndDate),
                    finale.getTodaysCommittedPOs(finaleStartDate, finaleEndDate)
                ]);
                finaleReceivedPOs = receivedPOs;
                finaleCommittedPOs = committedPOs;
            } catch (err) {
                console.warn("Could not fetch Finale PO activity for summary", err);
            }

            // Unread emails: daily only — not relevant for weekly review
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

            return {
                timeframe,
                purchase_orders_db: pos.data || [],
                finale_receivings: finaleReceivedPOs,
                finale_committed: finaleCommittedPOs,
                invoices: invoices.data || [],
                documents: documents.data || [],
                unread_emails: { count: unreadCount, subjects: unreadSubjects }
            };
        } catch (err) {
            return { timeframe, purchase_orders_db: [], finale_receivings: [], finale_committed: [], invoices: [], documents: [], unread_emails: { count: 0, subjects: [] } };
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
1. **Weekly Receivings** — List EVERY PO received this week. For each: vendor name, PO number, total units received, dollar amount, and key SKUs. End with a total (# POs, total units, total $).
2. **POs Committed This Week** — List each new PO placed: vendor, PO number, dollar amount. End with total spend.
3. **Notable items** — Any anomalies, large orders, or action items worth flagging.

DO NOT include: vendors-contacted/invoiced section, unread emails, document processing stats.
Format with clean markdown bullets. Be specific with numbers — no vague summaries.
Data: ${JSON.stringify(data)}`
            : `Summarize the following operations activity for the Daily Morning report.
The data provided contains WEEK-TO-DATE records (from Monday through Yesterday).
Your summary MUST include WEEKLY TOTALS for the week so far (Monday to yesterday), AND add in the previous day's (yesterday's) specific receptions and POs placed.

Focus on: 
- Total spend/amount due (Week-to-date and Yesterday specific).
- Finale receivings (Show week-to-date total POs/units/spend, AND clearly list yesterday's specific POs received).
- Committed POs (Show week-to-date total, AND specifically list yesterday's POs placed).
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

    // ──────────────────────────────────────────────────
    // PURCHASING CALENDAR SYNC
    // ──────────────────────────────────────────────────

    /**
     * Build the status emoji prefix for a PO based on its Finale status string.
     */
    private poStatusEmoji(status: string): string {
        const s = (status || '').toLowerCase();
        if (s === 'completed') return '✅';
        if (s === 'cancelled') return '❌';
        return '🔜';
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
     * DECISION(2026-03-11): Unreceived POs get 🔴 prefix for visual urgency.
     */
    private buildPOEventTitle(po: FullPO): string {
        const s = (po.status || '').toLowerCase();
        const isReceived = s === 'completed';
        const isCancelled = s === 'cancelled';
        const emoji = isReceived ? '✅' : isCancelled ? '❌' : '🔴';
        return `${emoji} PO #${po.orderId} — ${po.vendorName}`;
    }

    /**
     * Build the calendar event description for a PO.
     */
    private async buildPOEventDescription(
        po: FullPO,
        expectedDate: string,
        leadProvenance: string,
        trackingNumbers: string[],
        prefetchedStatuses?: Map<string, TrackingStatus | null>
    ): Promise<string> {
        const isReceived = (po.status || '').toLowerCase() === 'completed';
        const isCancelled = (po.status || '').toLowerCase() === 'cancelled';

        const lines: string[] = [];

        if (isReceived && po.receiveDate) {
            // Compute on-time vs late
            const expectedMs = new Date(expectedDate).getTime();
            const actualMs = new Date(po.receiveDate).getTime();
            const diff = Math.round((actualMs - expectedMs) / 86_400_000);
            const timing = diff === 0 ? 'on time' : diff > 0 ? `${diff}d late` : `${Math.abs(diff)}d early`;
            lines.push(`Ordered: ${this.fmtDate(po.orderDate)} | Received: ${this.fmtDate(po.receiveDate)} (${timing})`);
        } else {
            lines.push(`Ordered: ${this.fmtDate(po.orderDate)}`);
            if (!isCancelled) {
                lines.push(`Expected: ${this.fmtDate(expectedDate)} (${leadProvenance})`);
            }
        }

        if (trackingNumbers.length > 0) {
            const trackingLines = await Promise.all(trackingNumbers.map(async t => {
                const ts = prefetchedStatuses?.has(t) ? prefetchedStatuses.get(t)! : await getTrackingStatus(t);
                const statusStr = ts ? ` ${ts.display}` : "";
                const link = ts?.public_url || carrierUrl(t);
                const displayT = t.includes(":::") ? t.replace(":::", " ") : t;
                return `<a href="${link}">${displayT}</a><i>${statusStr}</i>`;
            }));
            lines.push(`Tracking: ${trackingLines.join(' | ')}`);
        } else if (!isReceived && !isCancelled) {
            lines.push(`Tracking: Awaiting Tracking`);
        }

        // Line items — max 5 + overflow count
        const itemLines = po.items.slice(0, 5).map(i => `${i.productId} × ${i.quantity.toLocaleString()}`);
        if (po.items.length > 5) itemLines.push(`+ ${po.items.length - 5} more`);
        lines.push(`Items: ${itemLines.join(', ')}`);

        // DECISION(2026-03-11): Removed monetary Total from calendar events per user request.

        const statusLabel = isReceived ? 'Received' : isCancelled ? 'Cancelled' : 'In Transit';
        lines.push(`Status: ${statusLabel}`);

        // Unreceived POs get a prominent NOT YET RECEIVED note
        if (!isReceived && !isCancelled) {
            lines.push(`🔴 <b>NOT YET RECEIVED</b>`);
        }

        lines.push(`→ <a href="${po.finaleUrl}">PO# ${po.orderId}</a>`);

        return lines.join('\n');
    }

    /**
     * Sync all recent purchase orders to the purchasing Google Calendar.
     * - Creates a new all-day event (on the expected arrival date) for each new PO
     * - Updates the event title/description in place when status changes
     * - Expected arrival date: Finale's deliverDate → vendor median lead time → 14d default
     *
     * Runs every 4 hours via cron. Also called by the backfill script.
     * Never throws — all errors are logged and swallowed.
     */
    async syncPurchasingCalendar(daysBack: number = 7): Promise<{ created: number; updated: number; skipped: number }> {
        const counts = { created: 0, updated: 0, skipped: 0 };
        try {
            const finale = finaleClient;
            const supabase = createClient();
            if (!supabase) {
                console.warn('[cal-sync] Supabase unavailable — skipping purchasing calendar sync');
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

            // Also fetch all tracking numbers from purchase_orders for the recent POs
            const { data: poRows } = await supabase
                .from('purchase_orders')
                .select('po_number, tracking_numbers')
                .in('po_number', pos.map(p => p.orderId).filter(Boolean));
            const trackingMap = new Map<string, string[]>();
            for (const row of poRows ?? []) {
                trackingMap.set(row.po_number, row.tracking_numbers || []);
            }

            const calendar = new CalendarClient();

            for (const po of pos) {
                if (!po.orderId) continue;
                // Skip dropship POs — they're pass-through orders, not BuildASoil inventory
                if (po.orderId.toLowerCase().includes('dropship')) continue;
                // Only show committed or received — skip drafts and cancelled
                if (!['committed', 'completed'].includes((po.status || '').toLowerCase())) continue;

                // Determine expected arrival date.
                // NOTE: Finale's dueDate is payment terms (Net 30 etc), NOT delivery estimate — ignored.
                // Priority: vendor history median (≥3 completed POs) → 14d global default.
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

                const title = this.buildPOEventTitle(po);

                // Get tracking array for this PO
                const trackingNumbers = trackingMap.get(po.orderId) || [];

                // Pre-fetch EasyPost statuses so we can include them in change-detection hash
                // (hash must reflect status so re-sync triggers when billing was fixed or status changes)
                const trackingStatuses = new Map<string, TrackingStatus | null>();
                await Promise.all(trackingNumbers.map(async t => {
                    trackingStatuses.set(t, await getTrackingStatus(t));
                }));

                // Hash = sorted "num:status" pairs — changes when EasyPost status changes
                const trackingHash = trackingNumbers.slice().sort().map(t => {
                    const ts = trackingStatuses.get(t);
                    return ts ? `${t}:${ts.category}` : t;
                }).join(',');

                const description = await this.buildPOEventDescription(po, expectedDate, leadProvenance, trackingNumbers, trackingStatuses);
                const newStatus = (po.status || '').toLowerCase() === 'completed' ? 'received'
                    : (po.status || '').toLowerCase() === 'cancelled' ? 'cancelled'
                        : 'open';

                const existingRow = existing.get(po.orderId);

                // Google Calendar colorId: 11 = Tomato (red), 2 = Sage (green)
                const colorId = newStatus === 'received' ? '2' : '11';

                if (!existingRow) {
                    // New PO — create calendar event
                    try {
                        const eventId = await calendar.createEvent(PURCHASING_CALENDAR_ID, {
                            title,
                            description,
                            date: expectedDate,
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
                        console.log(`📅 [cal-sync] Created event for PO #${po.orderId} (${po.vendorName}) on ${expectedDate}`);
                    } catch (e: any) {
                        console.warn(`[cal-sync] Could not create event for PO #${po.orderId}: ${e.message}`);
                    }
                } else if (existingRow.status !== newStatus || existingRow.last_tracking !== trackingHash) {
                    // Status changed or tracking changed — update in place
                    await calendar.updateEventTitleAndDescription(
                        existingRow.calendar_id,
                        existingRow.event_id,
                        title,
                        description,
                        colorId
                    );
                    await supabase.from('purchasing_calendar_events')
                        .update({ status: newStatus, last_tracking: trackingHash, updated_at: new Date().toISOString() })
                        .eq('po_number', po.orderId);
                    counts.updated++;
                    console.log(`📅 [cal-sync] Updated event for PO #${po.orderId}: status=${newStatus}, tracking changed=${existingRow.last_tracking !== trackingHash}`);
                } else {
                    counts.skipped++;
                }
            }

            console.log(`[cal-sync] Done — ${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped`);
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
     * Runs via cron at 8:30 AM Denver every Friday. Never throws — errors are
     * caught and reported via Telegram. Will just reviews cart and checks out.
     */
    async runFridayUlineOrder() {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) return;

        console.log('[uline-friday] 🛒 Starting Friday ULINE auto-order...');

        const { runAutonomousUlineOrder } = await import('../../cli/order-uline');
        const result = await runAutonomousUlineOrder();

        // Case 1: Pipeline error
        if (!result.success) {
            await this.bot.telegram.sendMessage(
                chatId,
                `🚨 <b>ULINE Friday Order — Failed</b>\n\n` +
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
                `✅ <b>ULINE Friday Order — All Stocked</b>\n\n` +
                `Purchasing intelligence scanned all ULINE items.\n` +
                `Everything is above reorder threshold — no order needed this week. 🎉`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Case 3: Items ordered — build rich notification
        const itemLines = result.items
            .map(i => `  <code>${i.ulineModel}</code> × ${i.qty}  ($${(i.qty * i.unitPrice).toFixed(2)})`)
            .join('\n');

        const poLine = result.finalePO && result.finaleUrl
            ? `📄 <a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
            : result.finalePO
                ? `📄 Finale PO #${result.finalePO}`
                : '⚠️ PO creation skipped';

        const cartIcon = result.cartResult.includes('⚠️') ? '⚠️' : '🛒';

        let msg = `🛒 <b>ULINE Friday Order — Ready for Checkout</b>\n\n`;
        msg += `${poLine}\n`;
        msg += `💰 Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n`;
        msg += `📦 ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n`;
        msg += `${itemLines}\n\n`;
        msg += `${cartIcon} Cart: ${result.cartResult}\n\n`;
        msg += `<i>Review your ULINE cart and checkout when ready.</i>\n`;
        msg += `<i>🔗 <a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a></i>`;

        await this.bot.telegram.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            // @ts-expect-error Telegraf types lag behind Bot API
            disable_web_page_preview: true,
        });

        console.log(`[uline-friday] ✅ Telegram notification sent (${result.itemCount} items, $${result.estimatedTotal.toFixed(2)})`);
    }

    /**
     * ── AXIOM DEMAND SCANNER ─────────────────────────────────
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
                        `🏷️ <b>Axiom Labels Demand Scan</b>\n\nQueued/Updated ${result.queuedCount} items for reorder.\n<a href="https://buildasoil.dash.app/">Review on Dashboard</a>`,
                        { parse_mode: 'HTML' } // Use standard dash link since Aria dashboard doesn't exist yet/used murp.app
                    ).catch((e: any) => console.warn('[ops-manager] Axiom scan alert failed:', e.message));
                }
            }
        } catch (error: any) {
             console.error(`[ops-manager] Axiom Demand Scan error:`, error.message);
        }
    }
}
