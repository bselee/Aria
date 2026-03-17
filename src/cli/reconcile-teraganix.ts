/**
 * @file    reconcile-teraganix.ts
 * @purpose Reconcile TeraGanix Shopify emails with Finale POs.
 * @author  Antigravity
 * @created 2026-03-16
 * @deps    gmail API, dotenv, finale/client
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { gmail as GmailApi } from '@googleapis/gmail';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { FinaleClient, PurchaseOrder } from '../lib/finale/client';
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';
const TAX_PROMO = '/buildasoilorganics/api/productpromo/10008';

const skuMapping: Record<string, { sku: string, multiplier: number }> = {
    "case of em-1 32 oz 12 bottles": { sku: "EM102", multiplier: 12 },
    "case of em-1 16 oz 12 bottles": { sku: "EM108", multiplier: 12 },
    // If there are gallons or 5 gallons
    "case of em-1 1 gallon 4 bottles": { sku: "EM-103", multiplier: 4 },
    "case of em-1 5 gallon": { sku: "EM105", multiplier: 1 }
};

interface InvoiceLineItem {
    name: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
}

interface TeraganixInvoice {
    orderNumber: string;
    date: string;
    subtotal: number;
    tax: number;
    shipping: number;
    total: number;
    items: InvoiceLineItem[];
    matchedPoId?: string;
}

// ── Parser ────────────────────────────────────────────────────────────────────

function extractInvoiceFromHTML(html: string): TeraganixInvoice | null {
    const config = {
        orderNumber: /(?:Order|Invoice)\s*#([A-Z0-9D]+)/i,
        subtotal: /<span[^>]*>Subtotal<\/span>\s*<\/p>\s*<\/td>\s*<td[^>]*>[\s\S]*?<strong[^>]*>\$([\d,.]+)<\/strong>/i,
        shipping: /<span[^>]*>Shipping<\/span>\s*<\/p>\s*<\/td>\s*<td[^>]*>[\s\S]*?<strong[^>]*>\$([\d,.]+)<\/strong>/i,
        tax: /<span[^>]*>(?:Estimated t|T)axes<\/span>\s*<\/p>\s*<\/td>\s*<td[^>]*>[\s\S]*?<strong[^>]*>\$([\d,.]+)<\/strong>/i,
        total: /<span[^>]*>(?:Total|Amount to pay)<\/span>\s*<\/p>\s*<\/td>\s*<td[^>]*>[\s\S]*?<strong[^>]*>\$([\d,.]+)(?:\sUSD)?<\/strong>/i
    };

    const orderNumber = html.match(config.orderNumber)?.[1] || '';
    if (!orderNumber) return null; // Not an invoice/order confirmation

    const subtotal = parseFloat(html.match(config.subtotal)?.[1]?.replace(/,/g, '') || '0');
    const shipping = parseFloat(html.match(config.shipping)?.[1]?.replace(/,/g, '') || '0');
    const tax = parseFloat(html.match(config.tax)?.[1]?.replace(/,/g, '') || '0');
    const totalMatch = html.match(config.total)?.[1]?.replace(/,/g, '') || '0';
    const total = parseFloat(totalMatch);

    const items: InvoiceLineItem[] = [];
    const itemBlocks = html.split('<tr class="order-list__item"');
    
    for (let i = 1; i < itemBlocks.length; i++) {
        const block = itemBlocks[i];
        const titleMatch = block.match(/<span class="order-list__item-title"[^>]*>([\s\S]*?)<\/span>/);
        const variantMatch = block.match(/<span class="order-list__item-variant"[^>]*>([\s\S]*?)<\/span>/);
        const priceMatch = block.match(/<p class="order-list__item-price"[^>]*>\s*\$([\d,.]+)/);
        
        if (titleMatch && priceMatch) {
            let nameRaw = titleMatch[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            let variant = variantMatch ? variantMatch[1].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
            
            let qty = 1;
            const qtyMatch = nameRaw.match(/×\s*(\d+)$/);
            if (qtyMatch) {
                qty = parseInt(qtyMatch[1], 10);
                nameRaw = nameRaw.replace(/×\s*\d+$/, '').trim();
            } else if (variant) {
                const qtyVariantMatch = variant.match(/×\s*(\d+)$/);
                if (qtyVariantMatch) {
                    qty = parseInt(qtyVariantMatch[1], 10);
                    variant = variant.replace(/×\s*\d+$/, '').trim();
                }
            }
            
            const fullName = variant ? `${nameRaw} [${variant}]` : nameRaw;
            const lineTotal = parseFloat(priceMatch[1].replace(/,/g, ''));
            items.push({
                name: fullName,
                qty,
                lineTotal,
                unitPrice: lineTotal / qty
            });
        }
    }

    // Only return if it actually has items or a subtotal/total
    if (items.length === 0 && subtotal === 0 && total === 0) return null;

    return {
        orderNumber,
        date: new Date().toISOString().split('T')[0], // Will be updated by email date
        subtotal,
        shipping,
        tax,
        total,
        items
    };
}

// ── Operations ────────────────────────────────────────────────────────────────

async function fetchEmails(): Promise<TeraganixInvoice[]> {
    console.log('\n📥 Fetching TeraGanix emails from Gmail...');
    const auth = await getAuthenticatedClient();
    const gmail = GmailApi({ version: 'v1', auth });

    const query = '(from:teraganix.com OR from:shopifyemail.com) (subject:"Order" AND subject:"confirmed") -"OOS" -"Alert"';
    
    const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 50 // get recent 50
    });

    const messages = response.data.messages || [];
    console.log(`Found ${messages.length} order confirmation emails.`);
    
    const invoices: TeraganixInvoice[] = [];
    
    for (const msg of messages) {
        const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'full'
        });
        
        const headers = fullMsg.data.payload?.headers || [];
        const dateHeader = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';
        const emailDate = new Date(dateHeader);
        
        // Find HTML part
        let body = '';
        if (fullMsg.data.payload?.parts) {
            for (const part of fullMsg.data.payload.parts) {
                if (part.mimeType === 'text/html' && part.body?.data) {
                    body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                } else if (part.parts) {
                    for (const nested of part.parts) {
                        if (nested.mimeType === 'text/html' && nested.body?.data) {
                            body = Buffer.from(nested.body.data, 'base64').toString('utf-8');
                        }
                    }
                }
            }
        }
        
        if (!body) continue;
        
        const invoice = extractInvoiceFromHTML(body);
        if (invoice) {
            invoice.date = emailDate.toISOString().split('T')[0];
            // Prevent duplicates
            if (!invoices.find(i => i.orderNumber === invoice.orderNumber)) {
                invoices.push(invoice);
            }
        }
    }
    return invoices;
}

// Map the extracted items to Finale
function matchInvoiceToPO(invoice: TeraganixInvoice, availablePOs: PurchaseOrder[], finale: FinaleClient): PurchaseOrder | null {
    // We match by Date Proximity + Items Match
    // An invoice Date should generally be after or equal to the PO date, within 14 days
    const invDate = new Date(invoice.date).getTime();
    
    for (const po of availablePOs) {
        const poDate = new Date(po.orderDate).getTime();
        const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);
        
        if (diffDays >= -3 && diffDays <= 21) {
            // Check items
            // Teraganix has predictable items. Let's see if the invoice matches the PO exactly or partially
            // For now, if the subtotal matches, or if we can map >= 1 items, we consider it a match
            // We'll just print out potential matches
            return po; // Naive match based on closest date for now
        }
    }
    return null;
}

async function reconcileInvoice(finale: any, get: any, post: any, invoice: TeraganixInvoice, po: PurchaseOrder, dryRun: boolean) {
    const poId = po.orderId;
    console.log(`\n================================`);
    console.log(`Reconciling PO ${poId} with Invoice #${invoice.orderNumber} (Inv Date: ${invoice.date})`);
    
    let result = { 
        priceChanges: 0, 
        freightAdded: 0, 
        status: po.statusId,
        errors: [] as string[]
    };

    try {
        const details = await finale.getOrderDetails(poId);
        
        // Uncommit if needed
        let unlocked = details;
        const origStatus = details.statusId;
        
        if (!dryRun && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
            if (details.actionUrlEdit) {
                console.log(`   [Uncommitting PO...]`);
                await post(details.actionUrlEdit, {});
                unlocked = await finale.getOrderDetails(poId);
            } else {
                throw new Error(`Cannot edit PO ${poId} because it has no actionUrlEdit`);
            }
        }

        // 1. Map items and update prices
        let mappedCount = 0;
        let invoiceMappedTotal = 0;
        
        for (const fItem of unlocked.orderItemList || []) {
            const fSku = fItem.productUrl?.split('/').pop() || '';
            const fQty = fItem.quantity;
            
            // Try to find a matching invoice item based on SKU resolution
            for (const iItem of invoice.items) {
                const variantKey = Object.keys(skuMapping).find(k => iItem.name.toLowerCase().includes(k));
                if (variantKey) {
                    const mappedSku = skuMapping[variantKey].sku;
                    const multiplier = skuMapping[variantKey].multiplier;
                    
                    if (mappedSku === fSku) {
                        // The invItem matches this fSku
                        // The unit price in Finale should be (iItem.unitPrice / multiplier)
                        const correctUnitPrice = iItem.unitPrice / multiplier;
                        let priceChanged = false;
                        if (Math.abs(fItem.unitPrice - correctUnitPrice) > 0.001) {
                            console.log(`   -> Updating ${fSku} price: $${fItem.unitPrice} => $${correctUnitPrice.toFixed(4)}`);
                            if (!dryRun) {
                                fItem.unitPrice = correctUnitPrice;
                            }
                            result.priceChanges++;
                            priceChanged = true;
                        }
                        
                        if (priceChanged && !dryRun) {
                            try {
                                const productUrl = `/buildasoilorganics/api/product/${fSku}`;
                                const prodDetails = await get(productUrl);
                                
                                // Origin URL is typically the vendor party URL in Finale POs
                                const vendorPartyUrl = unlocked.originUrl || unlocked.partyUrl; 
                                
                                let supplierUpdated = false;
                                if (prodDetails.supplierList && prodDetails.supplierList.length > 0) {
                                    for (const sup of prodDetails.supplierList) {
                                        if (vendorPartyUrl && sup.supplierPartyUrl === vendorPartyUrl) {
                                            sup.price = correctUnitPrice;
                                            supplierUpdated = true;
                                            break;
                                        }
                                    }
                                    if (!supplierUpdated) {
                                        for (const sup of prodDetails.supplierList) {
                                            if (sup.supplierPrefOrderId?.includes('MAIN')) {
                                                sup.price = correctUnitPrice;
                                                supplierUpdated = true;
                                                break;
                                            }
                                        }
                                    }
                                    if (!supplierUpdated) {
                                        prodDetails.supplierList[0].price = correctUnitPrice;
                                        supplierUpdated = true;
                                    }
                                }

                                if (supplierUpdated) {
                                    await post(productUrl, prodDetails);
                                    console.log(`       [Global supplier price updated to $${correctUnitPrice.toFixed(4)}]`);
                                }
                            } catch (e: any) {
                                console.error(`       [⚠️ Failed to update global supplier price for ${fSku}: ${e.message}]`);
                            }
                        }

                        mappedCount++;
                        invoiceMappedTotal += (iItem.qty * iItem.unitPrice); // add to mapped total for sanity check
                    }
                }
            }
        }
        
        console.log(`   Mapped ${mappedCount} items. (Subtotal on invoice: $${invoice.subtotal})`);
        
        // 2. Add Freight if applicable
        const existingAdj = unlocked.orderAdjustmentList || [];
        const existingFreight = existingAdj
            .filter((a: any) => a.productPromoUrl === FREIGHT_PROMO)
            .reduce((s: number, a: any) => s + a.amount, 0);

        if (invoice.shipping > 0 && Math.abs(existingFreight - invoice.shipping) > 0.01) {
            const label = `Freight - TeraGanix Inv ${invoice.orderNumber}`;
            const alreadyLabeled = existingAdj.some((a: any) => a.description?.includes('TeraGanix Inv'));
            if (!alreadyLabeled) {
                console.log(`   + Adding Freight: $${invoice.shipping} (${label})`);
                if (!dryRun) {
                    existingAdj.push({ amount: invoice.shipping, description: label, productPromoUrl: FREIGHT_PROMO });
                }
                result.freightAdded = invoice.shipping;
            }
        }

        // Save
        if (!dryRun && (result.priceChanges > 0 || result.freightAdded > 0)) {
             await post(`/buildasoilorganics/api/order/${encodeURIComponent(poId)}`, unlocked);
        }
        
        // Recommit
        if (!dryRun && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
            console.log(`   [Re-committing PO...]`);
            const after = await finale.getOrderDetails(poId);
            if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
            result.status = origStatus;
        }

    } catch (err: any) {
        result.errors.push(err.message);
        console.error(`   Error processing PO ${poId}:`, err);
    }

    return result;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   TeraGanix → Finale Invoice Reconciliation      ║');
    console.log('╚══════════════════════════════════════════════════╝');
    
    if (dryRun) console.log('   🔍 DRY RUN — no changes will be saved\n');

    const invoices = await fetchEmails();
    console.log(`\nExtracted ${invoices.length} valid invoices from emails.`);
    if (invoices.length === 0) return;

    // Archive each TeraGanix invoice into vendor_invoices
    console.log('\n📦 Archiving TeraGanix invoices to vendor_invoices...');
    let archived = 0;
    for (const inv of invoices) {
        try {
            await upsertVendorInvoice({
                vendor_name: 'TeraGanix',
                invoice_number: inv.orderNumber,
                invoice_date: inv.date,
                subtotal: inv.subtotal,
                freight: inv.shipping,
                tax: inv.tax,
                total: inv.total,
                status: 'received',
                source: 'email_attachment',
                source_ref: `teraganix-email-${inv.orderNumber}`,
                line_items: inv.items.map(i => ({
                    sku: Object.values(skuMapping).find(m => i.name.toLowerCase().includes(Object.keys(skuMapping).find(k => i.name.toLowerCase().includes(k)) || ''))?.sku || i.name,
                    description: i.name,
                    qty: i.qty,
                    unit_price: i.unitPrice,
                    ext_price: i.lineTotal,
                })),
                raw_data: inv as unknown as Record<string, unknown>,
            });
            archived++;
        } catch { /* dedup collision is fine */ }
    }
    console.log(`✅ Archived ${archived}/${invoices.length} TeraGanix invoices`);

    const finale = new FinaleClient();
    const get = (finale as any).get.bind(finale);
    const post = (finale as any).post.bind(finale);

    // Fetch Finale POs
    const allPOs = await finale.getRecentPurchaseOrders(180);
    const vendorPOs = allPOs.filter((po: any) => 
        (po.vendorName?.toLowerCase().includes('teraganix') || po.vendorName?.toLowerCase().includes('terraganics'))
        && !po.status?.toLowerCase().includes('cancel')
    );
    
    console.log(`Found ${vendorPOs.length} TeraGanix POs in Finale in the last 180 days:`);
    vendorPOs.forEach(po => console.log(` - PO ${po.orderId} from ${po.orderDate} (${po.vendorName})`));


    for (const invoice of invoices) {
        // Find best match 
        let bestMatch = null;
        let minDiff = 99999;
        const invDate = new Date(invoice.date).getTime();
        
        for (const po of vendorPOs) {
            const poDate = new Date(po.orderDate).getTime();
            const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);
            
            // Match PO from slightly before to 30 days later
            if (diffDays >= -7 && diffDays <= 30) { 
                
                // Do a sanity check to verify at least one SKU matches, no matter the quantity
                const details = await finale.getOrderDetails(po.orderId);
                let isMatch = false;
                
                for (const fItem of details.orderItemList || []) {
                    if (isMatch) break;
                    const fSku = fItem.productUrl?.split('/').pop() || '';
                    
                    for (const iItem of invoice.items) {
                        const variantKey = Object.keys(skuMapping).find(k => iItem.name.toLowerCase().includes(k));
                        if (variantKey && skuMapping[variantKey].sku === fSku) {
                            isMatch = true;
                            break;
                        }
                    }
                }
                
                if (isMatch) {
                    if (Math.abs(diffDays) < minDiff || (!bestMatch)) {
                        bestMatch = po;
                        minDiff = Math.abs(diffDays);
                    }
                }
            }
        }

        if (bestMatch) {
            await reconcileInvoice(finale, get, post, invoice, bestMatch, dryRun);
        } else {
            console.log(`\n❌ Could not find an exact matching PO for Invoice ${invoice.orderNumber} ($${invoice.subtotal}) from ${invoice.date}.`);
        }
    }
}

main().catch(console.error);
