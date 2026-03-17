/**
 * @file    correlate-pos.ts
 * @purpose General PO correlation pass for unified vendor invoices.
 *          Finds matching Finale POs for received invoices and allows updating freight/pricing.
 * @author  Antigravity
 * @created 2026-03-17
 * @deps    supabase, finale/client
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createClient } from '../lib/supabase';
import { FinaleClient, PurchaseOrder } from '../lib/finale/client';

const supabase = createClient();
const finale = new FinaleClient();
const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';

async function main() {
    const args = process.argv.slice(2);
    const applyChanges = args.includes('--apply');
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   Unified PO Correlation Pass                    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    
    if (!applyChanges) {
        console.log('   🔍 DRY RUN — use --apply to update Finale and mark reconciled\n');
    }

    console.log(`Fetching up to ${limit} most recent "received" vendor invoices...`);

    const { data: invoices, error } = await supabase
        .from('vendor_invoices')
        .select('*')
        .eq('status', 'received')
        .order('invoice_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('Error fetching invoices:', error.message);
        return;
    }

    if (!invoices || invoices.length === 0) {
        console.log('No "received" invoices found.');
        return;
    }

    console.log(`Found ${invoices.length} invoices to process.\n`);

    // Fetch recent POs for correlation
    console.log(`Fetching recent Finale POs for correlation...`);
    const recentPOs = await finale.getRecentPurchaseOrders(180);
    console.log(`Loaded ${recentPOs.length} recent POs.\n`);

    const get = (finale as any).get.bind(finale);
    const post = (finale as any).post.bind(finale);

    for (const invoice of invoices) {
        console.log(`================================`);
        console.log(`Invoice: ${invoice.vendor_name} #${invoice.invoice_number || 'N/A'}`);
        console.log(`Date: ${invoice.invoice_date || 'Unknown'}, Total: $${invoice.total}, Freight: $${invoice.freight}`);
        
        // Skip vendors we know are non-inventory
        if (invoice.vendor_name.toLowerCase().includes('toyota') || 
            invoice.vendor_name.toLowerCase().includes('insurance')) {
            console.log(`   ⏭️  Skipping known non-inventory vendor.`);
            continue;
        }

        let bestMatch: PurchaseOrder | null = null;
        let poIdStr = '';

        if (invoice.po_number && invoice.po_number.trim() !== '') {
            console.log(`   → Has explicit PO number: ${invoice.po_number}`);
            poIdStr = invoice.po_number;
            // Check if PO exists in our recent list, else try fetching details directly
            bestMatch = recentPOs.find(p => p.orderId === invoice.po_number) || null;
            if (!bestMatch) {
                // We could try fetching directly if not in recent 180 days, but usually they are
                console.log(`   ⚠️  PO ${invoice.po_number} not found in recent POs. Proceeding to fetch details...`);
            }
        } else if (invoice.invoice_date) {
            console.log(`   → No explicit PO. Correlating by vendor and date...`);
            const invDate = new Date(invoice.invoice_date).getTime();
            let minDiff = 99999;

            for (const po of recentPOs) {
                if (!po.vendorName) continue;
                // Fuzzy vendor match
                // We use standard includes/starts-with, lowercased
                const v1 = po.vendorName.toLowerCase();
                const v2 = invoice.vendor_name.toLowerCase();
                
                // Very basic name overlap
                const nameOverlap = v1.includes(v2) || v2.includes(v1) || 
                                    (v1.split(' ').some(word => word.length >= 4 && v2.includes(word)));

                if (nameOverlap) {
                    const poDate = new Date(po.orderDate).getTime();
                    const diffDays = (invDate - poDate) / (1000 * 60 * 60 * 24);
                    
                    // Invoice date usually >= PO date, but allow small buffer
                    if (diffDays >= -7 && diffDays <= 30) {
                        if (Math.abs(diffDays) < minDiff) {
                            bestMatch = po;
                            poIdStr = po.orderId;
                            minDiff = Math.abs(diffDays);
                        }
                    }
                }
            }

            if (bestMatch) {
                console.log(`   ✨ Correlated with PO ${bestMatch.orderId} from ${bestMatch.orderDate} (${Math.round(minDiff)} days diff, Vendor: ${bestMatch.vendorName})`);
            } else {
                console.log(`   ❌ Could not find a suitable PO for correlation.`);
            }
        }

        if (poIdStr || bestMatch) {
            const finalPoId = poIdStr || (bestMatch ? bestMatch.orderId : null);
            if (!finalPoId) continue;

            try {
                const details = await finale.getOrderDetails(finalPoId);
                
                // Print freight difference
                const existingAdj = details.orderAdjustmentList || [];
                const existingFreight = existingAdj
                    .filter((a: any) => a.productPromoUrl === FREIGHT_PROMO)
                    .reduce((s: number, a: any) => s + a.amount, 0);

                const isFreightVendor = ['wwex', 'worldwide', 'destination', 'fedex', 'ups', 'xpo', 'tforce', 't-force', 'estes', 'saia', 'r+l', 'yrc', 'old dominion', 'dhl']
                    .some(fv => invoice.vendor_name.toLowerCase().includes(fv));

                // If it's a dedicated freight vendor, their entire invoice total is the freight cost
                const invFreight = isFreightVendor ? (Number(invoice.total) || 0) : (Number(invoice.freight) || 0);

                let freightToAdd = 0;

                if (invFreight > 0 && Math.abs(existingFreight - invFreight) > 0.01) {
                    console.log(`   📦 Freight to add: $${invFreight} (current in Finale: $${existingFreight})`);
                    freightToAdd = invFreight;
                } else if (invFreight > 0) {
                    console.log(`   📦 Freight matches Finale: $${invFreight}`);
                }

                if (applyChanges) {
                    // 1. Update PO number on invoice if it was missing
                    if (!invoice.po_number || invoice.po_number !== finalPoId) {
                        await supabase
                            .from('vendor_invoices')
                            .update({ po_number: finalPoId })
                            .eq('id', invoice.id);
                        console.log(`   [Supabase] Linked to PO: ${finalPoId}`);
                    }

                    let needsPoCommit = false;
                    let unlocked = details;
                    const origStatus = details.statusId;

                    if (freightToAdd > 0) {
                        if (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED') {
                            if (details.actionUrlEdit) {
                                console.log(`   [Finale] Uncommitting PO to add freight...`);
                                await post(details.actionUrlEdit, {});
                                unlocked = await finale.getOrderDetails(finalPoId);
                            }
                        }

                        const label = `Freight - Inv ${invoice.invoice_number || invoice.id.split('-')[0]}`;
                        if (!unlocked.orderAdjustmentList) unlocked.orderAdjustmentList = [];
                        unlocked.orderAdjustmentList.push({ amount: freightToAdd, description: label, productPromoUrl: FREIGHT_PROMO });
                        
                        await post(`/buildasoilorganics/api/order/${encodeURIComponent(finalPoId)}`, unlocked);
                        console.log(`   [Finale] Freight added: $${freightToAdd}`);
                        needsPoCommit = true;
                    }

                    if (needsPoCommit && (origStatus === 'ORDER_LOCKED' || origStatus === 'ORDER_COMPLETED')) {
                        console.log(`   [Finale] Re-committing PO...`);
                        const after = await finale.getOrderDetails(finalPoId);
                        if (after.actionUrlComplete) await post(after.actionUrlComplete, {});
                    }

                    // Mark as reconciled
                    await supabase
                        .from('vendor_invoices')
                        .update({ 
                            status: 'reconciled', 
                            reconciled_at: new Date().toISOString() 
                        })
                        .eq('id', invoice.id);
                    console.log(`   [Supabase] Marked invoice as reconciled.`);
                }
            } catch (err: any) {
                console.error(`   ⚠️ Error correlating/updating: ${err.message}`);
            }
        }
    }

    console.log('\n✅ PO Correlation Pass completed.');
}

main().catch(console.error);
