/**
 * @file    client.ts
 * @purpose Axiom Print API client for fetching invoice data and creating
 *          draft POs in Finale. Uses headless Playwright for auth (no Chrome
 *          profile needed), then hits the Axiom REST API directly.
 *
 *          Triggered by InlineInvoiceHandler when a paid Axiom invoice
 *          email is detected in the default inbox.
 *
 * @author  Will
 * @created 2026-03-23
 * @updated 2026-03-23
 * @deps    playwright, finale/client, storage/vendor-invoices
 * @env     AXIOM_EMAIL, AXIOM_PASSWORD
 *
 * DECISION(2026-03-23): Extracted from reconcile-axiom.ts CLI tool.
 * Uses headless browser for auth (runs autonomously while Chrome is open),
 * then calls newapi.axiomprint.com REST API for structured order data.
 * SKU mapping reused from the CLI tool's AXIOM_TO_FINALE map.
 */

import { chromium } from 'playwright';
import { FinaleClient } from '../finale/client';
import { upsertVendorInvoice } from '../storage/vendor-invoices';

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = 'https://newapi.axiomprint.com/v1';
const CUSTOMER_ID = 32511;
const ORDER_HISTORY_URL = 'https://axiomprint.com/account/order-history';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AxiomEstimate {
    estimateId: number;
    invoiceId: number;
    jobName: string;
    productId: number;
    productType: string;
    price: number;
    quantity: number;
    size: string;
    material: string;
    turnaround: string;
    createdDate: string;
    projectName: string;
    eCode: string;
}

export interface AxiomInvoice {
    invoiceNumber: string;
    estimates: AxiomEstimate[];
    subtotal: number;
    shipping: number;
    tax: number;
    total: number;
    orderDate: string;
    status: string;
    trackingNumber?: string;
    carrier?: string;
}

// ── SKU Mapping (shared with reconcile-axiom.ts CLI) ──────────────────────────

interface SkuMapping {
    skus: string[];
    qtyFraction: number;
    description?: string;
}

const AXIOM_TO_FINALE: Record<string, SkuMapping> = {
    // GnarBar Labels (front+back pairs)
    'GNS11_12':          { skus: ['GNS11', 'GNS21'], qtyFraction: 0.5, description: 'GnarBar-Whole 2lb F+B' },
    'GNAR BAR 2lbs':     { skus: ['GNS11', 'GNS21'], qtyFraction: 0.5, description: 'GnarBar-Whole 2lb F+B' },
    'GNAR BAR 6 lbs':    { skus: ['GNS12', 'GNS22'], qtyFraction: 0.5, description: 'GnarBar-Whole 6lb F+B' },
    'GnarBar062lbs':     { skus: ['GNS16', 'GNS06'], qtyFraction: 0.5, description: 'GnarBar-Milled 2lb F+B' },
    'GnarBar07Milled':   { skus: ['GNS17', 'GNS07'], qtyFraction: 0.5, description: 'GnarBar-Milled 6lb F+B' },

    // Organics Alive Labels
    'OAG104FRBK':        { skus: ['OAG104LABELFR', 'OAG104LABELBK'], qtyFraction: 0.5, description: 'FCB Castor Bean 1gal F+B' },
    'OAG207FRBK':        { skus: ['OAG207LABELFR', 'OAG207LABELBK'], qtyFraction: 0.5, description: 'V-N 10-2-2 Veg 25lb F+B' },
    'OAG211FRBK':        { skus: ['OAG211LABELFR', 'OAG211LABELBK'], qtyFraction: 0.5, description: 'V-TR 4-5-5 Trans 25lb F+B' },

    // VCal Labels
    'VCal OA Gallon Labels': { skus: ['OAG110LABELFR', 'OAG110LABELBK'], qtyFraction: 0.5, description: 'VCal 1gal F+B' },
    'VCal OA Pint Label':    { skus: ['OAG109LABELFR', 'OAG109LABELBK'], qtyFraction: 0.5, description: 'VCal 1pint F+B' },

    // Single Labels (1:1)
    'BBL101':            { skus: ['BBL101'], qtyFraction: 1.0, description: 'BuildASoil Big Label' },
    'BBL101 124469':     { skus: ['BBL101'], qtyFraction: 1.0, description: 'BuildASoil Big Label (reorder)' },
    'BABL101':           { skus: ['BABL101'], qtyFraction: 1.0, description: 'BuildASoil Big-ish Label' },
    'DOM101':            { skus: ['DOM101'], qtyFraction: 1.0, description: 'Domain product label' },
    'GBB08':             { skus: ['GBB08'], qtyFraction: 1.0, description: 'Gnar Bud Butter v8' },
    'GBB07':             { skus: ['GBB07'], qtyFraction: 1.0, description: 'Gnar Bud Butter v7' },
    'BAF00LABEL':        { skus: ['BAF00LABEL'], qtyFraction: 1.0, description: 'BAF00 product label' },
    'BAF1G':             { skus: ['BAF1G'], qtyFraction: 1.0, description: 'BAF 1gal label' },
    'KGD104':            { skus: ['KGD104'], qtyFraction: 1.0, description: 'KGD product label' },
    'GA105':             { skus: ['GA105'], qtyFraction: 1.0, description: 'GA product label' },
    'PU105L':            { skus: ['PU105L'], qtyFraction: 1.0, description: 'PU product label' },
    'AG111':             { skus: ['AG111'], qtyFraction: 1.0, description: 'AG product label' },
    'FCB1G':             { skus: ['FCB1G'], qtyFraction: 1.0, description: 'FCB 1gal label' },
    'CWP DRINK SOME':    { skus: ['CWP DRINK SOME'], qtyFraction: 1.0, description: 'CWP sticker' },
};

function toFinaleIds(axiomJobName: string): SkuMapping | null {
    if (AXIOM_TO_FINALE[axiomJobName]) return AXIOM_TO_FINALE[axiomJobName];

    const lower = axiomJobName.toLowerCase().trim();
    for (const [key, val] of Object.entries(AXIOM_TO_FINALE)) {
        if (key.toLowerCase() === lower) return val;
    }
    for (const [key, val] of Object.entries(AXIOM_TO_FINALE)) {
        if (lower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lower)) {
            return val;
        }
    }
    return null;
}

// ── Authentication ────────────────────────────────────────────────────────────

/**
 * Log into axiomprint.com using a headless browser, return authenticated
 * context for API calls. Does NOT use the Chrome profile — can run while
 * Chrome is open.
 */
async function getAuthenticatedContext() {
    const email = process.env.AXIOM_EMAIL;
    const password = process.env.AXIOM_PASSWORD;
    if (!email || !password) {
        throw new Error('AXIOM_EMAIL and AXIOM_PASSWORD must be set in .env.local');
    }

    console.log('[axiom] Launching headless browser for auth...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForTimeout(3_000);

        // Check if already authenticated (unlikely in headless, but possible with stored state)
        const hasOrders = await page.evaluate(() => {
            return document.body.innerText.includes('INVOICE:') || document.body.innerText.includes('INV');
        });

        if (!hasOrders) {
            // Click Sign in
            try {
                const signInLink = page.locator('text=Sign in').first();
                await signInLink.click({ timeout: 5_000 });
                await page.waitForTimeout(2_000);
            } catch {
                // Sign in link might not exist — form may already be visible
            }

            // Fill login form using React-compatible nativeInputValueSetter
            await page.evaluate(({ email, password }: { email: string; password: string }) => {
                const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
                const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
                if (!emailInput || !passwordInput) throw new Error('Login inputs not found');

                const nativeSet = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                )?.set;

                nativeSet?.call(emailInput, email);
                emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                emailInput.dispatchEvent(new Event('change', { bubbles: true }));

                nativeSet?.call(passwordInput, password);
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
                passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
            }, { email, password });

            await page.waitForTimeout(1_000);
            const submitBtn = page.locator('button:has-text("Sign in")').first();
            await submitBtn.click({ timeout: 5_000 });
            await page.waitForTimeout(5_000);

            // Verify login
            await page.goto(ORDER_HISTORY_URL, { waitUntil: 'load', timeout: 30_000 });
            await page.waitForTimeout(3_000);
            const loginOk = await page.evaluate(() =>
                document.body.innerText.includes('INVOICE:') || document.body.innerText.includes('INV')
            );
            if (!loginOk) {
                throw new Error('Axiom login failed — orders not visible after auth');
            }
        }

        console.log('[axiom] ✅ Authenticated');

        // Get order history page text for shipping enrichment
        const orderHistoryText = await page.evaluate(() => document.body.innerText);

        return { context, browser, page, orderHistoryText };
    } catch (err) {
        await browser.close();
        throw err;
    }
}

// ── API Fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch the most recent invoice from the Axiom API.
 * Only fetches page 1 (most recent 10 orders) since we just need today's invoice.
 */
async function fetchLatestInvoices(context: any, limit: number = 10): Promise<AxiomInvoice[]> {
    console.log('[axiom] Fetching recent orders via API...');

    const url = `${API_BASE}/project?expand=prjestimate,estimateStage,estimateHandle,estimatePrepressOptions&projectclientid=${CUSTOMER_ID}&visibleForClient=true&page=0&page_size=${limit}&sortEstID=`;

    const resp = await context.request.get(url, {
        headers: { 'Accept': 'application/json' },
    });

    if (!resp.ok()) {
        throw new Error(`Axiom API error: ${resp.status()} ${resp.statusText()}`);
    }

    // any: raw API response from Axiom — deeply nested, untyped
    const json = await resp.json() as any;
    const projects = json.data || [];

    const allEstimates: AxiomEstimate[] = [];

    for (const project of projects as any[]) {
        for (const est of (project.prjestimate || []) as any[]) {
            let size = '', material = '', turnaround = '', totalQty = 0;

            for (const opt of (est.estimateoptions || []) as any[]) {
                if (opt.estimate_option_name === 'Size') size = opt.selected || '';
                else if (opt.estimate_option_name === 'Material') material = opt.selected || '';
                else if (opt.estimate_option_name === 'Turnaround') turnaround = opt.selected || '';
                else if (opt.estimate_option_name === 'Quantity') {
                    const qStr = opt.estimate_option_custom_value || opt.selected || '0';
                    totalQty = parseInt(String(qStr).replace(/,/g, ''), 10) || 0;
                }
            }

            allEstimates.push({
                estimateId: est.id,
                invoiceId: est.estimate_invoiceid,
                jobName: est.estimate_name || '',
                productId: est.estimate_productid,
                productType: est.productname?.title || '',
                price: parseFloat(est.estimate_price) || 0,
                quantity: totalQty,
                size, material, turnaround,
                createdDate: est.created || project.created_at || '',
                projectName: project.projectname || '',
                eCode: `E${est.id}`,
            });
        }
    }

    // Group by invoice
    const byInvoice: Record<number, AxiomEstimate[]> = {};
    for (const est of allEstimates) {
        if (!est.invoiceId) continue;
        if (!byInvoice[est.invoiceId]) byInvoice[est.invoiceId] = [];
        byInvoice[est.invoiceId].push(est);
    }

    const invoices: AxiomInvoice[] = [];
    for (const [invId, estimates] of Object.entries(byInvoice)) {
        const subtotal = estimates.reduce((s, e) => s + e.price, 0);
        invoices.push({
            invoiceNumber: `INV${invId}`,
            estimates,
            subtotal,
            shipping: 0,
            tax: 0,
            total: subtotal,
            orderDate: estimates[0]?.createdDate || '',
            status: 'PAID',
        });
    }

    invoices.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
    console.log(`[axiom] Found ${invoices.length} invoices (latest: ${invoices[0]?.invoiceNumber})`);
    return invoices;
}

/**
 * Enrich invoices with shipping totals from the order history page text.
 * shipping = card_total - api_subtotal
 */
function enrichWithShippingFromText(invoices: AxiomInvoice[], pageText: string): void {
    const invoicePattern = /INVOICE:\s*(INV\d+)\s*\n\s*\nTOTAL:\s*\$([\d,.]+)\s*\n\s*\n(PAID|UNPAID|PARTIALLY PAID)/g;
    let match: RegExpExecArray | null;

    while ((match = invoicePattern.exec(pageText)) !== null) {
        const invNum = match[1];
        const cardTotal = parseFloat(match[2].replace(/,/g, ''));
        const inv = invoices.find(i => i.invoiceNumber === invNum);
        if (inv) {
            inv.shipping = Math.max(0, Math.round((cardTotal - inv.subtotal) * 100) / 100);
            inv.total = cardTotal;
            inv.status = match[3];
        }
    }

    // Extract tracking numbers
    const trackingPattern = /Shipping\s*\n\s*\n((?:1Z[A-Z0-9]+|\d{12,22}|9\d{15,30}))\s*\n\s*\n([A-Za-z\s]+?)(?:\n|Buildasoil)/g;
    const invPosPattern = /INVOICE:\s*(INV\d+)/g;

    const trackings: Array<{ tracking: string; carrier: string; position: number }> = [];
    let tm: RegExpExecArray | null;
    while ((tm = trackingPattern.exec(pageText)) !== null) {
        trackings.push({ tracking: tm[1].trim(), carrier: tm[2].trim(), position: tm.index });
    }

    const invPositions: Array<{ invNum: string; position: number }> = [];
    let ip: RegExpExecArray | null;
    while ((ip = invPosPattern.exec(pageText)) !== null) {
        invPositions.push({ invNum: ip[1], position: ip.index });
    }

    for (const inv of invoices) {
        const pos = invPositions.find(p => p.invNum === inv.invoiceNumber);
        if (!pos) continue;
        const nextPos = invPositions.find(p => p.position > pos.position);
        const endPos = nextPos ? nextPos.position : pageText.length;
        const t = trackings.find(t => t.position > pos.position && t.position < endPos);
        if (t) {
            inv.trackingNumber = t.tracking;
            inv.carrier = t.carrier;
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AxiomPOResult {
    success: boolean;
    orderId?: string;
    finaleUrl?: string;
    invoiceNumber?: string;
    total?: number;
    freight?: number;
    lineItems?: Array<{ sku: string; qty: number; unitPrice: number }>;
    error?: string;
    logs: string[];
}

/**
 * Fetch the latest Axiom invoice via their API and create a draft PO in Finale.
 * This is the main entry point called by InlineInvoiceHandler when an Axiom
 * paid invoice email is detected.
 *
 * @returns Result with draft PO details, or error info
 */
export async function createDraftPOFromLatestInvoice(): Promise<AxiomPOResult> {
    const logs: string[] = [];
    let browser: any = null;

    try {
        // 1. Authenticate and fetch
        const auth = await getAuthenticatedContext();
        browser = auth.browser;

        const invoices = await fetchLatestInvoices(auth.context);
        if (invoices.length === 0) {
            await browser.close();
            return { success: false, error: 'No invoices found on Axiom', logs };
        }

        // Enrich with shipping data from order history page
        enrichWithShippingFromText(invoices, auth.orderHistoryText);

        await browser.close();
        browser = null;

        // 2. Take the most recent invoice
        const invoice = invoices[0];
        logs.push(`Latest: ${invoice.invoiceNumber} — $${invoice.total.toFixed(2)} (${invoice.estimates.length} items, $${invoice.shipping.toFixed(2)} freight)`);

        // 3. Check dedup — already have a PO for this invoice?
        const { createClient } = await import('../supabase');
        const supabase = createClient();
        try {
            const { data: existing } = await supabase
                .from('vendor_invoices')
                .select('id, po_number')
                .eq('vendor_name', 'Axiom Print')
                .eq('invoice_number', invoice.invoiceNumber)
                .maybeSingle();

            if (existing?.po_number) {
                logs.push(`⚠️ DEDUP: PO #${existing.po_number} already exists for ${invoice.invoiceNumber}. Skipping.`);
                return {
                    success: true,
                    orderId: existing.po_number,
                    invoiceNumber: invoice.invoiceNumber,
                    total: invoice.total,
                    logs,
                };
            }
        } catch { /* table may not exist */ }

        // 4. Map SKUs and build line items
        const items: Array<{ productId: string; quantity: number; unitPrice: number }> = [];
        const lineItemSummary: Array<{ sku: string; qty: number; unitPrice: number }> = [];

        for (const est of invoice.estimates) {
            if (est.price <= 0) continue;
            const mapping = toFinaleIds(est.jobName);
            if (!mapping) {
                logs.push(`⚠️ Unmapped SKU: "${est.jobName}" (${est.eCode}) — add to AXIOM_TO_FINALE`);
                continue;
            }

            const perLabelPrice = est.quantity > 0 ? est.price / est.quantity : est.price;

            for (const sku of mapping.skus) {
                const qty = Math.round(est.quantity * mapping.qtyFraction);
                items.push({ productId: sku, quantity: qty, unitPrice: perLabelPrice });
                lineItemSummary.push({ sku, qty, unitPrice: perLabelPrice });
                logs.push(`  ${sku}: qty ${qty} × $${perLabelPrice.toFixed(4)}`);
            }
        }

        if (items.length === 0) {
            return { success: false, error: 'No mappable SKUs in latest invoice', logs };
        }

        // 5. Create draft PO
        const finale = new FinaleClient();
        let vendorPartyId = await finale.findVendorPartyByName('Axiom Print');
        if (!vendorPartyId) vendorPartyId = await finale.findVendorPartyByName('Axiom');
        if (!vendorPartyId) {
            return { success: false, error: 'Axiom Print vendor not found in Finale', logs };
        }

        // DECISION(2026-03-23): No memo/privateNotes on POs — creates noise in Finale records.
        const result = await finale.createDraftPurchaseOrder(vendorPartyId, items);
        logs.push(`✅ Created draft PO #${result.orderId}`);

        // 6. Add freight
        if (invoice.shipping > 0) {
            try {
                await finale.addOrderAdjustment(
                    result.orderId,
                    'FREIGHT',
                    invoice.shipping,
                    `Freight - Axiom Print ${invoice.invoiceNumber}`
                );
                logs.push(`+ Freight: $${invoice.shipping.toFixed(2)}`);
            } catch (e: any) {
                logs.push(`⚠️ Freight failed: ${e.message}`);
            }
        }

        // 7. Archive to vendor_invoices
        try {
            await upsertVendorInvoice({
                vendor_name: 'Axiom Print',
                invoice_number: invoice.invoiceNumber,
                invoice_date: invoice.orderDate?.substring(0, 10) ?? null,
                po_number: result.orderId,
                subtotal: invoice.subtotal,
                freight: invoice.shipping,
                tax: invoice.tax,
                total: invoice.total,
                status: 'received',
                source: 'axiom_api',
                source_ref: `axiom-auto-${new Date().toISOString().split('T')[0]}`,
                line_items: lineItemSummary.map(i => ({
                    sku: i.sku,
                    description: i.sku,
                    qty: i.qty,
                    unit_price: i.unitPrice,
                    ext_price: i.qty * i.unitPrice,
                })),
                raw_data: invoice as unknown as Record<string, unknown>,
            });
        } catch { /* dedup collision or non-critical */ }

        return {
            success: true,
            orderId: result.orderId,
            finaleUrl: result.finaleUrl,
            invoiceNumber: invoice.invoiceNumber,
            total: invoice.total,
            freight: invoice.shipping,
            lineItems: lineItemSummary,
            logs,
        };

    } catch (err: any) {
        if (browser) await browser.close().catch(() => {});
        return { success: false, error: err.message, logs };
    }
}
