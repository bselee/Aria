/**
 * @file    order-uline.ts
 * @purpose Gather items from Finale POs and place a faux order on ULINE via Quick Order.
 *          Extracts ULINE-vendor items from Finale, reverse-maps SKUs to ULINE model numbers,
 *          and uses the Paste Items Page on uline.com to add them to cart.
 *          DOES NOT checkout — user reviews and submits manually.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-03-16
 * @deps    playwright, dotenv, finale/client
 *
 * Usage:
 *   node --import tsx src/cli/order-uline.ts                # All ULINE draft POs
 *   node --import tsx src/cli/order-uline.ts --po 124500    # Specific Finale PO
 *   node --import tsx src/cli/order-uline.ts --dry-run      # Preview only (no browser)
 *   node --import tsx src/cli/order-uline.ts --grid         # Use grid entry instead of paste
 *   node --import tsx src/cli/order-uline.ts --auto-reorder # Auto-detect items needing reorder
 *   node --import tsx src/cli/order-uline.ts --auto-reorder --create-po  # + create draft PO in Finale
 *   node --import tsx src/cli/order-uline.ts --scrape-confirmation       # Scrape order # after checkout
 *
 * PREREQ: Close Chrome before running (Playwright needs exclusive profile access).
 *         User must have logged into uline.com in their regular Chrome browser.
 *
 * DECISION(2026-03-16): Two ULINE ordering methods discovered:
 *   1. "Paste Items Page" — single textarea, format: "ModelNumber, Quantity" per line.
 *      Best for bulk orders. Uses textarea#txtPaste + button#btnAddPastedItemsToCart.
 *   2. "Grid" — individual input fields: txtItem0/txtItem0Quantity through txtItem9.
 *      Better for small orders (<10 items). Supports "Add Rows" for more.
 * Default is Paste method (handles any order size cleanly).
 *
 * SAFETY: This tool ONLY adds items to the ULINE cart. It never proceeds to checkout.
 * The user must manually review and submit the order on uline.com.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { type Page } from 'playwright';
import { FinaleClient } from '../lib/finale/client';
import {
    convertFinaleItemToUlineOrder,
    toUlineModel,
} from '../lib/purchasing/uline-ordering';
import {
    diffObservedUlineCartRows,
    scrapeObservedUlineCartRows,
    syncVerifiedUlineCartPricesToDraftPO,
} from '../lib/purchasing/uline-cart-live';
import {
    launchUlineSession,
    openUlinePasteItemsPage,
} from '../lib/purchasing/uline-session';
import { buildVendorDraftPlans } from '../lib/purchasing/vendor-draft-plans';
import {
    formatCartVerificationMessage,
    planDraftPOPriceUpdates,
    verifyUlineCart,
    type CartVerificationResult,
    type ObservedUlineCartRow,
} from './order-uline-cart';

// ── Config ────────────────────────────────────────────────────────────────────

const QUICK_ORDER_URL = 'https://www.uline.com/Ordering/QuickOrder';

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderLineItem {
    finaleSku: string;
    ulineModel: string;
    quantity: number;              // ULINE cart quantity
    unitPrice: number;             // ULINE unit price
    description: string;
    finaleEachQuantity: number;
    finaleUnitPrice: number;
    effectiveEachQuantity: number;
    orderUnitEaches: number;
    quantityStep: number;
    guardrailWarnings: string[];
}

interface OrderManifest {
    sourceType: 'draft_po' | 'committed_po' | 'auto_reorder';
    sourcePO: string | null;
    items: OrderLineItem[];
    totalEstimate: number;
}

interface UlineCartFillResult {
    message: string;
    verification: CartVerificationResult;
    observedRows: ObservedUlineCartRow[];
    errorText?: string;
}

// ── Parse CLI Args ────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        dryRun: args.includes('--dry-run'),
        useGrid: args.includes('--grid'),
        singlePO: args.includes('--po') ? args[args.indexOf('--po') + 1] : null,
        autoReorder: args.includes('--auto-reorder'),
        createPO: args.includes('--create-po'),
        scrapeConfirmation: args.includes('--scrape-confirmation'),
    };
}

// ── Phase 1: Gather Items from Finale ─────────────────────────────────────────

/**
 * Extract ULINE items from a specific Finale PO.
 * Resolves vendor name to confirm it's a ULINE PO.
 *
 * @param finale - FinaleClient instance
 * @param orderId - Finale PO number
 * @returns OrderManifest with items mapped to ULINE model numbers
 */
async function gatherFromPO(finale: FinaleClient, orderId: string): Promise<OrderManifest> {
    console.log(`   📦 Fetching PO #${orderId} from Finale...`);
    const po = await finale.getOrderDetails(orderId);

    const items: OrderLineItem[] = [];
    for (const item of (po.orderItemList || [])) {
        const finaleId = item.productUrl?.split('/').pop() || item.productId || '';
        if (!finaleId || (item.quantity ?? 0) <= 0) continue;

        items.push(convertFinaleItemToUlineOrder({
            finaleSku: finaleId,
            ulineModel: toUlineModel(finaleId),
            finaleEachQuantity: item.quantity || 0,
            finaleUnitPrice: item.unitPrice || 0,
            description: item.itemDescription || finaleId,
        }));
    }

    const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

    return {
        sourceType: po.statusId === 'ORDER_CREATED' ? 'draft_po' : 'committed_po',
        sourcePO: orderId,
        items,
        totalEstimate: total,
    };
}

/**
 * Find all ULINE draft POs in Finale and gather their items.
 * Searches for POs with "ULINE" in the supplier name.
 *
 * @param finale - FinaleClient instance
 * @returns Array of OrderManifests, one per PO
 */
async function gatherAllUlineDraftPOs(finale: FinaleClient): Promise<OrderManifest[]> {
    console.log('   🔍 Searching for ULINE draft POs in Finale...');

    // DECISION(2026-03-16): Use the REST API to find all draft POs, then filter
    // for ULINE vendor. The GraphQL approach requires knowing the vendor partyUrl.
    // Since we need to match by vendor NAME, we fetch all drafts and filter client-side.
    const base = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
    const account = process.env.FINALE_ACCOUNT_PATH || '';
    const auth = 'Basic ' + Buffer.from(
        `${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`
    ).toString('base64');

    const query = {
        query: `{
            orderViewConnection(
                first: 50
                type: ["PURCHASE_ORDER"]
                status: ["Created", "Committed"]
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId status orderDate
                    supplier { name }
                    itemList(first: 100) {
                        edges { node {
                            product { productId }
                            quantity
                            unitPrice
                        }}
                    }
                }}
            }
        }`
    };

    const res = await fetch(`${base}/${account}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
    });
    const json: any = await res.json();
    const edges: any[] = json.data?.orderViewConnection?.edges || [];

    // Filter for ULINE vendor (case-insensitive)
    const ulinePOs = edges.filter((e: any) =>
        (e.node.supplier?.name || '').toLowerCase().includes('uline')
    );

    console.log(`   Found ${ulinePOs.length} ULINE PO(s) out of ${edges.length} total\n`);

    const manifests: OrderManifest[] = [];
    for (const edge of ulinePOs) {
        const po = edge.node;
        const items: OrderLineItem[] = [];

        for (const itemEdge of (po.itemList?.edges || [])) {
            const item = itemEdge.node;
            const finaleId = item.product?.productId || '';
            if (!finaleId || (item.quantity ?? 0) <= 0) continue;

            items.push(convertFinaleItemToUlineOrder({
                finaleSku: finaleId,
                ulineModel: toUlineModel(finaleId),
                finaleEachQuantity: item.quantity || 0,
                finaleUnitPrice: item.unitPrice || 0,
                description: finaleId,
            }));
        }

        if (items.length > 0) {
            manifests.push({
                sourceType: po.status === 'Created' ? 'draft_po' : 'committed_po',
                sourcePO: po.orderId,
                items,
                totalEstimate: items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
            });
        }
    }

    return manifests;
}

/**
 * Auto-detect ULINE items needing reorder by scanning Finale's purchasing intelligence.
 * Filters the full product catalog for ULINE-vendor items with critical/warning urgency,
 * then builds an OrderManifest with suggested quantities.
 *
 * DECISION(2026-03-16): This connects getPurchasingIntelligence() directly to the
 * ULINE ordering pipeline. Only items from the ULINE vendor with urgency 'critical'
 * or 'warning' are included. Quantities use Finale's suggestedQty (velocity × (leadTime + 60d)).
 *
 * @param finale - FinaleClient instance
 * @returns OrderManifest with auto-detected items (sourceType='auto_reorder')
 */
export async function gatherAutoReorderItems(finale: FinaleClient): Promise<OrderManifest> {
    console.log('   🤖 Running purchasing intelligence scan for ULINE items...');
    console.log('   ⏳ Using Finale vendor-scoped purchasing intelligence for ULINE...\n');
    const groups = await finale.getPurchasingIntelligence(365, 'ULINE');
    const plans = buildVendorDraftPlans(groups, {}, 'uline');

    if (plans.length === 0) {
        console.log('   ℹ️  No ULINE vendor group found in purchasing intelligence');
        return { sourceType: 'auto_reorder', sourcePO: null, items: [], totalEstimate: 0 };
    }

    console.log(`   Found ${plans.length} ULINE group(s): ${plans.map(g => g.vendorName).join(', ')}\n`);

    const items: OrderLineItem[] = [];
    const skippedLowVelocity: Array<{ productId: string; dailyRate: number; explanation: string }> = [];
    let lowestRunway = Infinity;

    // DECISION(2026-03-16): Minimum velocity filter for auto-reorder.
    // Items with < 0.1 units/day are typically one-off facility purchases
    // (clipboards, spray paint, hand trucks, privacy fence, etc.) that were
    // bought once and shouldn't auto-reorder. We show them for manual review
    // but don't include them in the order manifest.
    const MIN_DAILY_VELOCITY = 0.1;

    for (const plan of plans) {
        if (!plan.autoDraftEligible) {
            console.log(`   ⏸️  Skipping ${plan.vendorName}: shared purchasing policy marked this vendor plan as manual review only.`);
            continue;
        }

        for (const line of plan.assessedItems) {
            const item = line.item;
            if (!(line.assessment.decision === 'order' || line.assessment.decision === 'reduce')) {
                continue;
            }

            // Filter out one-off purchases with negligible velocity
            if (item.dailyRate < MIN_DAILY_VELOCITY) {
                skippedLowVelocity.push({
                    productId: item.productId,
                    dailyRate: item.dailyRate,
                    explanation: item.explanation,
                });
                continue;
            }

            if (item.adjustedRunwayDays < lowestRunway) {
                lowestRunway = item.adjustedRunwayDays;
            }

            const urgencyIcon = item.urgency === 'critical' ? '🔴' : '🟡';
            console.log(`   ${urgencyIcon} ${item.productId}: ${line.assessment.explanation}`);
            console.log(`      Suggested qty: ${line.assessment.recommendedQty} | Stock: ${Math.round(item.stockOnHand)} | On order: ${Math.round(item.stockOnOrder)} | Runway: ${item.adjustedRunwayDays.toFixed(1)}d`);

            items.push(convertFinaleItemToUlineOrder({
                finaleSku: item.productId,
                ulineModel: toUlineModel(item.productId),
                finaleEachQuantity: line.assessment.recommendedQty,
                finaleUnitPrice: item.unitPrice,
                description: item.productName,
            }));
        }
    }

    const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

    // DECISION(2026-03-16): Smart Order Deferral
    // ULINE orders are placed on Fridays. Minimum 7 days to next Friday + 5 days buffer/transit = 12 days.
    // If our lowest runway across ALL needed items is > 12 days, we could technically 
    // wait until next Friday to place this order without any item dropping to a 0-day runway.
    // To prevent small frequent POs, we defer the order entirely if we have enough runway
    // AND the total dollar amount is less than a threshold ($500).
    // If the runway is critical (<= 12) we order regardless of price to prevent a stockout.
    const SAFE_RUNWAY_DAYS = 12;
    const MIN_ORDER_SIZE_FOR_EARLY_PO = 500;
    
    let deferred = false;
    if (items.length > 0) {
        if (lowestRunway > SAFE_RUNWAY_DAYS && total < MIN_ORDER_SIZE_FOR_EARLY_PO) {
            console.log(`\n   ⏸️  DEFERRING ORDER:`);
            console.log(`      • Shortest runway is ${lowestRunway.toFixed(1)} days (safe to wait until next week).`);
            console.log(`      • Total is $${total.toFixed(2)} (under $${MIN_ORDER_SIZE_FOR_EARLY_PO} early PO threshold).`);
            items.length = 0; // Empty the array to halt PO creation
            deferred = true;
        } else if (lowestRunway <= SAFE_RUNWAY_DAYS) {
            console.log(`\n   🟢 MUST ORDER: Shortest runway is ${lowestRunway.toFixed(1)} days (will run out before next cycle).`);
        } else {
            console.log(`\n   🟢 LARGE ORDER: Shortest runway is safe (${lowestRunway.toFixed(1)}d), but total is $${total.toFixed(2)} (≥ $${MIN_ORDER_SIZE_FOR_EARLY_PO}).`);
        }
    }

    if (items.length === 0 && skippedLowVelocity.length === 0 && !deferred) {
        console.log('\n   ✅ All ULINE items are adequately stocked — nothing to reorder');
    } else if (items.length > 0) {
        console.log(`\n   📦 ${items.length} ULINE items need reordering (velocity ≥ ${MIN_DAILY_VELOCITY}/day)`);
    }

    // Show skipped one-off purchases (low velocity) for manual review
    if (skippedLowVelocity.length > 0) {
        console.log(`\n   ⏭️  Skipped ${skippedLowVelocity.length} low-velocity items (< ${MIN_DAILY_VELOCITY}/day — likely one-off purchases):`);
        for (const s of skippedLowVelocity.slice(0, 10)) {
            console.log(`      · ${s.productId} (${s.dailyRate.toFixed(2)}/day)`);
        }
        if (skippedLowVelocity.length > 10) {
            console.log(`      ... and ${skippedLowVelocity.length - 10} more`);
        }
    }

    return {
        sourceType: 'auto_reorder',
        sourcePO: null,
        items,
        totalEstimate: total,
    };
}

/**
 * Create a draft PO in Finale from an auto-reorder manifest.
 * Links the ULINE vendor and auto-detected items into a Finale PO.
 *
 * @param finale - FinaleClient instance
 * @param manifest - OrderManifest with items to include
 * @returns Updated manifest with sourcePO set to the new PO number
 */
export async function createFinaleDraftPO(finale: FinaleClient, manifest: OrderManifest): Promise<OrderManifest> {
    console.log('\n   📝 Creating draft PO in Finale...');

    // DECISION(2026-03-16): Use findVendorPartyByName instead of re-running the
    // full purchasing intelligence scan (which takes 2+ minutes). The party lookup
    // is a quick GraphQL query that finds ULINE from recent PO history.
    let vendorPartyId: string | null = null;

    try {
        vendorPartyId = await finale.findVendorPartyByName('ULINE');
    } catch {
        // Fallback path below
    }

    if (!vendorPartyId) {
        console.log('   ⚠️  Could not find ULINE vendor party ID. Skipping PO creation.');
        return manifest;
    }

    const finaleItems = manifest.items.map(item => ({
        productId: item.finaleSku,
        quantity: item.effectiveEachQuantity,
        unitPrice: item.finaleUnitPrice,
    }));

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const result = await finale.createDraftPurchaseOrder(
        vendorPartyId,
        finaleItems,
        `Auto-reorder generated ${today} by Aria ULINE order tool`,
    );

    console.log(`   ✅ Created draft PO #${result.orderId}`);
    console.log(`   🔗 ${result.finaleUrl}`);

    if (result.duplicateWarnings.length > 0) {
        console.log('   ⚠️  Duplicate warnings:');
        for (const w of result.duplicateWarnings) {
            console.log(`      ${w}`);
        }
    }

    if (result.priceAlerts.length > 0) {
        console.log('   💰 Price change alerts:');
        for (const a of result.priceAlerts) {
            console.log(`      ${a}`);
        }
    }

    const savedManifest = await gatherFromPO(finale, result.orderId);

    return {
        ...savedManifest,
        sourcePO: result.orderId,
    };
}

// ── Phase 2.5: Scrape ULINE Order Confirmation ──────────────────────────────

/**
 * After the user manually checks out on ULINE, scrape the order confirmation
 * page to capture the ULINE order number. This can then be written back to
 * the Finale PO as a reference.
 *
 * DECISION(2026-03-16): The confirmation page typically shows the order number
 * prominently. We'll navigate to Order History and grab the most recent order.
 *
 * @returns The ULINE order number if found, null otherwise
 */
async function scrapeOrderConfirmation(): Promise<{ orderNumber: string; orderDate: string } | null> {
    console.log('\n   🔍 Scraping ULINE order confirmation...');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    const session = await launchUlineSession({ headless: false });
    const { context } = session;

    const page = context.pages()[0] || await context.newPage();

    try {
        await page.goto('https://www.uline.com/MyAccount/OrderHistory', {
            waitUntil: 'load',
            timeout: 30_000,
        });

        // Wait for order history to load
        await page.waitForSelector('table', { timeout: 15_000 });
        await page.waitForTimeout(2_000);

        // Grab the most recent order from the first row
        const order = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('table tr'));
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) continue;

                const dateText = cells[0]?.textContent?.trim() || '';
                const orderLink = cells[1]?.querySelector('a');
                const orderNum = orderLink?.textContent?.trim() || cells[1]?.textContent?.trim() || '';

                if (/^\d{8,}$/.test(orderNum) && /\d{2}\/\d{2}\/\d{4}/.test(dateText)) {
                    return { orderNumber: orderNum, orderDate: dateText };
                }
            }
            return null;
        });

        if (order) {
            console.log(`   ✅ Most recent ULINE order: #${order.orderNumber} (${order.orderDate})`);
        } else {
            console.log('   ⚠️  Could not find recent order number');
        }

        return order;
    } finally {
        await context.close();
    }
}

function parseCurrency(value: string | null | undefined): number | null {
    if (!value) return null;
    const match = value.replace(/,/g, '').match(/\$?(-?\d+(?:\.\d{1,2})?)/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractUlineModel(text: string): string | null {
    const match = text.match(/\b[A-Z]{1,3}-\d{3,6}[A-Z]?\b/);
    return match ? match[0] : null;
}

async function scrapeObservedCartRows(page: Page): Promise<ObservedUlineCartRow[]> {
    const rows = await page.locator('tr, .cartRow, .itemRow, .orderRow').evaluateAll((elements) => {
        return elements.map((element) => {
            const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
            const inputs = Array.from(element.querySelectorAll('input')) as HTMLInputElement[];
            const quantityInput = inputs.find(input =>
                /qty|quantity/i.test(input.name || '')
                || /qty|quantity/i.test(input.id || ''),
            );
            return {
                text,
                quantityValue: quantityInput?.value || '',
            };
        });
    }).catch(() => []);

    const parsed = rows.flatMap((row) => {
        const ulineModel = extractUlineModel(row.text);
        if (!ulineModel) return [];

        const moneyMatches = Array.from(
            row.text.matchAll(/\$-?\d[\d,]*(?:\.\d{2})?/g),
            match => parseCurrency(match[0]),
        ).filter((value): value is number => value !== null);

        const quantityMatch = row.quantityValue
            || row.text.match(/\bQty(?:\s*[:#-]?\s*|\s+)(\d[\d,]*)\b/i)?.[1]
            || row.text.match(new RegExp(`${ulineModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d[\\d,]*)`))?.[1];

        const quantity = quantityMatch ? Number(String(quantityMatch).replace(/,/g, '')) : NaN;
        if (!Number.isFinite(quantity) || quantity <= 0) return [];

        return [{
            ulineModel,
            quantity,
            unitPrice: moneyMatches[0] ?? null,
            lineTotal: moneyMatches.length > 1 ? moneyMatches[moneyMatches.length - 1] : null,
        }];
    });

    const unique = new Map<string, ObservedUlineCartRow>();
    for (const row of parsed) {
        unique.set(row.ulineModel, row);
    }
    return Array.from(unique.values());
}

async function syncVerifiedCartPricesToDraftPO(
    finale: FinaleClient,
    orderId: string | null,
    expectedItems: OrderLineItem[],
    observedRows: ObservedUlineCartRow[],
    verification: CartVerificationResult,
): Promise<number> {
    if (!orderId) return 0;

    const updates = planDraftPOPriceUpdates(expectedItems, observedRows, verification);
    let applied = 0;

    for (const update of updates) {
        await finale.updateOrderItemPrice(orderId, update.finaleSku, update.newUnitPrice);
        applied += 1;
    }

    return applied;
}

// ── Phase 2: Place Order on ULINE ─────────────────────────────────────────────

/**
 * Place a faux order on ULINE using the "Paste Items Page" method.
 * Formats items as "ModelNumber, Quantity" lines and pastes into the textarea.
 *
 * @param items - Array of order line items with ULINE model numbers
 * @returns Summary of what was added to cart
 */
async function placeViaQuickOrderPaste(
    finale: FinaleClient,
    items: OrderLineItem[],
    opts?: { autonomous?: boolean; draftPO?: string | null },
): Promise<UlineCartFillResult> {
    const autonomous = opts?.autonomous ?? false;
    console.log('\n   🌐 Launching browser (Paste Items method)...');
    if (!autonomous) console.log('   ⚠️  Chrome must be closed for this step\n');

    const session = await launchUlineSession({ headless: false });
    const { context } = session;

    const page = context.pages()[0] || await context.newPage();

    try {
        // Navigate to Quick Order page
        await openUlinePasteItemsPage(page);
        console.log('   ✅ Paste Items Page loaded\n');

        // Format items: "ModelNumber, Quantity" per line
        const pasteLines = items.map(item => `${item.ulineModel}, ${item.quantity}`);
        const pasteText = pasteLines.join('\n');

        console.log('   📋 Pasting order manifest:');
        console.log('   ┌────────────────────────────────────────┐');
        for (const line of pasteLines) {
            console.log(`   │  ${line.padEnd(38)}│`);
        }
        console.log('   └────────────────────────────────────────┘\n');

        // Fill the textarea
        await page.fill('#txtPaste', pasteText);
        await page.waitForTimeout(500);

        // Click "Add to Cart"
        // DECISION(2026-03-16): ULINE's Paste Items Page uses a variety of button types.
        // We try multiple selectors and fallback strategies. If all fail, we leave
        // the page open for manual click rather than crashing.
        const beforeRows = await scrapeObservedUlineCartRows(page);
        let addClicked = false;

        // Strategy 1: broad CSS selector search
        const selectors = [
            '#btnAddPastedItemsToCart',
            '#btnAddToCart',
            'input[type="submit"][value*="Add"]',
            'input[type="button"][value*="Add"]',
            'button:has-text("Add to Cart")',
            'input[value*="Add to Cart"]',
            'a:has-text("Add to Cart")',
            'input[value*="Add Items"]',
            'button:has-text("Add Items")',
        ];
        for (const sel of selectors) {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible().catch(() => false)) {
                await btn.click();
                addClicked = true;
                break;
            }
        }

        // Strategy 2: Playwright role-based search
        if (!addClicked) {
            try {
                const roleBtn = page.getByRole('button', { name: /add/i }).first();
                if (await roleBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
                    await roleBtn.click();
                    addClicked = true;
                }
            } catch { /* not found */ }
        }

        let errorText = '';
        if (addClicked) {
            console.log('   🛒 Clicked "Add to Cart" — items should be in your ULINE cart now!');

            // Wait a moment for the cart to update
            await page.waitForTimeout(3_000);

            // Check if there are any error messages
            errorText = await page.$eval('.error, .errorMessage, .alert-danger', el => el.textContent?.trim() || '').catch(() => '');
            if (errorText) {
                console.log(`   ⚠️  ULINE error: ${errorText}`);
            }
        } else {
            console.log('   ⚠️  Could not find "Add to Cart" button — items are in the textarea for manual submission');
        }

        const observedRows = addClicked
            ? diffObservedUlineCartRows(beforeRows, await scrapeObservedUlineCartRows(page))
            : [];
        const verification = verifyUlineCart(items, observedRows);
        const message = formatCartVerificationMessage(verification);
        const priceUpdatesApplied = await syncVerifiedUlineCartPricesToDraftPO(
            finale,
            opts?.draftPO || null,
            items,
            observedRows,
            verification,
        );
        if (priceUpdatesApplied > 0) {
            console.log(`   💰 Synced ${priceUpdatesApplied} verified ULINE price update(s) back to Finale draft PO.`);
        }

        // Autonomous mode: close browser after a short delay and return
        if (autonomous) {
            console.log('\n   🤖 Autonomous mode — closing browser after cart fill.');
            await page.waitForTimeout(2_000);
            await session.close();
            return {
                message: addClicked ? message : 'Cart fill attempted; manual verification needed.',
                verification,
                observedRows,
                errorText,
            };
        }

        // Interactive mode: keep browser open for user review
        console.log('\n   👀 Browser left open for review. Close it manually when done.');
        console.log('   ⚠️  REMINDER: This is a FAUX ORDER. Review your cart before checkout.\n');

        // DECISION(2026-03-16): Wait indefinitely by watching for page close.
        // Previously used a 60s timeout + finally { context.close() } which
        // killed the browser when the script errored (Add to Cart button issue).
        // Now we wait for the user to close the browser themselves.
        try {
            await page.waitForEvent('close', { timeout: 600_000 }); // 10 min max
        } catch {
            // Timeout is fine — user just didn't close the tab
        }

        await session.close();

        return {
            message,
            verification,
            observedRows,
            errorText,
        };

    } catch (err) {
        if (autonomous) {
            // Autonomous mode: close and report the error — don't hang
            try { await session.close(); } catch { /* best effort */ }
            return {
                message: `⚠️ Cart fill failed: ${(err as Error).message}`,
                verification: {
                    status: 'unverified',
                    matchedModels: [],
                    missingModels: items.map(item => item.ulineModel),
                    quantityMismatches: [],
                    unexpectedModels: [],
                },
                observedRows: [],
                errorText: (err as Error).message,
            };
        }

        // Interactive mode: DON'T close browser on error
        console.log(`\n   ⚠️  Script error: ${(err as Error).message}`);
        console.log('   👀 Browser left open — you can click "Add to Cart" manually.');
        console.log('   Close the browser window when done.\n');

        try {
            await page.waitForEvent('close', { timeout: 600_000 });
        } catch { /* timeout ok */ }

        await session.close();
        return {
            message: 'Cart fill attempted; manual verification needed.',
            verification: {
                status: 'unverified',
                matchedModels: [],
                missingModels: items.map(item => item.ulineModel),
                quantityMismatches: [],
                unexpectedModels: [],
            },
            observedRows: [],
            errorText: (err as Error).message,
        };
    }
}

/**
 * Place a faux order on ULINE using the "Grid" method.
 * Fills individual Model # and Quantity fields row by row.
 * Better for small orders (<10 items).
 *
 * @param items - Array of order line items with ULINE model numbers
 * @returns Summary of what was added to cart
 */
async function placeViaQuickOrderGrid(items: OrderLineItem[]): Promise<string> {
    console.log('\n   🌐 Launching browser (Grid method)...');
    console.log('   ⚠️  Chrome must be closed for this step\n');

    const session = await launchUlineSession({ headless: false });
    const { context } = session;

    const page = context.pages()[0] || await context.newPage();

    try {
        await page.goto(QUICK_ORDER_URL, { waitUntil: 'load', timeout: 30_000 });

        // Handle login
        const landed = await Promise.race([
            page.waitForSelector('#txtItem0', { timeout: 15_000 }).then(() => 'ready' as const),
            page.waitForSelector('#txtEmail', { timeout: 15_000 }).then(() => 'login' as const),
        ]).catch(() => 'unknown' as const);

        if (landed === 'login') {
            console.log('   🔐 Login required — filling credentials...');
            await page.fill('#txtEmail', process.env.ULINE_EMAIL || '');
            await page.fill('#txtPassword', process.env.ULINE_PASSWORD || '');
            await page.click('#btnSignIn');
            await page.waitForSelector('#txtItem0', { timeout: 120_000 });
        }

        if (landed === 'unknown') {
            throw new Error('Could not detect Quick Order page or login form');
        }

        console.log('   ✅ Quick Order grid loaded\n');

        // Grid starts with 10 rows (txtItem0 through txtItem9)
        // If we need more, click "Add Rows" button
        const ROWS_PER_SET = 10;
        let currentMaxRow = ROWS_PER_SET;

        for (let i = 0; i < items.length; i++) {
            // Need more rows?
            if (i >= currentMaxRow) {
                const addRowsBtn = await page.$('text=Add Rows');
                if (addRowsBtn) {
                    await addRowsBtn.click();
                    await page.waitForTimeout(500);
                    currentMaxRow += ROWS_PER_SET;
                    console.log(`   ➕ Added more rows (now ${currentMaxRow} available)`);
                }
            }

            const item = items[i];
            const modelField = `#txtItem${i}`;
            const qtyField = `#txtItem${i}Quantity`;

            await page.fill(modelField, item.ulineModel);
            await page.fill(qtyField, String(item.quantity));

            // Tab out of quantity field to trigger description lookup
            await page.press(qtyField, 'Tab');
            await page.waitForTimeout(300);

            console.log(`   [${i + 1}/${items.length}] ${item.ulineModel} × ${item.quantity}`);
        }

        // Click "Add to Cart"
        const addButton = await page.$('#btnAddToCart, button:has-text("Add to Cart"), input[value*="Add to Cart"]');
        if (addButton) {
            await addButton.click();
            console.log('\n   🛒 Clicked "Add to Cart" — items should be in your ULINE cart now!');
            await page.waitForTimeout(3_000);
        } else {
            console.log('\n   ⚠️  Could not find "Add to Cart" button');
        }

        console.log('\n   👀 Browser left open for review. Close it when done.');
        console.log('   ⚠️  REMINDER: This is a FAUX ORDER. Review your cart before checkout.\n');
        await page.waitForTimeout(60_000);

        return `Added ${items.length} items to ULINE cart via Grid method`;

    } finally {
        await session.close();
    }
}

// ── Display Helpers ───────────────────────────────────────────────────────────

function printManifest(manifest: OrderManifest) {
    const source = manifest.sourcePO ? `PO #${manifest.sourcePO}` : 'Manual';
    console.log(`\n   📦 Order Manifest — ${source} (${manifest.sourceType})`);
    console.log('   ┌──────────────┬───────────────┬──────┬──────────┬──────────────────────────────┐');
    console.log('   │ Finale SKU   │ ULINE Model # │  Qty │ Est $/ea │ Description                  │');
    console.log('   ├──────────────┼───────────────┼──────┼──────────┼──────────────────────────────┤');

    for (const item of manifest.items) {
        const crossRef = item.finaleSku !== item.ulineModel ? ' *' : '  ';
        console.log(
            `   │ ${item.finaleSku.padEnd(12)}│ ${(item.ulineModel + crossRef).padEnd(13)}│ ${String(item.quantity).padStart(4)} │ $${item.unitPrice.toFixed(2).padStart(7)} │ ${item.description.substring(0, 28).padEnd(28)} │`
        );
    }

    console.log('   └──────────────┴───────────────┴──────┴──────────┴──────────────────────────────┘');
    console.log(`   Est. Total: $${manifest.totalEstimate.toFixed(2)}`);
    console.log(`   (* = cross-referenced SKU, Finale ≠ ULINE model #)\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function getBlockingGuardrailWarnings(items: OrderLineItem[]): string[] {
    return items.flatMap(item =>
        item.guardrailWarnings.filter(warning =>
            warning.includes('exceeds the') || warning.includes('BLOCKING GUARDRAIL'),
        ),
    );
}

function printManifestSummary(manifest: OrderManifest) {
    const source = manifest.sourcePO ? `PO #${manifest.sourcePO}` : 'Manual';
    console.log(`\n   ULINE Order Summary - ${source} (${manifest.sourceType})`);
    for (const item of manifest.items) {
        const crossRef = item.finaleSku !== item.ulineModel ? ' *' : '';
        console.log(
            `   - ${item.finaleSku} -> ${item.ulineModel}${crossRef}: ` +
            `${item.finaleEachQuantity} Finale eaches => ${item.quantity} ULINE qty @ $${item.unitPrice.toFixed(2)}`
        );
        for (const warning of item.guardrailWarnings) {
            console.log(`     ! ${warning}`);
        }
    }
    console.log(`   Est. Total: $${manifest.totalEstimate.toFixed(2)}`);
    console.log('   (* = cross-referenced SKU, Finale != ULINE model #)\n');
}

async function main() {
    const args = parseArgs();

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     ULINE Quick Order — Finale → ULINE Cart     ║');
    console.log('╚══════════════════════════════════════════════════╝');

    if (args.dryRun) console.log('   🔍 DRY RUN — will show manifest but not open browser\n');

    // Special mode: scrape order confirmation after manual checkout
    if (args.scrapeConfirmation) {
        const confirmation = await scrapeOrderConfirmation();
        if (confirmation) {
            console.log(`\n   📋 Order: #${confirmation.orderNumber} (${confirmation.orderDate})`);
            console.log('   You can now link this to your Finale PO.');
        }
        return;
    }

    const finale = new FinaleClient();

    // Phase 1: Gather items
    let manifests: OrderManifest[];

    if (args.autoReorder) {
        // Auto-detect mode: scan purchasing intelligence for ULINE items below threshold
        const manifest = await gatherAutoReorderItems(finale);
        if (manifest.items.length === 0) return;

        // Optionally create a draft PO in Finale for the auto-detected items
        if (args.createPO) {
            const updatedManifest = await createFinaleDraftPO(finale, manifest);
            manifests = [updatedManifest];
        } else {
            manifests = [manifest];
        }
    } else if (args.singlePO) {
        const manifest = await gatherFromPO(finale, args.singlePO);
        manifests = [manifest];
    } else {
        manifests = await gatherAllUlineDraftPOs(finale);
    }

    if (manifests.length === 0) {
        console.log('\n   ❌ No ULINE orders found. Options:');
        console.log('      --po <orderId>     Use a specific Finale PO');
        console.log('      --auto-reorder     Auto-detect items below reorder threshold');
        return;
    }

    // Merge all items into a single order (ULINE Quick Order is per-order, not per-PO)
    const allItems: OrderLineItem[] = [];
    for (const manifest of manifests) {
        printManifestSummary(manifest);
        allItems.push(...manifest.items);
    }

    // Deduplicate: if same ULINE model appears across multiple POs, sum quantities
    const deduped = new Map<string, OrderLineItem>();
    for (const item of allItems) {
        const existing = deduped.get(item.ulineModel);
        if (existing) {
            existing.quantity += item.quantity;
            existing.finaleEachQuantity += item.finaleEachQuantity;
            existing.effectiveEachQuantity += item.effectiveEachQuantity;
            existing.guardrailWarnings.push(...item.guardrailWarnings);
        } else {
            deduped.set(item.ulineModel, { ...item });
        }
    }
    const finalItems = Array.from(deduped.values());

    if (manifests.length > 1) {
        console.log(`\n   📊 Combined: ${finalItems.length} unique ULINE items from ${manifests.length} POs`);
        console.log(`   Total est: $${finalItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toFixed(2)}\n`);
    }

    const blockingWarnings = getBlockingGuardrailWarnings(finalItems);
    if (blockingWarnings.length > 0) {
        console.log('\n   âŒ ULINE guardrail blocked this order:');
        for (const warning of blockingWarnings) {
            console.log(`      ${warning}`);
        }
        console.log('      Reduce quantities or adjust the PO before sending to ULINE.');
        return;
    }

    console.log(`   Items to order: ${finalItems.length}`);
    console.log(`   Method: ${args.useGrid ? 'Grid (individual fields)' : 'Paste Items (bulk textarea)'}\n`);

    if (args.dryRun) {
        console.log('   ✅ Dry run complete. Run without --dry-run to place faux order.\n');

        // Show the paste-ready manifest for manual use
        console.log('   📋 Copy-paste ready for ULINE Quick Order:');
        console.log('   ─────────────────────────────────────────');
        for (const item of finalItems) {
            console.log(`   ${item.ulineModel}, ${item.quantity}`);
        }
        console.log('   ─────────────────────────────────────────');
        return;
    }

    // Phase 2: Place on ULINE
    let result: string;
    if (args.useGrid) {
        result = await placeViaQuickOrderGrid(finalItems);
    } else {
        result = (await placeViaQuickOrderPaste(finale, finalItems, { autonomous: false })).message;
    }

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     DONE — Items Added to ULINE Cart            ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║   ${result.padEnd(46)}║`);
    console.log(`║   Source POs: ${manifests.map(m => m.sourcePO).join(', ').padEnd(34)}║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║   ⚠️  REVIEW YOUR CART BEFORE CHECKOUT!          ║');
    console.log('║   This was a FAUX ORDER — nothing was submitted. ║');
    console.log('╚══════════════════════════════════════════════════╝');
}

// ── Exported Autonomous Function (for cron/ops-manager) ─────────────────────

/**
 * Result of the autonomous ULINE ordering pipeline.
 * Used by ops-manager to build the Telegram notification.
 */
export interface UlineOrderResult {
    success: boolean;
    itemCount: number;
    items: Array<{
        sku: string;
        ulineModel: string;
        qty: number;
        unitPrice: number;
        finaleEachQty: number;
        effectiveEachQty: number;
    }>;
    estimatedTotal: number;
    finalePO: string | null;
    finaleUrl: string | null;
    cartResult: string;
    cartVerificationStatus: CartVerificationResult['status'];
    priceUpdatesApplied: number;
    skippedLowVelocity: number;
    error?: string;
}

/**
 * Fully autonomous ULINE ordering pipeline — designed for Friday morning cron.
 *
 * Flow:
 *   1. Scan Finale purchasing intelligence for ULINE items below threshold
 *   2. Create a draft PO in Finale for those items
 *   3. Open Chrome → fill ULINE Quick Order cart via Paste Items
 *   4. Close Chrome and return structured result for Telegram notification
 *
 * DECISION(2026-03-16): This function is the production cron entry point.
 * It must NEVER throw — all errors are caught and returned in the result.
 * The browser portion runs in autonomous mode (closes after cart fill, no hang).
 *
 * @returns Structured result for Telegram notification
 */
export async function runAutonomousUlineOrder(): Promise<UlineOrderResult> {
    console.log('[uline-friday] Starting autonomous ULINE order pipeline...');
    const finale = new FinaleClient();

    try {
        // Phase 1: Scan purchasing intelligence for ULINE items needing reorder
        const manifest = await gatherAutoReorderItems(finale);

        if (manifest.items.length === 0) {
            console.log('[uline-friday] No items need reordering — all ULINE stock is healthy.');
            return {
                success: true,
                itemCount: 0,
                items: [],
                estimatedTotal: 0,
                finalePO: null,
                finaleUrl: null,
                cartResult: 'No items need reordering',
                cartVerificationStatus: 'verified',
                priceUpdatesApplied: 0,
                skippedLowVelocity: 0,
            };
        }

        // Phase 2: Create draft PO in Finale
        let updatedManifest = manifest;
        let finaleUrl: string | null = null;
        try {
            updatedManifest = await createFinaleDraftPO(finale, manifest);
            if (updatedManifest.sourcePO) {
                const account = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
                finaleUrl = `https://app.finaleinventory.com/${account}/purchaseOrder?orderId=${updatedManifest.sourcePO}`;
            }
        } catch (poErr: any) {
            console.error('[uline-friday] PO creation failed (proceeding with cart only):', poErr.message);
        }

        const blockingWarnings = getBlockingGuardrailWarnings(updatedManifest.items);
        if (blockingWarnings.length > 0) {
            return {
                success: false,
                itemCount: updatedManifest.items.length,
                items: updatedManifest.items.map(i => ({
                    sku: i.finaleSku,
                    ulineModel: i.ulineModel,
                    qty: i.quantity,
                    unitPrice: i.unitPrice,
                    finaleEachQty: i.finaleEachQuantity,
                    effectiveEachQty: i.effectiveEachQuantity,
                })),
                estimatedTotal: updatedManifest.totalEstimate,
                finalePO: updatedManifest.sourcePO,
                finaleUrl,
                cartResult: '',
                cartVerificationStatus: 'unverified',
                priceUpdatesApplied: 0,
                skippedLowVelocity: 0,
                error: `ULINE guardrail blocked the order: ${blockingWarnings[0]}`,
            };
        }

        // Phase 3: Fill ULINE cart via browser automation
        let cartFill: UlineCartFillResult;
        try {
            cartFill = await placeViaQuickOrderPaste(finale, updatedManifest.items, {
                autonomous: true,
                draftPO: updatedManifest.sourcePO,
            });
        } catch (cartErr: any) {
            console.error('[uline-friday] Cart fill failed:', cartErr.message);
            cartFill = {
                message: `⚠️ Cart fill failed: ${cartErr.message}`,
                verification: {
                    status: 'unverified',
                    matchedModels: [],
                    missingModels: updatedManifest.items.map(item => item.ulineModel),
                    quantityMismatches: [],
                    unexpectedModels: [],
                },
                observedRows: [],
                errorText: cartErr.message,
            };
        }

        const priceUpdatesApplied = planDraftPOPriceUpdates(
            updatedManifest.items,
            cartFill.observedRows,
            cartFill.verification,
        ).length;

        console.log(`[uline-friday] Complete: ${updatedManifest.items.length} items, PO ${updatedManifest.sourcePO || 'none'}, cart: ${cartFill.message}`);

        return {
            success: true,
            itemCount: updatedManifest.items.length,
            items: updatedManifest.items.map(i => ({
                sku: i.finaleSku,
                ulineModel: i.ulineModel,
                qty: i.quantity,
                unitPrice: i.unitPrice,
                finaleEachQty: i.finaleEachQuantity,
                effectiveEachQty: i.effectiveEachQuantity,
            })),
            estimatedTotal: updatedManifest.totalEstimate,
            finalePO: updatedManifest.sourcePO,
            finaleUrl,
            cartResult: cartFill.message,
            cartVerificationStatus: cartFill.verification.status,
            priceUpdatesApplied,
            skippedLowVelocity: 0,
        };

    } catch (err: any) {
        console.error('[uline-friday] Pipeline failed:', err.message);
        return {
            success: false,
            itemCount: 0,
            items: [],
            estimatedTotal: 0,
            finalePO: null,
            finaleUrl: null,
            cartResult: '',
            cartVerificationStatus: 'unverified',
            priceUpdatesApplied: 0,
            skippedLowVelocity: 0,
            error: err.message,
        };
    }
}

// ── CLI entry point (only runs when executed directly) ───────────────────────

// Guard: don't run main() when imported by ops-manager or other modules.
// Only fires when this file is the direct entry point (e.g., `node --import tsx src/cli/order-uline.ts`).
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('cli/order-uline.ts')
    || process.argv[1]?.replace(/\\/g, '/').endsWith('cli/order-uline.js');

if (isDirectRun) {
    main().catch(err => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}
