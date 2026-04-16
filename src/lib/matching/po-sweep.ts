/**
 * @file    po-sweep.ts
 * @purpose Runs a PO-first sweep: fetches recently received or committed POs from 
 *          Finale, looks for matching invoices in vendor_invoices, and runs 
 *          the reconciliation engine on any new matches.
 */

import { createClient } from "../supabase";
import { FinaleClient } from "../finale/client";
import { reconcileInvoiceToPO, applyReconciliation, buildReconciliationIdentityMetadata } from "../finale/reconciler";
import Fuse from "fuse.js";

export async function runPOSweep(daysBack: number = 60, dryRun: boolean = false) {
    const supabase = createClient();
    const finale = new FinaleClient();

    console.log(`🔍 [po-sweep] Scanning Finale for POs from the last ${daysBack} days...`);

    try {
        const recentPOs = await finale.getRecentPurchaseOrders(daysBack, 1000);
        
        // Filter to Committed or fully Received
        const actionablePOs = recentPOs.filter(po => 
            po.status === "Committed" || po.status === "Received"
        );
        
        console.log(`   Found ${actionablePOs.length} Committed/Received POs in the window.`);

        // Fetch all recent invoices that aren't matched yet or are matched to something else
        const { data: recentInvoices, error: invErr } = await supabase
            .from("vendor_invoices")
            .select("*")
            .gte("invoice_date", new Date(Date.now() - (daysBack + 30) * 86400000).toISOString())
            .order("invoice_date", { ascending: false });

        if (invErr) {
            console.error("❌ Failed to fetch recent invoices from vendor_invoices:", invErr.message);
            return;
        }

        console.log(`   Loaded ${recentInvoices?.length || 0} recent invoices for matching.`);

        let processedCount = 0;
        let matchedCount = 0;

        for (const po of actionablePOs) {
            // Check if this PO already has a reconciliation entry
            const { data: existingLog } = await supabase
                .from("ap_activity_log")
                .select("id")
                .eq("metadata->>orderId", po.orderId)
                .in("intent", ["RECONCILIATION"])
                .limit(1)
                .single();

            if (existingLog) {
                // Already done
                continue;
            }

            processedCount++;
            
            // Try to find a matching invoice
            let match = recentInvoices?.find(inv => inv.po_number === po.orderId);
            let matchType = "exact-po";

            // If no exact PO match, try fuzzy matching vendor + amount + date proximity
            if (!match && recentInvoices) {
                // 1. Filter by vendor via alias or fuzzy
                const poSupplierLower = po.supplier?.toLowerCase() || "";
                if (!poSupplierLower) continue;

                const possibleInvoices = recentInvoices.filter(inv => {
                    if (!inv.vendor_name) return false;
                    const invVendorLower = inv.vendor_name.toLowerCase();
                    if (invVendorLower.includes(poSupplierLower) || poSupplierLower.includes(invVendorLower)) return true;
                    return false; // Very basic check - Fuse.js is better
                });

                if (possibleInvoices.length > 0) {
                    // Try to find within 5% of PO amount and invoice date within ± 30 days
                    const poDate = new Date(po.orderDate);
                    match = possibleInvoices.find(inv => {
                        const amtDiff = Math.abs(inv.total - po.total) / Math.max(po.total, 1);
                        if (amtDiff > 0.05) return false;
                        
                        if (inv.invoice_date) {
                            const invDate = new Date(inv.invoice_date);
                            const daysDiff = Math.abs(poDate.getTime() - invDate.getTime()) / 86400000;
                            if (daysDiff > 30) return false;
                        }
                        return true;
                    });
                    if (match) matchType = "fuzzy-amount-date";
                }

                // Better fuzzy match with Fuse
                if (!match) {
                    const fuse = new Fuse(recentInvoices, { 
                        keys: ["vendor_name"], 
                        threshold: 0.3 
                    });
                    const results = fuse.search(po.supplier);
                    for (const result of results) {
                        const inv = result.item;
                        const amtDiff = Math.abs((inv.total || 0) - po.total) / Math.max(po.total, 1);
                        if (amtDiff < 0.05) {
                            match = inv;
                            matchType = "fuse-vendor-amount";
                            break;
                        }
                    }
                }
            }

            if (match) {
                matchedCount++;
                console.log(`   ✅ PO ${po.orderId} matches Invoice #${match.invoice_number} from ${match.vendor_name} [${matchType}]`);
                
                if (!dryRun) {
                    try {
                        const invoiceData = match.raw_data || {
                            vendorName: match.vendor_name,
                            invoiceNumber: match.invoice_number,
                            invoiceDate: match.invoice_date,
                            dueDate: match.due_date,
                            total: match.total,
                            amountDue: match.total,
                            subtotal: match.subtotal,
                            freight: match.freight,
                            tax: match.tax,
                            poNumber: match.po_number || po.orderId,
                            lineItems: match.line_items,
                            confidence: "high"
                        };

                        const result = await reconcileInvoiceToPO(invoiceData as any, po.orderId, finale, 
                            matchType === "exact-po" ? "PO-first exact match" : "PO-first fuzzy match"
                        );

                        // Output summary
                        console.log(`     ↳ Verdict: ${result.overallVerdict} | Impact: $${result.totalDollarImpact.toFixed(2)}`);

                        if (result.overallVerdict === "auto_approve") {
                            const applyResult = await applyReconciliation(result, finale);
                            console.log(`     ↳ Applied ${applyResult.applied.length} change(s) to Finale`);
                            const identity = buildReconciliationIdentityMetadata({
                                invoiceNumber: match.invoice_number,
                                vendorName: match.vendor_name,
                                orderId: po.orderId,
                            });
                            
                            // Log it so we don't repeat
                            await supabase.from("ap_activity_log").insert({
                                email_from: match.vendor_name,
                                email_subject: `PO-Sweep: Invoice ${match.invoice_number} → PO ${po.orderId}`,
                                intent: "RECONCILIATION",
                                action_taken: `Auto-applied: ${applyResult.applied.length} changes`,
                                metadata: identity,
                            });
                        } else if (result.overallVerdict === "needs_approval") {
                            console.log(`     ↳ Flagged for human review. Telegram approval not automatically sent from this sweep yet, please review PO manually.`);
                            const identity = buildReconciliationIdentityMetadata({
                                invoiceNumber: match.invoice_number,
                                vendorName: match.vendor_name,
                                orderId: po.orderId,
                            });
                            await supabase.from("ap_activity_log").insert({
                                email_from: match.vendor_name,
                                email_subject: `PO-Sweep: Invoice ${match.invoice_number} → PO ${po.orderId}`,
                                intent: "RECONCILIATION",
                                action_taken: `Flagged for review: ${result.overallVerdict}`,
                                metadata: identity,
                            });
                        }
                    } catch (err: any) {
                        console.error(`     ❌ Reconciliation failed:`, err.message);
                    }
                }
            }
        }

        console.log(`\n✅ Sweep complete.`);
        console.log(`   Processed POs (no prior recon log): ${processedCount}`);
        console.log(`   Newly matched invoices: ${matchedCount}`);
        
        if (dryRun) console.log(`   (Dry run — no database changes made)`);

    } catch (e: any) {
        console.error("❌ Fatal sweep error:", e);
    }
}
