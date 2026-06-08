/**
 * @file    build-risk.ts
 * @purpose Reusable Calendar Builds risk analysis engine.
 *          Can be called from the CLI agent, bot commands, or cron jobs.
 * @author  Aria
 * @created 2026-02-25
 * @updated 2026-02-25
 * @deps    finale, google/calendar, intelligence/build-parser
 *
 * DECISION(2026-02-25): Finale returns "--" for stockOnHand for ALL products
 * via productViewConnection (stock requires facility-level queries which are
 * not available via the API). Risk classification uses Finale's own calculated
 * stockoutDays + PO data for risk signals.
 *
 * Performance: Uses a concurrency pool (5 parallel) for API calls, reducing
 * 152-component verification from ~10min to ~2min.
 */

import { CalendarClient } from '../google/calendar';
import { BuildParser, ParsedBuild } from '../intelligence/build-parser';
import { FinaleClient } from '../finale/client';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface ComponentDemand {
    componentSku: string;
    productName?: string | null;       // Friendly Finale internalName (post-2026-05-12 snapshots)
    totalRequiredQty: number;
    onHand: number | null;           // Current stock on hand from Finale
    onOrder: number | null;
    stockoutDays: number | null;
    demandQuantity: number | null;
    consumptionQuantity: number | null;
    leadTimeDays: number | null;     // Supplier lead time in days (from Finale product)
    incomingPOs: Array<{ orderId: string; supplier: string; quantity: number; orderDate: string }>;
    usedIn: Set<string>;
    designations: Set<string>;
    riskLevel: 'CRITICAL' | 'WARNING' | 'WATCH' | 'OK';
    earliestBuildDate: string;
    hasFinaleData: boolean;
    vendorName: string | null;       // Primary supplier name (resolved from partygroup)
    vendorPartyId: string | null;     // Primary supplier partyId (for PO routing)
}

export interface UnrecognizedSku {
    sku: string;
    totalQty: number;
    earliestDate: string;
    suggestions: string[];  // Fuzzy match suggestions from Finale
}

export interface FGVelocity {
    dailyRate: number;               // Units sold per day (90-day rolling avg)
    stockOnHand: number | null;      // Current finished-good stock on shelf
    daysOfFinishedStock: number | null;  // stockOnHand / dailyRate
    openDemandQty: number;           // Committed sales orders not yet shipped
}

export interface BuildRiskReport {
    builds: ParsedBuild[];
    components: Map<string, ComponentDemand>;
    unrecognizedSkus: UnrecognizedSku[];
    fgVelocity: Map<string, FGVelocity>;  // Sales velocity per finished-good SKU
    criticalCount: number;
    warningCount: number;
    watchCount: number;
    okCount: number;
    totalComponents: number;
    daysOut: number;
    slackMessage: string;
    telegramMessage: string;
}

// ──────────────────────────────────────────────────
// CONCURRENCY POOL
// ──────────────────────────────────────────────────

/**
 * Run async tasks with a concurrency limit.
 * DECISION(2026-02-25): 5 concurrent API calls is the sweet spot —
 * fast enough to cut runtime by ~80%, slow enough to avoid Finale rate limits.
 */
async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number = 5,
    onProgress?: (completed: number, total: number) => void
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIdx = 0;
    let completed = 0;

    async function runNext(): Promise<void> {
        while (nextIdx < tasks.length) {
            const idx = nextIdx++;
            results[idx] = await tasks[idx]();
            completed++;
            if (onProgress && completed % 20 === 0) {
                onProgress(completed, tasks.length);
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
    await Promise.all(workers);
    return results;
}

// ──────────────────────────────────────────────────
// RISK CLASSIFICATION
// ──────────────────────────────────────────────────

/**
 * Classify component risk level.
 *
 * DECISION(2026-03-04): CRAFT builds pull from many vendors and have deep BOMs.
 * Give CRAFT components an extra 7-day buffer on all thresholds so they trigger
 * earlier and get more ordering lead time.
 *
 * 2026-06-08: Added build-demand fallback. Finale returns null for stockoutDays
 * on raw material / BOM components (no direct sales history). Without this, every
 * component with null stockoutDays silently fell through to OK — even when
 * onHand < build demand. Now derives runway from onHand / (totalRequiredQty/30)
 * when Finale's native stockoutDays is unavailable.
 */
function classifyRisk(demand: ComponentDemand, isCraftComponent: boolean = false): ComponentDemand['riskLevel'] {
    const hasPOs = demand.incomingPOs.length > 0;
    const onHand = demand.onHand ?? 0;
    const needed = demand.totalRequiredQty || 0;
    const leadTime = demand.leadTimeDays ?? 14; // default 14d when unknown

    // DECISION(2026-03-04): CRAFT builds pull from many vendors and have deep BOMs.
    // Give CRAFT components an extra 7-day buffer on all thresholds so they trigger
    // earlier and get more ordering lead time.
    const buffer = isCraftComponent ? 7 : 0;

    // ── Path 1: Finale provides stockoutDays ──
    if (demand.stockoutDays !== null && demand.stockoutDays > 0) {
        const days = demand.stockoutDays;
        if (days <= 14 + buffer && !hasPOs) return 'CRITICAL';
        if (days <= 14 + buffer && hasPOs) return 'WARNING';
        if (days <= 30 + buffer) return 'WARNING';
        if (days <= 60 + buffer) return 'WATCH';
        return 'OK';
    }

    // ── Path 2: Finale returns null stockoutDays — derive runway from build demand ──
    // dailyRate = totalRequiredQty (30d build need) / 30 → units consumed per day
    // derivedRunway = onHand / dailyRate → days of stock remaining
    const dailyRate = needed > 0 ? needed / 30 : 0;
    const derivedRunway = dailyRate > 0 ? onHand / dailyRate : (onHand > 0 ? 999 : 0);

    // Immediate deficit: onHand < 30d build need with no incoming POs
    const deficit = onHand < needed;
    const totalSupply = onHand + demand.incomingPOs.reduce((s, po) => s + (po.quantity || 0), 0);
    const supplyCovers = totalSupply >= needed;

    // CRITICAL: will run out before lead-time window closes, or current stock can't cover builds
    if ((derivedRunway < leadTime || (derivedRunway <= 14 + buffer)) && !hasPOs) return 'CRITICAL';
    if (derivedRunway <= 7 && deficit && !hasPOs) return 'CRITICAL';

    // WARNING: runway shorter than lead time + buffer, or deficit exists even with POs
    if (derivedRunway < leadTime + buffer || (deficit && !supplyCovers)) return 'WARNING';

    // Watch: deficit but POs cover it, or runway < 30d
    if (derivedRunway < 45 + buffer || (deficit && supplyCovers)) return 'WATCH';

    return 'OK';
}

// ──────────────────────────────────────────────────
// FUZZY SKU MATCHING
// ──────────────────────────────────────────────────

/**
 * Try to find similar SKUs in Finale for unrecognized ones.
 * Uses progressively shorter prefixes of the SKU as search keywords.
 */
async function findSuggestions(sku: string, finale: FinaleClient): Promise<string[]> {
    // Try the base SKU name without trailing numbers (e.g., GNARBAR02 → GNARBAR)
    const baseName = sku.replace(/\d+$/, '');
    if (baseName.length < 2) return [];

    try {
        const result = await finale.searchProducts(baseName, 5);
        return result.results
            .map(r => r.productId)
            .filter(id => id.toLowerCase() !== sku.toLowerCase());
    } catch {
        return [];
    }
}

// ──────────────────────────────────────────────────
// MAIN ENGINE
// ──────────────────────────────────────────────────

export async function runBuildRiskAnalysis(
    daysOut: number = 30,
    onProgress?: (msg: string) => void
): Promise<BuildRiskReport> {
    const log = onProgress || console.log;
    const finale = new FinaleClient();
    const calendar = new CalendarClient();
    const parser = new BuildParser();

    // Step 1: Fetch Calendar Events
    log(`📡 Fetching calendar events for next ${daysOut} days...`);
    const events = await calendar.getAllUpcomingBuilds(daysOut);
    if (events.length === 0) {
        log('✅ No builds scheduled.');
        return emptyReport(daysOut);
    }
    log(`✅ ${events.length} production events found.`);

    // Step 2: Parse to structured builds
    log(`🤖 Parsing events via LLM...`);
    const builds = await parser.extractBuildPlan(events);
    log(`✅ ${builds.length} builds extracted.`);

    // Aggregate by SKU
    const aggregatedBuilds = new Map<string, { totalQty: number; earliestDate: string; designations: Set<string> }>();
    for (const b of builds) {
        const existing = aggregatedBuilds.get(b.sku);
        if (existing) {
            existing.totalQty += b.quantity;
            existing.designations.add(b.designation || 'MFG');
            if (b.buildDate < existing.earliestDate) existing.earliestDate = b.buildDate;
        } else {
            const designations = new Set<string>();
            designations.add(b.designation || 'MFG');
            aggregatedBuilds.set(b.sku, { totalQty: b.quantity, earliestDate: b.buildDate, designations });
        }
    }

    // Step 2.5 (FG-traceback filter, 2026-06-08):
    // Fetch FG shelf coverage for every target finished-good, then drop the
    // ones where rebuild would create pure overstock. Without this filter the
    // Oracle sums every calendar build into totalRequiredQty — driving
    // component orders for products we already have 300+ days of FG inventory
    // on the shelf. Bill: "we don't control when MFG builds, but we control
    // what we buy." So we only buy components whose FG actually needs
    // rebuilding soon.
    //
    // Rule: an FG build is "optional" if onHand / dailySalesRate > leadTime
    //       + 28d safety buffer. Keep it otherwise (no data / zero sales /
    //       stockout-level shelf = we trust the calendar build).
    //
    // Thresholds:
    //   FG_COVERAGE_BUFFER_DAYS  = 28  (4-week safety above leadTime)
    //   LEADTIME_DEFAULT         = 14  (used when component LT unknown)
    //
    const FG_COVERAGE_BUFFER_DAYS = 28;
    const LEADTIME_DEFAULT = 14;
    const FG_VELOCITY_WINDOW = 90;
    log(`🔍 Fetching FG velocity for coverage filter (${aggregatedBuilds.size} FGs)...`);
    let fgVelocityPreFilter: Map<string, FGVelocity> = new Map();
    try {
        fgVelocityPreFilter = await finale.getFinishedGoodVelocity(
            Array.from(aggregatedBuilds.keys()),
            FG_VELOCITY_WINDOW,
        );
        const withData = Array.from(fgVelocityPreFilter.values()).filter(v => v.dailyRate > 0).length;
        log(`   Sales velocity for ${withData}/${aggregatedBuilds.size} FGs`);
    } catch (err: any) {
        log(`   ⚠️ FG velocity fetch failed for filter (continuing with calendar sum): ${err.message}`);
    }

    let droppedFGs = 0;
    const droppedFGLog: string[] = [];
    for (const [fgSku, meta] of Array.from(aggregatedBuilds.entries())) {
        const vel = fgVelocityPreFilter.get(fgSku);
        // Keep the build if: no FG velocity, 0 sales, null stock, or low shelf
        if (!vel) continue;
        if (!vel.dailyRate || vel.dailyRate === 0) continue;
        if (vel.stockOnHand === null || vel.stockOnHand === 0) continue;
        const coverageDays = vel.stockOnHand / vel.dailyRate;
        const threshold = LEADTIME_DEFAULT + FG_COVERAGE_BUFFER_DAYS;
        if (coverageDays > threshold) {
            aggregatedBuilds.delete(fgSku);
            droppedFGs++;
            droppedFGLog.push(
                `${fgSku}: ${Math.round(coverageDays)}d shelf (×${vel.dailyRate.toFixed(2)}/d) > ${threshold}d threshold`
            );
        }
    }
    if (droppedFGs > 0) {
        log(`   ✸ Dropped ${droppedFGs} optional FG build(s) — excessive FG shelf:`);
        for (const entry of droppedFGLog.slice(0, 10)) log(`      ${entry}`);
        if (droppedFGLog.length > 10) log(`      +${droppedFGLog.length - 10} more`);
        log(`   → ${aggregatedBuilds.size} FG builds remain after filter.`);
    } else {
        log(`   ✅ All ${aggregatedBuilds.size} FGs need rebuilding (none above coverage threshold).`);
    }

    // Step 3: Explode BOMs + track unrecognized SKUs
    // NOTE: This now only iterates over filtered FG builds (post FG-traceback).
    log(`💥 Exploding ${aggregatedBuilds.size} finished goods into raw components...`);
    const componentDemandTracker = new Map<string, ComponentDemand>();
    const unrecognizedSkus: UnrecognizedSku[] = [];

    for (const [fgSku, { totalQty, earliestDate, designations }] of aggregatedBuilds.entries()) {
        let rootComponents = await finale.getBillOfMaterials(fgSku);

        if (rootComponents.length === 0) {
            const suggestions = await findSuggestions(fgSku, finale);
            if (suggestions.length > 0) {
                // Auto-correct to top suggestion
                log(`   Auto-correcting BOM lookup for ${fgSku} using top suggestion: ${suggestions[0]}`);
                rootComponents = await finale.getBillOfMaterials(suggestions[0]);
            }
            if (rootComponents.length === 0) {
                unrecognizedSkus.push({ sku: fgSku, totalQty, earliestDate, suggestions });
                continue;
            }
        }

        // Recursive function to explode sub-assemblies down to raw materials
        const explodeBOM = async (sku: string, qtyMultiplier: number, rootFgSku: string, visited: Set<string> = new Set()) => {
            if (visited.has(sku)) return; // Prevent infinite recursion
            visited.add(sku);

            const subComponents = await finale.getBillOfMaterials(sku);

            if (subComponents.length === 0) {
                // It's a raw component! Record the required quantity based on the multiplier
                const requiredQty = qtyMultiplier;
                if (!componentDemandTracker.has(sku)) {
                    componentDemandTracker.set(sku, {
                        componentSku: sku,
                        productName: null,
                        totalRequiredQty: 0,
                        onHand: null,
                        onOrder: null,
                        stockoutDays: null,
                        demandQuantity: null,
                        consumptionQuantity: null,
                        leadTimeDays: null,
                        incomingPOs: [],
                        usedIn: new Set(),
                        designations: new Set(),
                        riskLevel: 'OK',
                        hasFinaleData: false,
                        earliestBuildDate: earliestDate,
                        vendorName: null,
                        vendorPartyId: null,
                    });
                }
                const demand = componentDemandTracker.get(sku)!;
                demand.totalRequiredQty += requiredQty;
                demand.usedIn.add(rootFgSku);
                for (const d of designations) demand.designations.add(d);
                if (earliestDate < demand.earliestBuildDate) demand.earliestBuildDate = earliestDate;
            } else {
                // It's a sub-assembly, recurse!
                for (const sub of subComponents) {
                    await explodeBOM(sub.componentSku, sub.quantity * qtyMultiplier, rootFgSku, visited);
                }
            }
        };

        // Explode all top-level components
        for (const comp of rootComponents) {
            await explodeBOM(comp.componentSku, comp.quantity * totalQty, fgSku);
        }
    }

    // Fuzzy-match unrecognized SKUs
    if (unrecognizedSkus.length > 0) {
        log(`🔍 Searching for similar SKUs for ${unrecognizedSkus.length} unrecognized items...`);
        for (const u of unrecognizedSkus) {
            u.suggestions = await findSuggestions(u.sku, finale);
        }
    }

    log(`✅ ${componentDemandTracker.size} unique raw components identified.`);

    // Step 4: Advanced Stock Verification (PARALLELIZED)
    log(`📦 Running stock verification (5x parallel)...`);
    const demandEntries = Array.from(componentDemandTracker.values());

    // Batch-resolve vendor info for all component SKUs before parallel stock verification
    const allSkus = demandEntries.map(d => d.componentSku);
    const vendorMap = await finale.lookupComponentVendorBatch(allSkus);

    const tasks = demandEntries.map(demand => async () => {
        const profile = await finale.getComponentStockProfile(demand.componentSku);
        demand.productName = profile.productName;
        demand.onHand = profile.onHand;
        demand.onOrder = profile.onOrder;
        demand.stockoutDays = profile.stockoutDays;
        demand.demandQuantity = profile.demandQuantity;
        demand.consumptionQuantity = profile.consumptionQuantity;
        demand.leadTimeDays = profile.leadTimeDays;
        demand.incomingPOs = profile.incomingPOs;
        demand.hasFinaleData = profile.hasFinaleData;
        const isCraft = Array.from(demand.usedIn).some(fg => fg.toUpperCase().startsWith('CRAFT'));
        demand.riskLevel = classifyRisk(demand, isCraft);

        // Attach vendor resolution (already resolved above)
        const resolved = vendorMap.get(demand.componentSku);
        if (resolved) {
            demand.vendorName = resolved.vendorName;
            demand.vendorPartyId = resolved.vendorPartyId;
        }
    });

    await runWithConcurrency(tasks, 5, (completed, total) => {
        log(`   Checked ${completed}/${total}...`);
    });

    let criticalCount = 0, warningCount = 0, watchCount = 0;
    for (const d of demandEntries) {
        if (d.riskLevel === 'CRITICAL') criticalCount++;
        if (d.riskLevel === 'WARNING') warningCount++;
        if (d.riskLevel === 'WATCH') watchCount++;
    }

    const okCount = demandEntries.length - criticalCount - warningCount - watchCount;
    log(`✅ 🔴 ${criticalCount} critical · 🟡 ${warningCount} warning · 👀 ${watchCount} watch · ✅ ${okCount} OK`);

    // Step 5: FG velocity — reuse the snapshot taken at Step 2.5 (FG trace-back).
    // No second Finale call needed; same 90-day window, same FGs (plus dropped
    // over-stock FGs that the formatter can still surface for audit trail).
    log(`📈 FG velocity carried from Step 2.5 (${fgVelocityPreFilter.size} FGs).`);
    const fgVelocity: Map<string, FGVelocity> = fgVelocityPreFilter;
    const withData = Array.from(fgVelocity.values()).filter(v => v.dailyRate > 0).length;
    log(`   Sales velocity for ${withData}/${fgVelocity.size} SKUs.`);

    const slackMessage = formatSlackReport(builds, componentDemandTracker, unrecognizedSkus, daysOut, fgVelocity);
    const telegramMessage = formatTelegramReport(builds, componentDemandTracker, unrecognizedSkus, daysOut, fgVelocity);

    return {
        builds,
        components: componentDemandTracker,
        unrecognizedSkus,
        fgVelocity,
        criticalCount,
        warningCount,
        watchCount,
        okCount,
        totalComponents: demandEntries.length,
        daysOut,
        slackMessage,
        telegramMessage,
    };
}

// ──────────────────────────────────────────────────
// FORMATTERS
// ──────────────────────────────────────────────────

function formatSlackReport(
    builds: ParsedBuild[],
    components: Map<string, ComponentDemand>,
    unrecognizedSkus: UnrecognizedSku[],
    daysOut: number,
    fgVelocity: Map<string, FGVelocity> = new Map(),
): string {
    const criticals = Array.from(components.values()).filter(c => c.riskLevel === 'CRITICAL');
    const warnings = Array.from(components.values()).filter(c => c.riskLevel === 'WARNING');
    const watches = Array.from(components.values()).filter(c => c.riskLevel === 'WATCH');
    const oks = Array.from(components.values()).filter(c => c.riskLevel === 'OK');

    const totalBuilds = builds.length;
    const uniqueFGs = new Set(builds.map(b => b.sku)).size;

    let msg = `*${daysOut}-Day SOIL/MFG Build Calendar*\n`;
    msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' })}_\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*${totalBuilds}* builds · *${uniqueFGs}* finished goods · *${components.size}* raw components\n\n`;

    // Sales velocity section — show FG SKUs that have meaningful sell-through data
    const velocityRows = Array.from(fgVelocity.entries())
        .filter(([, v]) => v.dailyRate > 0)
        .sort((a, b) => (b[1].dailyRate) - (a[1].dailyRate));
    if (velocityRows.length > 0) {
        msg += `*📈 Finished Good Sell-Through (90-Day Avg)*\n`;
        for (const [sku, v] of velocityRows) {
            const rate = v.dailyRate < 1 ? v.dailyRate.toFixed(1) : Math.round(v.dailyRate).toString();
            const stockNote = v.daysOfFinishedStock !== null
                ? ` · ~${v.daysOfFinishedStock}d on shelf`
                : '';
            const demandNote = v.openDemandQty > 0 ? ` · ${v.openDemandQty.toLocaleString()} open demand` : '';
            msg += `• \`${sku}\`: ${rate}/day${stockNote}${demandNote}\n`;
        }
        msg += `\n`;
    }

    // ── CRAFT build awareness ────────────────────────────────────────────
    // DECISION(2026-03-04): Keep it brief. The real work is in classifyRisk()
    // which gives CRAFT components a +7d buffer on all thresholds.
    const craftBuilds = builds.filter(b => b.sku.toUpperCase().startsWith('CRAFT'));
    if (craftBuilds.length > 0) {
        const craftSkus = [...new Set(craftBuilds.map(b => b.sku))];
        const craftCompCount = Array.from(components.values())
            .filter(c => Array.from(c.usedIn).some(fg => fg.toUpperCase().startsWith('CRAFT'))).length;
        msg += `🔬 _CRAFT builds detected (${craftSkus.join(', ')}) — ${craftCompCount} components given +7d lead time buffer_\n\n`;
    }

    if (criticals.length > 0) {
        msg += `*[CRITICAL] STOCKOUT ≤ 14 DAYS, NO PO (${criticals.length})*\n\n`;
        for (const c of criticals.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999))) {
            const desig = Array.from(c.designations).join('/');
            msg += `• *[${desig}] \`${c.componentSku}\`* — Stockout in *${c.stockoutDays ?? '?'}* days\n`;
            msg += `  Build demand: ${c.totalRequiredQty.toLocaleString()}  |  No incoming POs\n`;
            msg += `  First needed: ${c.earliestBuildDate}  |  Used in: ${Array.from(c.usedIn).slice(0, 5).join(', ')}\n\n`;
        }
    }

    if (warnings.length > 0) {
        msg += `*[WARNING] STOCKOUT ≤ 30 DAYS (${warnings.length})*\n\n`;
        for (const c of warnings.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999))) {
            const desig = Array.from(c.designations).join('/');
            const poInfo = c.incomingPOs.length > 0
                ? `  |  ${c.incomingPOs.length} PO(s) incoming`
                : '';
            msg += `• *[${desig}] \`${c.componentSku}\`* — ${c.stockoutDays ?? '?'}d to stockout${poInfo}\n`;
            if (c.incomingPOs.length > 0) {
                for (const po of c.incomingPOs) {
                    msg += `  ↳ PO ${po.orderId}: ${po.quantity.toLocaleString()} from ${po.supplier}\n`;
                }
            }
            msg += `\n`;
        }
    }

    if (watches.length > 0) {
        msg += `*[WATCH] RUNWAY ≤ 60 DAYS (${watches.length})*\n`;
        for (const c of watches.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999))) {
            const desig = Array.from(c.designations).join('/');
            msg += `• [${desig}] \`${c.componentSku}\` — ${c.stockoutDays ?? '?'}d\n`;
        }
        msg += `\n`;
    }

    if (unrecognizedSkus.length > 0) {
        msg += `*[UNRECOGNIZED SKUS] (${unrecognizedSkus.length})*\n`;
        msg += `_Finished goods from calendar missing in Finale._\n`;
        for (const u of unrecognizedSkus) {
            msg += `• \`${u.sku}\` — ${u.totalQty} units on ${u.earliestDate}`;
            if (u.suggestions.length > 0) {
                msg += `\n  _Match suggestion:_ \`${u.suggestions[0]}\``;
            }
            msg += `\n`;
        }
        msg += `\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (criticals.length === 0 && warnings.length === 0) {
        msg += `*Status:* All components are on track for the next ${daysOut} days.\n`;
    } else {
        msg += `*Summary:* Critical: ${criticals.length}  |  Warning: ${warnings.length}  |  Watch: ${watches.length}  |  OK: ${oks.length}\n`;
    }

    return msg;
}

function formatTelegramReport(
    builds: ParsedBuild[],
    components: Map<string, ComponentDemand>,
    unrecognizedSkus: UnrecognizedSku[],
    daysOut: number,
    fgVelocity: Map<string, FGVelocity> = new Map(),
): string {
    const criticals = Array.from(components.values()).filter(c => c.riskLevel === 'CRITICAL');
    const warnings = Array.from(components.values()).filter(c => c.riskLevel === 'WARNING');
    const watches = Array.from(components.values()).filter(c => c.riskLevel === 'WATCH');
    const oks = Array.from(components.values()).filter(c => c.riskLevel === 'OK');

    const totalBuilds = builds.length;
    const uniqueFGs = new Set(builds.map(b => b.sku)).size;

    let msg = `*${daysOut}-Day SOIL/MFG Build Calendar*\n`;
    msg += `_${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Denver' })}_\n`;
    msg += `Builds: ${totalBuilds}  |  FGs: ${uniqueFGs}  |  Components: ${components.size}\n\n`;

    // Sales velocity — compact one-liner per selling SKU
    const velocityRows = Array.from(fgVelocity.entries())
        .filter(([, v]) => v.dailyRate > 0)
        .sort((a, b) => b[1].dailyRate - a[1].dailyRate);
    if (velocityRows.length > 0) {
        msg += `*📈 Sell-Through (90d avg)*\n`;
        for (const [sku, v] of velocityRows.slice(0, 8)) {
            const rate = v.dailyRate < 1 ? v.dailyRate.toFixed(1) : Math.round(v.dailyRate).toString();
            const shelf = v.daysOfFinishedStock !== null ? ` · ${v.daysOfFinishedStock}d stock` : '';
            msg += `• \`${sku}\`: ${rate}/day${shelf}\n`;
        }
        if (velocityRows.length > 8) msg += `_...+${velocityRows.length - 8} more_\n`;
        msg += `\n`;
    }

    // ── CRAFT build awareness (Telegram) ─────────────────────────────────
    const craftBuildsTg = builds.filter(b => b.sku.toUpperCase().startsWith('CRAFT'));
    if (craftBuildsTg.length > 0) {
        const craftSkusTg = [...new Set(craftBuildsTg.map(b => b.sku))];
        const craftCompCountTg = Array.from(components.values())
            .filter(c => Array.from(c.usedIn).some(fg => fg.toUpperCase().startsWith('CRAFT'))).length;
        msg += `🔬 _CRAFT builds (${craftSkusTg.join(', ')}) — ${craftCompCountTg} comps get +7d buffer_\n\n`;
    }

    if (criticals.length > 0) {
        msg += `*[CRITICAL] (${criticals.length}):*\n`;
        for (const c of criticals.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999)).slice(0, 15)) {
            const desig = Array.from(c.designations).join('/');
            msg += `• [${desig}] \`${c.componentSku}\` — Stockout in ${c.stockoutDays ?? '?'}d, no POs\n`;
            msg += `  ↳ Used in: ${Array.from(c.usedIn).slice(0, 3).join(', ')}\n`;
        }
        if (criticals.length > 15) msg += `_...and ${criticals.length - 15} more_\n`;
        msg += `\n`;
    }

    if (warnings.length > 0) {
        msg += `*[WARNING] (${warnings.length}):*\n`;
        for (const c of warnings.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999)).slice(0, 10)) {
            const desig = Array.from(c.designations).join('/');
            const poNote = c.incomingPOs.length > 0 ? ` (${c.incomingPOs.length} PO)` : '';
            msg += `• [${desig}] \`${c.componentSku}\` — ${c.stockoutDays ?? '?'}d${poNote}\n`;
        }
        if (warnings.length > 10) msg += `_...and ${warnings.length - 10} more_\n`;
        msg += `\n`;
    }

    if (watches.length > 0) {
        msg += `*[WATCH] (${watches.length}):*\n`;
        for (const c of watches.slice(0, 5)) {
            const desig = Array.from(c.designations).join('/');
            msg += `• [${desig}] \`${c.componentSku}\` — ${c.stockoutDays ?? '?'}d\n`;
        }
        if (watches.length > 5) msg += `_...and ${watches.length - 5} more_\n`;
        msg += `\n`;
    }

    if (unrecognizedSkus.length > 0) {
        msg += `*[UNRECOGNIZED] (${unrecognizedSkus.length}):*\n`;
        for (const u of unrecognizedSkus) {
            msg += `• \`${u.sku}\` (${u.totalQty})`;
            if (u.suggestions.length > 0) {
                msg += ` → Did you mean \`${u.suggestions[0]}\`?`;
            }
            msg += `\n`;
        }
        msg += `\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (criticals.length === 0 && warnings.length === 0) {
        msg += `*Status:* All clear for the next ${daysOut} days!\n`;
    } else {
        msg += `*Summary:* Critical: ${criticals.length}  |  Warning: ${warnings.length}  |  Watch: ${watches.length}  |  OK: ${oks.length}\n`;
    }

    return msg;
}

function emptyReport(daysOut: number): BuildRiskReport {
    return {
        builds: [],
        components: new Map(),
        unrecognizedSkus: [],
        fgVelocity: new Map(),
        criticalCount: 0,
        warningCount: 0,
        watchCount: 0,
        okCount: 0,
        totalComponents: 0,
        daysOut,
        slackMessage: '✅ No builds scheduled.',
        telegramMessage: '✅ No builds scheduled.',
    };
}

// ──────────────────────────────────────────────────
// SINGLE BUILD SIMULATOR
// ──────────────────────────────────────────────────

export async function simulateBuild(sku: string, quantity: number, onProgress?: (msg: string) => void): Promise<string> {
    const log = onProgress || console.log;
    const finale = new FinaleClient();

    log(`🔍 Looking up BOM for ${quantity}x \`${sku}\`...`);
    let rootComponents = await finale.getBillOfMaterials(sku);
    let targetSku = sku;

    if (rootComponents.length === 0) {
        log(`⚠️ \`${sku}\` not found exact, attempting fuzzy match...`);
        const suggestions = await findSuggestions(sku, finale);
        if (suggestions.length > 0) {
            targetSku = suggestions[0];
            log(`✨ Auto-corrected to \`${targetSku}\``);
            rootComponents = await finale.getBillOfMaterials(targetSku);
        }

        if (rootComponents.length === 0) {
            return `❌ *Could not find BOM for \`${sku}\`* (and no close matches found). Ensure the SKU exists in Finale and has a valid Bill of Materials.`;
        }
    }

    log(`💥 Exploding BOM for ${targetSku}...`);
    const demandTracker = new Map<string, number>();

    const explodeBOM = async (currentSku: string, qtyMultiplier: number, visited: Set<string> = new Set()) => {
        if (visited.has(currentSku)) return;
        visited.add(currentSku);

        const subComponents = await finale.getBillOfMaterials(currentSku);

        if (subComponents.length === 0) {
            // Raw Component
            demandTracker.set(currentSku, (demandTracker.get(currentSku) || 0) + qtyMultiplier);
        } else {
            // Sub-assembly
            for (const sub of subComponents) {
                await explodeBOM(sub.componentSku, sub.quantity * qtyMultiplier, visited);
            }
        }
    };

    // Kick off explosion
    for (const comp of rootComponents) {
        await explodeBOM(comp.componentSku, comp.quantity * quantity);
    }

    if (demandTracker.size === 0) {
        return `⚠️ *${targetSku}* has no raw components in its BOM.`;
    }

    log(`📦 Verifying stock for ${demandTracker.size} unique raw components...`);
    const results: Array<{ sku: string, required: number, stock: number, canBuild: number, isShort: boolean }> = [];

    const tasks = Array.from(demandTracker.entries()).map(([compSku, requiredQty]) => async () => {
        // Quick lookup for stock
        let stockOnHand = 0;
        try {
            const stockLevel = await finale.getStockLevel(compSku);
            if (stockLevel !== null) {
                stockOnHand = stockLevel;
            } else {
                const profile = await finale.getComponentStockProfile(compSku);
                if (profile.hasFinaleData && profile.onHand !== null) {
                    stockOnHand = profile.onHand;
                }
            }
        } catch (e) { /* ignore */ }

        const canBuild = requiredQty > 0 ? Math.floor(stockOnHand / (requiredQty / quantity)) : Infinity;
        results.push({
            sku: compSku,
            required: requiredQty,
            stock: stockOnHand,
            canBuild,
            isShort: stockOnHand < requiredQty
        });
    });

    await runWithConcurrency(tasks, 5, (c, t) => log(`   Stock check ${c}/${t}...`));

    // Sort to find the lowest bottleneck
    results.sort((a, b) => a.canBuild - b.canBuild);

    const maxPossbleToBuild = results[0].canBuild;
    const bottlenecks = results.filter(r => r.canBuild === maxPossbleToBuild);

    let msg = `🏭 *Build Simulation: ${quantity}x \`${targetSku}\`*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    const shorts = results.filter(r => r.isShort);
    if (shorts.length > 0) {
        msg += `🚨 *SHORTAGES DETECTED (${shorts.length})*\n`;
        for (const s of shorts.sort((a, b) => (a.stock - a.required) - (b.stock - b.required))) {
            msg += `• \`${s.sku}\`: Need *${s.required.toLocaleString()}* (Only have ${s.stock.toLocaleString()}) → Short *${(s.required - s.stock).toLocaleString()}*\n`;
        }
        msg += `\n`;
    } else {
        msg += `✅ *All components available for this build.*\n\n`;
    }

    msg += `📉 *MAX CAPACITY LIMIT*\n`;
    if (maxPossbleToBuild >= quantity) {
        msg += `You can build the requested ${quantity} units.\n`;
        msg += `In fact, you have enough raw materials to build *${maxPossbleToBuild.toLocaleString()} units* total.\n`;
        msg += `_Limiting component: \`${bottlenecks[0].sku}\`_\n\n`;
    } else {
        msg += `You *cannot* build ${quantity} units right now.\n`;
        msg += `Current raw materials limit you to a maximum of *${maxPossbleToBuild.toLocaleString()} units*.\n`;
        msg += `_You will run out of \`${bottlenecks.map(b => b.sku).join(', ')}\` first._\n\n`;
    }

    // List all requirements compactly if it's not too huge
    if (results.length <= 30) {
        msg += `📋 *COMPONENT CHECKLIST*\n`;
        // Sort by required quantity descending for readability
        for (const r of [...results].sort((a, b) => b.required - a.required)) {
            const emoji = r.isShort ? '❌' : '✅';
            msg += `${emoji} \`${r.sku}\`: ${r.required.toLocaleString()} (Stock: ${r.stock.toLocaleString()})\n`;
        }
    } else {
        msg += `_Note: ${results.length} raw components checked. (List too long to display full checklist)._`;
    }

    return msg;
}
