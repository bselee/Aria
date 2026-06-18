/**
 * @file    src/lib/scans-watcher.ts
 * @purpose Watch the _FREIGHT/Documents/Scans/ folder for new scanned PDFs
 *          and route them based on filename prefix:
 *
 *          CR_ / CRMIN_ / CR (CR Minerals pumice invoices):
 *            → Slack @parker with a brief "Yo Park — Pumice scan" + reference
 *              to most recent CR Minerals PO (SKU PU100)
 *
 *          Benny_ (Benny's invoices):
 *            → Email to buildasoilap@bill.com (same as AP invoice forwarding)
 *
 *          Other files: logged but no action (except known patterns like Pulse_,
 *          Fedex_, etc. that are handled by other pipelines)
 *
 *          State is tracked in a small JSON file at:
 *            data/scans-watcher-state.json
 *          to avoid re-processing the same file across runs.
 *
 * @author  Hermia
 * @created 2026-06-16
 * @deps    @slack/web-api, @googleapis/gmail (sendGmailPdfEmail)
 * @env     SLACK_ACCESS_TOKEN, SLACK_BOT_TOKEN, SLACK_OWNER_USER_ID
 *          GMAIL tokens for "default" and "ap" slots
 */

import fs from "fs";
import path from "path";
import { WebClient } from "@slack/web-api";
import { getAuthenticatedClient } from "./gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";

// ── Constants ──────────────────────────────────────────────────────────────

const SCANS_DIR = "C:\\Users\\BuildASoil\\OneDrive\\_FREIGHT\\Documents\\Scans";
const STATE_FILE = path.join(process.cwd(), "data", "scans-watcher-state.json");

/** Parker McMahon's Slack user ID needs resolving — fallback is their name mention */
let PARKER_SLACK_ID: string | null = null;
const PARKER_NAME = "Parker McMahon";
const PURCHASE_ORDERS_CHANNEL = "#purchase-orders";

// Max age for a "most recent" CR Minerals PO query (look back 90 days)
const CR_PO_LOOKBACK_DAYS = 90;
const CR_SKU = "PU100";
const CR_VENDOR = "CR Minerals";

// ── State persistence ──────────────────────────────────────────────────────

interface WatcherState {
    processedFiles: string[]; // basenames of already-processed files
    lastProcessedAt: string | null; // ISO timestamp
}

function loadState(): WatcherState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
        }
    } catch {
        // Corrupt file — start fresh
    }
    return { processedFiles: [], lastProcessedAt: null };
}

function saveState(state: WatcherState): void {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ── File Classification ────────────────────────────────────────────────────

type ScanAction = "slack_parker_cr" | "email_billcom" | "ignore" | "unknown";

interface ClassifiedFile {
    basename: string;
    fullPath: string;
    action: ScanAction;
    label: string; // Human description for logging
}

function classifyFile(basename: string, fullPath: string): ClassifiedFile {
    const upper = basename.toUpperCase();

    // CR Minerals patterns: CR_, CRMIN_, CRMIN, CR_DELIVERY, CR_Pumice
    if (
        upper.startsWith("CR_") ||
        upper.startsWith("CRMIN_") ||
        upper.startsWith("CRMIN") ||
        upper.startsWith("CR_DELIVERY_") ||
        upper.startsWith("CR_PUMICE_") ||
        upper.startsWith("CR_DELIV_") ||
        basename.match(/^CR[A-Za-z]*_\d+/i)
    ) {
        return { basename, fullPath, action: "slack_parker_cr", label: "CR Minerals — notify Parker" };
    }

    // Benny patterns: Benny_, Benny
    if (
        upper.startsWith("BENNY_") ||
        upper.startsWith("BENNY") ||
        upper.startsWith("BENNYPD_")
    ) {
        return { basename, fullPath, action: "email_billcom", label: "Benny invoice — email to Bill.com" };
    }

    // Known patterns handled by other pipelines — ignore here
    if (
        upper.startsWith("FEDEX") ||
        upper.startsWith("PULSE_") ||
        upper.startsWith("BMO_") ||
        upper.startsWith("BERGER") ||
        upper.startsWith("SMITH_") ||
        upper.startsWith("WELCH_") ||
        upper.startsWith("TOYOTA") ||
        upper.startsWith("TERMINIX") ||
        upper.startsWith("BIOCHAR") ||
        upper.startsWith("DIAMONDK") ||
        upper.startsWith("PUMPICE_") ||
        upper.startsWith("THE ROCK") ||
        upper.startsWith("ROCK SHOP") ||
        upper.startsWith("ORG AG") ||
        upper.startsWith("NMWF") ||
        upper.startsWith("CDPHE") ||
        // Numeric-only names (dated scans that don't match known prefixes)
        /^\d{6,8}(_\d{3})?\.pdf$/i.test(basename)
    ) {
        return { basename, fullPath, action: "ignore", label: "Known pattern — other pipeline" };
    }

    return { basename, fullPath, action: "unknown", label: "Unclassified scan" };
}

// ── Slack: Message Parker ───────────────────────────────────────────────────

/**
 * Send a Slack DM to Parker about a new CR Minerals scan.
 * Uses the existing purchase-orders channel thread pattern — posts in
 * #purchase-orders as a heads-up.
 */
async function notifyParkerAboutCRScan(
    slackUserToken: string,
    className: string,
    crPoInfo: string,
): Promise<void> {
    const slack = new WebClient(slackUserToken);

    // Find Parker's user ID if we haven't cached it
    if (!PARKER_SLACK_ID) {
        try {
            const usersList = await slack.users.list();
            const parker = usersList.members?.find(
                (m) => m.real_name === PARKER_NAME || m.name === "parker" || m.name?.toLowerCase().includes("parker"),
            );
            PARKER_SLACK_ID = parker?.id ?? null;
        } catch (err) {
            console.warn(`[scans-watcher] Could not resolve Parker's Slack ID: ${(err as Error).message}`);
        }
    }

    const mention = PARKER_SLACK_ID ? `<@${PARKER_SLACK_ID}>` : `@${PARKER_NAME}`;

    // Find #purchase-orders channel
    let poChannelId: string | null = null;
    try {
        const convList = await slack.conversations.list({ types: "public_channel,private_channel", limit: 200 });
        poChannelId = convList.channels?.find((c) => c.name === "purchase-orders")?.id ?? null;
    } catch (err) {
        console.warn(`[scans-watcher] Could not resolve #purchase-orders: ${(err as Error).message}`);
    }

    if (!poChannelId) {
        console.warn(`[scans-watcher] Cannot post — #purchase-orders channel not found`);
        return;
    }

    const message = `${mention} Yo Park — Pumice scan dropped in Scans: ${className}\n${crPoInfo}`;

    try {
        await slack.chat.postMessage({
            channel: poChannelId,
            text: message,
            unfurl_links: false,
        });
        console.log(`[scans-watcher] ✓ Posted CR scan notification for ${className}`);
    } catch (err) {
        console.error(`[scans-watcher] Failed to post Slack message: ${(err as Error).message}`);
    }
}

/**
 * Query the most recent CR Minerals PO from Finale to reference in the Slack message.
 * Uses searchProducts for PU100 to find stock-on-order and vendor info,
 * then builds a reference message.
 * Falls back to a static message if Finale query fails.
 */
async function findMostRecentCRPo(): Promise<string> {
    try {
        const { FinaleClient } = await import("./finale/client");
        const finale = new FinaleClient();

        // Search for PU100 (Pumice) to get stock-on-order and product info
        const { results } = await finale.searchProducts(CR_SKU, 5);

        if (results && results.length > 0) {
            const pu100 = results.find(
                (p: any) => p.productId?.toUpperCase() === CR_SKU
            );

            if (pu100) {
                const onOrder = pu100.stockOnOrder || "0";
                const name = pu100.name || "Pumice";
                return `PU100 (${name}) — ${onOrder} units on order`;
            }

            // Fallback to first result
            const first = results[0];
            const onOrder = first.stockOnOrder || "0";
            return `PU100 — ${onOrder} units on order`;
        }

        return `PU100 (Pumice) — no stock data found in Finale.`;
    } catch (err) {
        console.warn(`[scans-watcher] Finale search failed: ${(err as Error).message}`);
        return `CR Minerals (PU100) — check Finale for latest PO.`;
    }
}

// ── Email: Forward Benny scan to Bill.com ───────────────────────────────────

/**
 * Email a Benny scan PDF to buildasoilap@bill.com.
 * Uses the "ap" Gmail token (ap@buildasoil.com) to send,
 * matching the existing AP pipeline forward pattern.
 */
async function emailBennyToBillCom(pdfPath: string, pdfFilename: string): Promise<void> {
    let apGmail: ReturnType<typeof GmailApi> | null = null;

    try {
        const auth = await getAuthenticatedClient("ap");
        apGmail = GmailApi({ version: "v1", auth });
    } catch (err) {
        console.warn(`[scans-watcher] AP Gmail auth failed, trying default: ${(err as Error).message}`);
        try {
            const auth = await getAuthenticatedClient("default");
            apGmail = GmailApi({ version: "v1", auth });
        } catch (err2) {
            console.error(`[scans-watcher] Gmail auth completely failed: ${(err2 as Error).message}`);
            return;
        }
    }

    try {
        const pdfBuffer = fs.readFileSync(pdfPath);

        const boundary = `----=_AriaScan_${Date.now()}`;
        const subject = `Scanned Invoice: ${pdfFilename}`;
        const body = `Scanned invoice from Benny — ${pdfFilename}\n\nForwarded by Aria Scans Watcher.`;

        const lines = [
            `To: buildasoilap@bill.com`,
            `Subject: ${subject}`,
            "MIME-Version: 1.0",
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: 7bit",
            "",
            body,
            "",
            `--${boundary}`,
            `Content-Type: application/pdf; name="${pdfFilename}"`,
            `Content-Disposition: attachment; filename="${pdfFilename}"`,
            "Content-Transfer-Encoding: base64",
            "",
            pdfBuffer.toString("base64"),
            `--${boundary}--`,
        ];

        const raw = Buffer.from(lines.join("\r\n"))
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

        await apGmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
        });

        console.log(`[scans-watcher] ✓ Emailed ${pdfFilename} to buildasoilap@bill.com`);
    } catch (err) {
        console.error(`[scans-watcher] Failed to email ${pdfFilename} to Bill.com: ${(err as Error).message}`);
    }
}

// ── Main Scan Watch Logic ───────────────────────────────────────────────────

export interface ScanWatchResult {
    scanned: number;
    processed: number;
    slackNotifications: number;
    emailForwards: number;
    errors: number;
    details: string[];
}

/**
 * Run the scan watcher: check the Scans/ directory for new files,
 * classify them, and take action.
 */
export async function runScansWatch(): Promise<ScanWatchResult> {
    const result: ScanWatchResult = {
        scanned: 0,
        processed: 0,
        slackNotifications: 0,
        emailForwards: 0,
        errors: 0,
        details: [],
    };

    // Load state
    const state = loadState();
    const slackToken = process.env.SLACK_ACCESS_TOKEN;

    // Ensure scans directory exists
    if (!fs.existsSync(SCANS_DIR)) {
        result.details.push(`Scans directory not found: ${SCANS_DIR}`);
        return result;
    }

    // Get all PDFs in the root Scans folder (not archive subfolders)
    let files: string[];
    try {
        files = fs
            .readdirSync(SCANS_DIR)
            .filter((f) => f.endsWith(".pdf"))
            .sort(); // Sort so we process oldest first
    } catch (err) {
        result.details.push(`Error reading Scans directory: ${(err as Error).message}`);
        result.errors++;
        return result;
    }

    // Filter to new files not yet processed
    const newFiles = files.filter((f) => !state.processedFiles.includes(f));

    if (newFiles.length === 0) {
        result.details.push("No new files to process.");
        return result;
    }

    result.scanned = newFiles.length;

    // Pre-resolve CR PO info if we have any CR files
    let crPoInfo = "";
    const hasCRFiles = newFiles.some((f) => {
        const upper = f.toUpperCase();
        return upper.startsWith("CR_") || upper.startsWith("CRMIN_") || upper.startsWith("CRMIN");
    });

    if (hasCRFiles) {
        crPoInfo = await findMostRecentCRPo();
    }

    // Process each file
    for (const basename of newFiles) {
        const fullPath = path.join(SCANS_DIR, basename);
        const classified = classifyFile(basename, fullPath);

        try {
            switch (classified.action) {
                case "slack_parker_cr": {
                    if (slackToken) {
                        await notifyParkerAboutCRScan(slackToken, basename, crPoInfo);
                        result.slackNotifications++;
                    } else {
                        result.details.push(`SLACK_ACCESS_TOKEN not set — cannot notify about ${basename}`);
                        result.errors++;
                    }
                    result.processed++;
                    result.details.push(`✓ ${basename} → Slack @parker (CR Minerals)`);
                    break;
                }

                case "email_billcom": {
                    await emailBennyToBillCom(fullPath, basename);
                    result.emailForwards++;
                    result.processed++;
                    result.details.push(`✓ ${basename} → Emailed to Bill.com`);
                    break;
                }

                case "ignore": {
                    // No action — handled by other pipeline
                    result.details.push(`- ${basename} → ignored (other pipeline)`);
                    break;
                }

                case "unknown": {
                    result.details.push(`? ${basename} → unclassified, no action taken`);
                    break;
                }
            }
        } catch (err) {
            result.errors++;
            result.details.push(`✗ ${basename} → ERROR: ${(err as Error).message}`);
        }

        // Mark as processed regardless (even on error, don't re-process)
        state.processedFiles.push(basename);
    }

    state.lastProcessedAt = new Date().toISOString();
    saveState(state);

    return result;
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

if (require.main === module) {
    runScansWatch()
        .then((r) => {
            console.log(`\n[scans-watcher] Complete:`);
            console.log(
                `  Scanned: ${r.scanned} | Processed: ${r.processed} | Slack: ${r.slackNotifications} | Email: ${r.emailForwards} | Errors: ${r.errors}`,
            );
            for (const detail of r.details) {
                console.log(`  ${detail}`);
            }
            process.exit(0);
        })
        .catch((err) => {
            console.error(`[scans-watcher] Fatal error:`, err);
            process.exit(1);
        });
}
