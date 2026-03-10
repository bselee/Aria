import { createClient } from "@/lib/supabase";
import { InvoiceData } from "@/lib/pdf/invoice-parser";
import { POData } from "@/lib/pdf/po-parser";
import { FinaleClient } from "@/lib/finale/client";
import Fuse from "fuse.js";

export interface MatchResult {
    matched: boolean;
    confidence: "exact" | "high" | "medium" | "low" | "none";
    matchedPO: POData | null;
    matchStrategy: string;
    discrepancies: Discrepancy[];
    autoApprove: boolean;      // True if exact match with no discrepancies
}

export interface Discrepancy {
    field: string;
    invoiceValue: unknown;
    poValue: unknown;
    delta?: number;
    severity: "blocking" | "warning" | "info";
}

/**
 * Build a minimal POData stub for cases where we know the PO number but don't
 * have the full Supabase record. The reconciler will fetch live data from Finale
 * and validate — this stub just carries the orderId forward.
 */
function stubPOData(poNumber: string, vendorName: string): POData {
    return {
        documentType: "purchase_order",
        poNumber,
        vendorName: vendorName || "Unknown",
        status: "sent",
        issueDate: new Date().toISOString().split("T")[0],
        lineItems: [],
        subtotal: 0,
        total: 0,
        confidence: "medium",
    };
}

export async function matchInvoiceToPO(invoice: InvoiceData): Promise<MatchResult> {
    const supabase = createClient();

    // ── Strategy 1: Exact PO number match in Supabase ─────────────────────────
    if (invoice.poNumber) {
        const { data: exactPO } = await supabase
            .from("purchase_orders")
            .select("*")
            .eq("po_number", invoice.poNumber)
            .eq("status", "open")
            .single();

        if (exactPO) {
            const discrepancies = compareInvoiceToPO(invoice, exactPO.raw_data);
            return {
                matched: true,
                confidence: "exact",
                matchedPO: exactPO.raw_data,
                matchStrategy: "PO number exact match",
                discrepancies,
                autoApprove: discrepancies.filter(d => d.severity === "blocking").length === 0,
            };
        }

        // ── Strategy 1b: PO# on invoice but not in Supabase ──────────────────
        // Supabase is sparse (~18 rows, mostly vendor_name: null).
        // If the invoice explicitly references a PO#, trust it and pass directly
        // to the Finale reconciler which will validate the PO live.
        // autoApprove is always false — let the reconciler's guardrails decide.
        return {
            matched: true,
            confidence: "high",
            matchedPO: stubPOData(invoice.poNumber, invoice.vendorName),
            matchStrategy: "PO number on invoice — Finale live validation",
            discrepancies: [],
            autoApprove: false,
        };
    }

    // ── Strategy 2: Fuzzy vendor name + amount match in Supabase ──────────────
    // (Only useful when vendor_name is populated — currently sparse)
    const { data: vendorPOs } = await supabase
        .from("purchase_orders")
        .select("*")
        .eq("status", "open")
        .not("vendor_name", "is", null)
        .gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString()); // Last 90 days

    if (vendorPOs?.length) {
        const fuse = new Fuse(vendorPOs, { keys: ["vendor_name"], threshold: 0.3 });
        const vendorMatches: any[] = fuse.search(invoice.vendorName).map(r => r.item);

        if (vendorMatches.length) {
            const amountMatch = vendorMatches.find(
                (po: any) => Math.abs(po.total - invoice.total) / Math.max(invoice.total, 1) < 0.02
            );

            if (amountMatch) {
                const discrepancies = compareInvoiceToPO(invoice, amountMatch.raw_data);
                return {
                    matched: true,
                    confidence: "high",
                    matchedPO: amountMatch.raw_data,
                    matchStrategy: "Vendor + amount fuzzy match",
                    discrepancies,
                    autoApprove: false, // Require human confirmation for fuzzy matches
                };
            }

            // Strategy 3: SKU line item overlap
            const lineItemMatch = vendorMatches.find(po => {
                const poSkus = new Set<string>(po.raw_data?.lineItems?.map((l: { sku: string }) => l.sku).filter((s: string | undefined): s is string => !!s) || []);
                const invoiceSkus = new Set<string>(invoice.lineItems?.map(l => l.sku).filter((s): s is string => s != null) || []);
                const overlap = [...poSkus].filter(sku => invoiceSkus.has(sku)).length;
                return overlap >= 2;
            });

            if (lineItemMatch) {
                return {
                    matched: true,
                    confidence: "medium",
                    matchedPO: lineItemMatch.raw_data,
                    matchStrategy: "SKU line item overlap",
                    discrepancies: compareInvoiceToPO(invoice, lineItemMatch.raw_data),
                    autoApprove: false,
                };
            }
        }
    }

    // ── Strategy 4: Finale vendor+date fallback ────────────────────────────────
    // Used when invoice has no PO# and Supabase has no useful vendor data.
    // Queries Finale GraphQL directly — always routes to needs_approval (never auto-applies).
    // When Will approves, the vendor_name is written back to Supabase for future matches.
    if (invoice.vendorName && invoice.invoiceDate) {
        try {
            const finaleClient = new FinaleClient();
            const candidates = await finaleClient.findPOByVendorAndDate(
                invoice.vendorName,
                invoice.invoiceDate,
                30  // 30-day window around invoice date
            );

            // Filter to "Committed" or open POs within 10% of invoice total
            const plausible = candidates.filter(c =>
                (c.status === "Committed" || c.status === "Open") &&
                invoice.total > 0 &&
                Math.abs(c.total - invoice.total) / invoice.total < 0.10
            );

            if (plausible.length > 0) {
                let best = plausible[0];
                let strategyDetail = `amount-closest`;

                // H4 FIX: When multiple POs match, use word overlap scoring
                // to disambiguate. Compares invoice line item descriptions to
                // PO line items via getOrderSummary for a Jaccard score.
                if (plausible.length > 1) {
                    // Collect invoice words for overlap scoring
                    const invoiceWords = new Set<string>(
                        (invoice.lineItems ?? [])
                            .flatMap(li => (li.description || "").toLowerCase().split(/\W+/))
                            .filter(w => w.length > 2)
                    );

                    let bestScore = -1;
                    for (const candidate of plausible) {
                        try {
                            const summary = await finaleClient.getOrderSummary(candidate.orderId);
                            if (!summary?.lineItems?.length) continue;

                            const poWords = new Set<string>(
                                summary.lineItems
                                    .flatMap((li: any) => ((li.description || li.productId || "") as string).toLowerCase().split(/\W+/))
                                    .filter((w: string) => w.length > 2)
                            );

                            // Jaccard similarity: |intersection| / |union|
                            const intersection = [...invoiceWords].filter(w => poWords.has(w)).length;
                            const union = new Set([...invoiceWords, ...poWords]).size;
                            const jaccard = union > 0 ? intersection / union : 0;

                            // Combine with amount proximity (normalize to 0-1 scale)
                            const amountProximity = 1 - Math.abs(candidate.total - invoice.total) / Math.max(invoice.total, 1);
                            const combinedScore = jaccard * 0.7 + amountProximity * 0.3;

                            if (combinedScore > bestScore) {
                                bestScore = combinedScore;
                                best = candidate;
                                strategyDetail = `word-overlap (jaccard=${jaccard.toFixed(2)}, amount=${amountProximity.toFixed(2)}, combined=${combinedScore.toFixed(2)})`;
                            }
                        } catch {
                            // getOrderSummary failed for this candidate — skip word overlap, keep amount sort
                        }
                    }

                    // Fallback: if word overlap didn't help (score=0), use closest amount
                    if (bestScore <= 0) {
                        plausible.sort((a, b) =>
                            Math.abs(a.total - invoice.total) - Math.abs(b.total - invoice.total)
                        );
                        best = plausible[0];
                        strategyDetail = `amount-closest (${plausible.length} candidates)`;
                    }
                }

                return {
                    matched: true,
                    confidence: "medium",
                    matchedPO: stubPOData(best.orderId, best.supplier),
                    matchStrategy: `Finale vendor+date fallback [${strategyDetail}] (${best.supplier}, ${best.orderDate}) — REQUIRES APPROVAL`,
                    discrepancies: [],
                    autoApprove: false,
                };
            }
        } catch (err: any) {
            // Finale fallback is best-effort — don't block the pipeline
            console.warn(`[matchInvoiceToPO] Finale fallback failed: ${err.message}`);
        }
    }

    return {
        matched: false,
        confidence: "none",
        matchedPO: null,
        matchStrategy: "No PO found — Supabase and Finale both exhausted",
        discrepancies: [],
        autoApprove: false,
    };
}

function compareInvoiceToPO(invoice: InvoiceData, po: POData): Discrepancy[] {
    if (!po) return [];
    const discrepancies: Discrepancy[] = [];

    // Total amount check
    if (po.total && Math.abs(invoice.total - po.total) > 0.01) {
        const delta = invoice.total - po.total;
        discrepancies.push({
            field: "total",
            invoiceValue: invoice.total,
            poValue: po.total,
            delta,
            severity: Math.abs(delta) > po.total * 0.05 ? "blocking" : "warning",
        });
    }

    // Line item quantity checks
    for (const invLine of invoice.lineItems ?? []) {
        const poLine = po.lineItems?.find(
            pl => pl.sku === invLine.sku || pl.description.toLowerCase().includes(invLine.description.toLowerCase().slice(0, 20))
        );
        if (poLine) {
            if (invLine.qty !== poLine.qtyOrdered) {
                discrepancies.push({
                    field: `line_qty:${invLine.description.slice(0, 30)}`,
                    invoiceValue: invLine.qty,
                    poValue: poLine.qtyOrdered,
                    delta: invLine.qty - poLine.qtyOrdered,
                    severity: "warning",
                });
            }
            if (Math.abs(invLine.unitPrice - poLine.unitPrice) > 0.01) {
                discrepancies.push({
                    field: `line_price:${invLine.description.slice(0, 30)}`,
                    invoiceValue: invLine.unitPrice,
                    poValue: poLine.unitPrice,
                    delta: invLine.unitPrice - poLine.unitPrice,
                    severity: Math.abs(invLine.unitPrice - poLine.unitPrice) > poLine.unitPrice * 0.03 ? "blocking" : "warning",
                });
            }
        }
    }

    // Payment terms check
    if (invoice.paymentTerms && po.paymentTerms && invoice.paymentTerms !== po.paymentTerms) {
        discrepancies.push({
            field: "payment_terms",
            invoiceValue: invoice.paymentTerms,
            poValue: po.paymentTerms,
            severity: "info",
        });
    }

    return discrepancies;
}
