/**
 * @file    src/cli/basauto-recon.ts
 * @purpose Morning reconciliation: crawl basauto.vercel.app purchasing data
 *          via the session-token backdoor (Playwright DOM scrape as fallback),
 *          compare each basauto-flagged SKU against Aria's purchasing
 *          pipeline, and persist a JSON report the dashboard panel reads.
 *
 *          Designed to run headless from Hermes cron at 07:00 MT. Prints a
 *          compact morning report to stdout (delivered verbatim by the cron),
 *          and exits non-zero only when the crawl itself failed — so a broken
 *          backdoor cannot fail silently.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    src/lib/purchasing/basauto-recon.ts, dotenv, node child_process
 * @env     .env.local (indirect, for Playwright fallback path only)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import {
    type BasautoRecord,
    type AriaItemLite,
    type ReconReport,
    buildReconReport,
    normalizeSku,
    toNumber,
} from "../lib/purchasing/basauto-recon";

const REPO_ROOT = process.cwd();
const CACHE_DIR = join(homedir(), "AppData", "Local", "hermes", "cache", "basauto");
const TOKEN_FILE = join(CACHE_DIR, "session-token.txt");
const LEGACY_SNAPSHOT = join(CACHE_DIR, "latest-snapshot.json");
const REPORT_FILE = join(REPO_ROOT, "data", "basauto-recon.json");
const DISMISSED_FILE = join(REPO_ROOT, "data", "basauto-recon-dismissed.json");
const SCRAPE_DATA_FILE = join(REPO_ROOT, "data", "basauto-scrape.json");

const BAS_URL = "https://basauto.vercel.app";
const ORDERS_URL = `${BAS_URL}/api/orders/getPurchaseOrders`;
const REQUESTS_URL = `${BAS_URL}/api/purchases/requests`;
const ARIA_URL = "http://127.0.0.1:3001/api/dashboard/purchasing";

// ── basauto API backdoor ────────────────────────────────────────────────────

interface RawBasautoPayload {
    purchases?: Array<{ supplier?: string; products?: any[] }>;
    overduePurchases?: any[];
}

async function fetchBasautoApi(): Promise<RawBasautoPayload | null> {
    let token = "";
    try {
        token = readFileSync(TOKEN_FILE, "utf-8").trim();
    } catch {
        console.error("[basauto-recon] No session token at", TOKEN_FILE);
        return null;
    }
    const res = await fetch(ORDERS_URL, {
        headers: {
            Cookie: `__Secure-next-auth.session-token=${token}`,
            Accept: "application/json",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    try {
        const json = (await res.json()) as RawBasautoPayload;
        if (!json || !Array.isArray(json.purchases)) return null;
        return json;
    } catch {
        return null;
    }
}

// ── Playwright DOM-scrape fallback ──────────────────────────────────────────

function runPlaywrightScrape(): boolean {
    const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli/scrape-purchases.ts", "--skip-requests", "--data", SCRAPE_DATA_FILE],
        { cwd: REPO_ROOT, timeout: 10 * 60_000, encoding: "utf-8" },
    );
    if (r.status !== 0) {
        console.error("[basauto-recon] Playwright fallback failed:", r.stderr?.slice(-500) ?? r.error?.message);
        return false;
    }
    return existsSync(SCRAPE_DATA_FILE);
}

/** Normalize DOM-scraped items (vendor → sku cards) into BasautoRecord shape. */
function normalizeScraped(scraped: Record<string, any[]>): BasautoRecord[] {
    const out: BasautoRecord[] = [];
    for (const [vendor, items] of Object.entries(scraped)) {
        for (const it of items) {
            const sku = normalizeSku(it.sku);
            if (!sku) continue;
            const ninety = toNumber(it.ninetyDayConsumed);
            out.push({
                productId: sku,
                description: it.description || null,
                supplier: vendor || null,
                urgency: it.urgency || "OK",
                unitsInStock: null,
                stockDaysLeft: toNumber(it.daysBuildsLeft),
                reorderQty: toNumber(it.recommendedReorderQty),
                reorderDate: it.purchaseAgainBy || null,
                onOrder: null,
                quantityInDrafts: null,
                supplierLeadDays: toNumber(it.supplierLeadTime),
                velocity: toNumber(it.dailyVelocity),
                lastReceived: it.lastReceived || null,
                quantity: ninety != null ? -ninety : null,
                averageBuildConsumption: toNumber(it.avgBuildConsumption),
            });
        }
    }
    return out;
}

// ── Normalization (API payload) ─────────────────────────────────────────────

function normalizeApi(payload: RawBasautoPayload): BasautoRecord[] {
    const bySku = new Map<string, BasautoRecord>();
    for (const group of payload.purchases ?? []) {
        for (const p of group.products ?? []) {
            const sku = normalizeSku(p.productID ?? p.productId);
            if (!sku || bySku.has(sku)) continue;
            bySku.set(sku, {
                productId: sku,
                description: p.description ?? null,
                supplier: group.supplier ?? null,
                urgency: p.urgency ?? "OK",
                unitsInStock: toNumber(p.unitsInStock),
                stockDaysLeft: toNumber(p.stockDaysLeft),
                reorderQty: toNumber(p.reorderQty),
                reorderDate: p.reorderDate ?? null,
                onOrder: toNumber(p.onOrder),
                quantityInDrafts: toNumber(p.quantityInDrafts),
                supplierLeadDays: toNumber(p.supplierLeadDays),
                velocity: toNumber(p.velocity),
                lastReceived: p.lastReceived ?? null,
                quantity: toNumber(p.quantity),
                averageBuildConsumption: toNumber(p.averageBuildConsumption),
            });
        }
    }
    // Slim overdue section — synthesize minimal records for SKUs absent above.
    for (const doc of payload.overduePurchases ?? []) {
        for (const group of doc?.overduePurchases ?? []) {
            for (const p of group?.products ?? []) {
                const sku = normalizeSku(p.productId);
                if (!sku || bySku.has(sku)) continue;
                bySku.set(sku, {
                    productId: sku,
                    description: p.description ?? null,
                    supplier: group.supplier ?? null,
                    urgency: "Overdue",
                    unitsInStock: null,
                    stockDaysLeft: toNumber(p.stockDaysLeft),
                    reorderQty: toNumber(p.reorderQty),
                    reorderDate: null,
                    onOrder: null,
                    quantityInDrafts: null,
                    supplierLeadDays: null,
                    velocity: null,
                    lastReceived: null,
                    quantity: null,
                    averageBuildConsumption: null,
                    slim: true,
                });
            }
        }
    }
    return [...bySku.values()];
}

// ── Legacy snapshot (keeps the BASAUTO Requests panel fresh) ────────────────

async function refreshLegacySnapshot(payload: RawBasautoPayload) {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        if (existsSync(LEGACY_SNAPSHOT)) {
            copyFileSync(LEGACY_SNAPSHOT, join(CACHE_DIR, "prev-snapshot.json"));
        }
        let requests: unknown[] = [];
        try {
            const token = readFileSync(TOKEN_FILE, "utf-8").trim();
            const res = await fetch(REQUESTS_URL, {
                headers: { Cookie: `__Secure-next-auth.session-token=${token}`, Accept: "application/json" },
                signal: AbortSignal.timeout(30_000),
            });
            if (res.ok) requests = (await res.json()) as unknown[];
        } catch {
            /* requests refresh is best-effort */
        }
        writeFileSync(
            LEGACY_SNAPSHOT,
            JSON.stringify(
                { requests, purchase_orders: { purchases: payload.purchases ?? [], overduePurchases: payload.overduePurchases ?? [] }, _poll_timestamp: new Date().toISOString() },
                null,
                2,
            ),
            "utf-8",
        );
    } catch (err: any) {
        console.warn("[basauto-recon] legacy snapshot refresh failed:", err?.message ?? err);
    }
}

// ── Aria purchasing fetch ───────────────────────────────────────────────────

async function fetchAria(): Promise<{ items: AriaItemLite[]; cachedAt: string | null }> {
    const res = await fetch(ARIA_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Aria purchasing API returned ${res.status}`);
    const data = (await res.json()) as {
        cachedAt?: string | null;
        groups?: Array<{ items?: any[] }>;
    };
    const items: AriaItemLite[] = [];
    for (const g of data.groups ?? []) {
        for (const it of g.items ?? []) {
            items.push({
                productId: String(it.productId ?? ""),
                urgency: it.urgency ?? null,
                stockOnHand: toNumber(it.stockOnHand),
                stockOnOrder: toNumber(it.stockOnOrder),
                dailyRate: toNumber(it.dailyRate),
                dailyRateSource: it.dailyRateSource ?? null,
                leadTimeDays: toNumber(it.leadTimeDays),
                effectiveLeadTimeDays: toNumber(it.effectiveLeadTimeDays),
                adjustedRunwayDays: toNumber(it.adjustedRunwayDays),
                runwayDays: toNumber(it.runwayDays),
                openPOs: Array.isArray(it.openPOs)
                    ? it.openPOs.map((po: any) => ({
                          orderId: String(po.orderId ?? po.orderNumber ?? ""),
                          quantity: toNumber(po.quantity) ?? 0,
                          orderDate: po.orderDate ?? po.expectedDate ?? null,
                      }))
                    : [],
                suggestedQty: toNumber(it.suggestedQty),
                assessmentDecision: it.assessment?.decision ?? null,
                assessmentRecommendedQty: toNumber(it.assessment?.recommendedQty),
                supplierName: it.supplierName ?? it.vendorName ?? null,
            });
        }
    }
    return { items, cachedAt: data.cachedAt ?? null };
}

// ── Dismiss list (reviewed noise) ───────────────────────────────────────────

/**
 * SKUs Bill has reviewed and declared noise. Pre-seeded with the known
 * Amazon office-supply items from the 2026-06-09 cross-reference; grows as
 * items are reviewed. Edit data/basauto-recon-dismissed.json to un-dismiss.
 */
const PRESEED_DISMISSED: Array<{ sku: string; note: string }> = [
    { sku: "KTG101", note: "Amazon key tags — office supply, purchase requests if needed" },
    { sku: "TN850", note: "Amazon Brother toner — office supply, purchase requests if needed" },
    { sku: "MTBC60", note: "Amazon scale — office supply, purchase requests if needed" },
    { sku: "TV400", note: "Amazon television — office supply, purchase requests if needed" },
];

function loadDismissedSkus(): Set<string> {
    const set = new Set<string>();
    try {
        const raw = JSON.parse(readFileSync(DISMISSED_FILE, "utf-8"));
        const arr = Array.isArray(raw) ? raw : raw?.skus;
        for (const entry of arr ?? []) {
            const sku = typeof entry === "string" ? entry : entry?.sku;
            if (sku) set.add(normalizeSku(sku));
        }
        return set;
    } catch {
        // First run — seed the file.
        mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
        writeFileSync(
            DISMISSED_FILE,
            JSON.stringify({ skus: PRESEED_DISMISSED, _note: "SKUs dismissed from basauto-recon. Remove a sku to restore it." }, null, 2),
            "utf-8",
        );
        return new Set(PRESEED_DISMISSED.map((d) => d.sku));
    }
}

// ── Morning report (stdout → cron delivery) ─────────────────────────────────

const VERDICT_LABEL: Record<string, string> = {
    OVERBUY_RISK: "OVERBUY RISK — do not re-buy",
    VELOCITY_MISMATCH: "VELOCITY GAP",
    FALSE_URGENT: "FALSE URGENCY",
    BORDERLINE: "BORDERLINE — review",
    MISSING_IN_ARIA: "MISSING IN ARIA",
    QTY_MISMATCH: "QTY DISAGREE",
    AGREE: "AGREE",
    ARIA_ONLY: "ARIA-ONLY FLAG",
};

const MAX_HIGH_LINES = 12;
const MAX_MEDIUM_LINES = 10;

function printMorningReport(report: ReconReport) {
    const s = report.summary;
    const lines: string[] = [];
    const dateStr = new Date(report.crawledAt).toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Denver",
    });
    lines.push(`BAS AUTO RECON · ${dateStr} MT (${report.source} crawl)`);
    lines.push(
        `${s.basautoItems} basauto products, ${s.basautoNonOK} flagged · ${s.ariaItems} Aria items · Aria cache ${report.ariaCachedAt ? new Date(report.ariaCachedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/Denver" }) : "?"}`,
    );
    if (report.errors.length > 0) {
        lines.push(`WARNINGS: ${report.errors.join("; ")}`);
    }
    lines.push("");

    const high = report.items.filter((it) => it.severity === "high");
    const medium = report.items.filter((it) => it.severity === "medium" && it.verdict !== "AGREE");

    if (high.length === 0 && medium.length === 0) {
        lines.push("No disagreements today. basauto and Aria agree on all flagged SKUs.");
        console.log(lines.join("\n"));
        return;
    }

    if (high.length > 0) {
        lines.push(`ACTION NEEDED (${high.length}):`);
        for (const it of high.slice(0, MAX_HIGH_LINES)) {
            lines.push(`  ${VERDICT_LABEL[it.verdict]}: ${it.sku} — ${it.reason.slice(0, 200)}`);
        }
        if (high.length > MAX_HIGH_LINES) {
            lines.push(`  ...and ${high.length - MAX_HIGH_LINES} more in the dashboard panel.`);
        }
        lines.push("");
    }
    if (medium.length > 0) {
        lines.push(`REVIEW (${medium.length}):`);
        for (const it of medium.slice(0, MAX_MEDIUM_LINES)) {
            lines.push(`  ${VERDICT_LABEL[it.verdict]}: ${it.sku} — ${it.reason.slice(0, 160)}`);
        }
        if (medium.length > MAX_MEDIUM_LINES) {
            lines.push(`  ...and ${medium.length - MAX_MEDIUM_LINES} more in the dashboard panel.`);
        }
    }
    console.log(lines.join("\n"));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const errors: string[] = [];

    // 1. Crawl basauto — API backdoor first, Playwright fallback.
    let basRecords: BasautoRecord[] | null = null;
    let source: "api" | "playwright" = "api";
    const apiPayload = await fetchBasautoApi();
    if (apiPayload) {
        basRecords = normalizeApi(apiPayload);
        await refreshLegacySnapshot(apiPayload);
    } else {
        console.error("[basauto-recon] API backdoor unavailable — falling back to Playwright scrape.");
        if (runPlaywrightScrape()) {
            try {
                const scraped = JSON.parse(readFileSync(SCRAPE_DATA_FILE, "utf-8"));
                basRecords = normalizeScraped(scraped);
                source = "playwright";
            } catch (err: any) {
                console.error("[basauto-recon] scraped data unreadable:", err?.message ?? err);
            }
        }
    }
    if (!basRecords || basRecords.length === 0) {
        console.error(
            "BAS AUTO RECON FAILED — basauto crawl produced no data.\n" +
                "Both the API backdoor and the Playwright session may be expired.\n" +
                "Refresh the NextAuth cookie at ~/AppData/Local/hermes/cache/basauto/session-token.txt\n" +
                "(DevTools → Application → Cookies → basauto.vercel.app → __Secure-next-auth.session-token).",
        );
        process.exit(1);
    }

    // 2. Fetch Aria reality.
    let ariaItems: AriaItemLite[] = [];
    let ariaCachedAt: string | null = null;
    try {
        const aria = await fetchAria();
        ariaItems = aria.items;
        ariaCachedAt = aria.cachedAt;
    } catch (err: any) {
        console.error("BAS AUTO RECON FAILED — Aria purchasing API unreachable:", err?.message ?? err);
        process.exit(1);
    }

    // 3. Assess + persist + report.
    const dismissedSkus = loadDismissedSkus();
    const report = buildReconReport(basRecords, ariaItems, { source, ariaCachedAt, errors }, { dismissedSkus });
    mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");
    printMorningReport(report);
    process.exit(0);
}

main().catch((err) => {
    console.error("BAS AUTO RECON FAILED — unhandled error:", err?.message ?? err);
    process.exit(1);
});
