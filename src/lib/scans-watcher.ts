/**
 * @file    src/lib/scans-watcher.ts
 * @purpose Watch the _FREIGHT/Documents/Scans/ folder for new scanned PDFs
 *          and route them based on filename prefix:
 *
 *          CR_ / CRMIN_ / CR (CR Minerals pumice invoices):
 *            → Email to buildasoilap@bill.com (same as AP invoice forwarding).
 *              HERMIA(2026-08-20): was a Slack DM to Parker; Slack removed.
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
 * @updated 2026-08-20 — Slack removed; CR scans now email to Bill.com.
 * @deps    @googleapis/gmail (forwardInvoiceOnce via ap-single-forward)
 * @env     GMAIL tokens for "default" and "ap" slots
 */

import fs from "fs";
import path from "path";

// ── Constants ──────────────────────────────────────────────────────────────

const SCANS_DIR = "C:\\Users\\BuildASoil\\OneDrive\\_FREIGHT\\Documents\\Scans";
const STATE_FILE = path.join(process.cwd(), "data", "scans-watcher-state.json");

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

type ScanAction = "email_billcom" | "ignore" | "unknown";

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
        return { basename, fullPath, action: "email_billcom", label: "CR Minerals invoice — email to Bill.com" };
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

// ── Email: Forward scan to Bill.com ────────────────────────────────────────

/**
 * Vendor name detection from filename prefix.
 * Expand this map as new vendors are added to the scans-watcher.
 */
function detectVendorFromFilename(pdfFilename: string): string | undefined {
    const upper = pdfFilename.toUpperCase();
    if (upper.startsWith("BENNY_") || upper.startsWith("BENNY")) {
        return "Benny Martinez Trucking";
    }
    if (
        upper.startsWith("CR_") ||
        upper.startsWith("CRMIN_") ||
        upper.startsWith("CRMIN") ||
        upper.startsWith("CR_DELIVERY_") ||
        upper.startsWith("CR_PUMICE_") ||
        upper.startsWith("CR_DELIV_")
    ) {
        return "CR Minerals";
    }
    return undefined;
}

/**
 * Email a scan PDF to buildasoilap@bill.com via the single-forward gate.
 *
 * HERMIA(2026-07-30): Replaced raw Gmail MIME send with forwardInvoiceOnce().
 * This routes through the canonical single-forward gate, which provides:
 *   - SHA-256 content-hash dedup (same PDF never forwarded twice)
 *   - billcom_bills_ref vendor+invoice# check (catches manually uploaded bills)
 *   - ap_local_forwards logging (audit trail, OCR enrichment, PO matching)
 *
 * The gmailMessageId is derived from the filename so it's stable across cron
 * runs — the hash-based dedup will block re-forwarding even if the state file
 * resets.
 */
async function emailToBillCom(pdfPath: string, pdfFilename: string): Promise<void> {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const vendorName = detectVendorFromFilename(pdfFilename);

    // Dynamic import to avoid circular dependency at module load time.
    const { forwardInvoiceOnce } = await import("@/lib/intelligence/ap-single-forward");

    const result = await forwardInvoiceOnce({
        gmailMessageId: `scans:${pdfFilename}`,
        emailFrom: "scans-watcher@aria.local",
        emailSubject: `Scanned Invoice: ${pdfFilename}`,
        pdfFilename,
        pdfBuffer,
        source: "scans-watcher",
        vendorName,
    });

    switch (result.status) {
        case "forwarded":
            console.log(
                `[scans-watcher] ✓ Forwarded ${pdfFilename} to Bill.com ` +
                `(hash=${result.pdfContentHash.slice(0, 12)}, claim=${result.claimId})`,
            );
            break;
        case "already_forwarded":
            console.log(
                `[scans-watcher] ⏭️ Skipped ${pdfFilename} — already forwarded ` +
                `(${result.reason})`,
            );
            break;
        case "blocked":
            console.log(
                `[scans-watcher] 🚫 Blocked ${pdfFilename} — ${result.reason}`,
            );
            break;
        case "error":
            console.error(
                `[scans-watcher] ❌ Failed to forward ${pdfFilename}: ${result.reason}`,
            );
            break;
    }
}

// ── Main Scan Watch Logic ───────────────────────────────────────────────────

export interface ScanWatchResult {
    scanned: number;
    processed: number;
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
        emailForwards: 0,
        errors: 0,
        details: [],
    };

    // Load state
    const state = loadState();

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

    // Process each file
    for (const basename of newFiles) {
        const fullPath = path.join(SCANS_DIR, basename);
        const classified = classifyFile(basename, fullPath);

        try {
            switch (classified.action) {
                case "email_billcom": {
                    await emailToBillCom(fullPath, basename);
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
                `  Scanned: ${r.scanned} | Processed: ${r.processed} | Email: ${r.emailForwards} | Errors: ${r.errors}`,
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
