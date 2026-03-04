/**
 * @file    smart-rematch/route.ts
 * @purpose Natural language re-match endpoint. Takes a free-text query like
 *          "the March 1st order" or "the big castings order" and uses the LLM
 *          to interpret it, search Supabase POs, and return the best matches.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    supabase, @google/generative-ai
 * @env     GEMINI_API_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

export async function POST(req: Request) {
    try {
        const { query, vendor, invoiceNumber } = await req.json();

        if (!query) {
            return NextResponse.json({ error: "query parameter required" }, { status: 400 });
        }

        const supabase = createClient();
        if (!supabase) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // Step 1: Check if the query is a direct PO number
        const directPoMatch = query.match(/\b(\d{5,7})\b/);
        if (directPoMatch) {
            const poNumber = directPoMatch[1];
            const { data: directPo } = await supabase
                .from("purchase_orders")
                .select("po_number, vendor_name, issue_date, total_amount, status")
                .eq("po_number", poNumber)
                .single();

            if (directPo) {
                return NextResponse.json({
                    matches: [buildCandidate(directPo)],
                    interpretation: `Direct PO number match: ${poNumber}`,
                });
            }
        }

        // Step 2: Fetch all recent POs for the vendor from Supabase
        let poQuery = supabase
            .from("purchase_orders")
            .select("po_number, vendor_name, issue_date, total_amount, status")
            .order("issue_date", { ascending: false })
            .limit(30);

        if (vendor) {
            poQuery = poQuery.ilike("vendor_name", `%${vendor}%`);
        }

        const { data: allPOs } = await poQuery;

        if (!allPOs || allPOs.length === 0) {
            return NextResponse.json({
                matches: [],
                interpretation: `No POs found${vendor ? ` for vendor "${vendor}"` : ""}.`,
            });
        }

        // Step 3: Use the LLM to interpret the query and rank POs
        const poSummary = allPOs.map((po: any) => {
            const date = po.issue_date ? new Date(po.issue_date).toLocaleDateString("en-US", {
                month: "long", day: "numeric", year: "numeric"
            }) : "no date";
            return `PO ${po.po_number} | ${po.vendor_name} | ${date} | $${po.total_amount?.toLocaleString() || "?"} | ${po.status || "open"}`;
        }).join("\n");

        const { unifiedTextGeneration } = await import("@/lib/intelligence/llm");

        const text = await unifiedTextGeneration({
            system: "You are a purchasing assistant. You match natural language queries to purchase order numbers. Return ONLY a JSON array of PO numbers ranked by relevance. If no match, return [].",
            prompt: `User query: "${query}"
${vendor ? `Vendor context: ${vendor}` : ""}
${invoiceNumber ? `Invoice being matched: ${invoiceNumber}` : ""}

Available POs:
${poSummary}

Consider: date references ("March order" = March date), amount references ("the big order" = highest amount), product references, and direct number references.

Return ONLY valid JSON like: ["124302", "124364"]`,
            temperature: 0.1,
        });


        // Parse the LLM response
        let matchedPoNumbers: string[] = [];
        try {
            const jsonMatch = text.match(/\[[\s\S]*?\]/);
            if (jsonMatch) {
                matchedPoNumbers = JSON.parse(jsonMatch[0]);
            }
        } catch {
            // Fallback: extract any PO numbers from the response
            const nums = text.match(/\d{5,7}/g);
            if (nums) matchedPoNumbers = nums;
        }

        // Build candidate objects for the matched POs
        const matches = matchedPoNumbers
            .map(poNum => allPOs.find((po: any) => String(po.po_number) === String(poNum)))
            .filter(Boolean)
            .map(buildCandidate);

        return NextResponse.json({
            matches,
            interpretation: `Aria understood: "${query}" → ${matches.length} candidate(s) found`,
        });

    } catch (err: any) {
        console.error("Smart rematch error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

function buildCandidate(po: any) {
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";
    const orderApiPath = `/${accountPath}/api/order/${po.po_number}`;
    const encoded = Buffer.from(orderApiPath).toString("base64");
    return {
        orderId: String(po.po_number),
        vendor: po.vendor_name,
        orderDate: po.issue_date,
        total: po.total_amount,
        status: po.status,
        finaleUrl: `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encoded}`,
    };
}
