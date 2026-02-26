/**
 * @file    statement-parser.ts
 * @purpose Handles parsing and reconciliation of vendor account statements.
 * @deps    supabase, llm-service
 */

import { z } from "zod";
import { createClient } from "@/lib/supabase";
import { unifiedObjectGeneration } from "../intelligence/llm";

export const StatementLineSchema = z.object({
    date: z.string(),
    referenceNumber: z.string(),         // Invoice # or payment ref
    documentType: z.enum(["invoice", "payment", "credit", "adjustment", "debit_memo"]),
    description: z.string().optional(),
    charges: z.number().optional(),
    credits: z.number().optional(),
    balance: z.number(),
});

export const VendorStatementSchema = z.object({
    vendorName: z.string(),
    accountNumber: z.string().optional(),
    statementDate: z.string(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    openingBalance: z.number(),
    totalCharges: z.number(),
    totalCredits: z.number(),
    endingBalance: z.number(),
    currentDue: z.number().optional(),    // 0-30 days
    overdue30: z.number().optional(),    // 31-60 days
    overdue60: z.number().optional(),    // 61-90 days
    overdue90: z.number().optional(),    // 90+ days
    lines: z.array(StatementLineSchema),
    confidence: z.enum(["high", "medium", "low"]),
});

export type StatementData = z.infer<typeof VendorStatementSchema>;

export async function parseVendorStatement(rawText: string): Promise<StatementData> {
    return await unifiedObjectGeneration({
        system: `Parse this vendor account statement. Extract every transaction line — invoices, payments, credits, adjustments.`,
        prompt: rawText.slice(0, 8000),
        schema: VendorStatementSchema,
        schemaName: "VendorStatement"
    });
}

/**
 * Reconciles a parsed statement against our local records in Supabase.
 * Identifies missing invoices, payment discrepancies, and balance offsets.
 */
export async function reconcileStatement(statement: StatementData) {
    const supabase = createClient();

    const reconciliationLines = await Promise.all(
        statement.lines.map(async (line) => {
            if (line.documentType === "invoice") {
                // Find matching invoice in our DB
                const { data: ourInvoice } = await supabase
                    .from("invoices")
                    .select("*")
                    .eq("invoice_number", line.referenceNumber)
                    .single();

                if (!ourInvoice) {
                    return { ...line, status: "MISSING_IN_OUR_RECORDS", ourAmount: null };
                }

                const amountMatch = Math.abs((ourInvoice.total ?? 0) - (line.charges ?? 0)) < 0.01;
                return {
                    ...line,
                    status: amountMatch ? "MATCHED" : "AMOUNT_DISCREPANCY",
                    ourAmount: ourInvoice.total,
                    ourStatus: ourInvoice.status,
                    discrepancy: amountMatch ? 0 : (line.charges ?? 0) - (ourInvoice.total ?? 0),
                };
            }

            if (line.documentType === "payment") {
                // Check if we have a record of this payment
                const { data: payment } = await supabase
                    .from("payments")
                    .select("*")
                    .eq("reference_number", line.referenceNumber)
                    .single();

                return {
                    ...line,
                    status: payment ? "MATCHED" : "PAYMENT_NOT_RECORDED",
                    ourRecord: payment,
                };
            }

            return { ...line, status: "UNREVIEWED" };
        })
    );

    const discrepancies = reconciliationLines.filter(
        l => l.status !== "MATCHED"
    );

    // Save reconciliation result
    await supabase.from("statement_reconciliations").insert({
        vendor_name: statement.vendorName,
        statement_date: statement.statementDate,
        vendor_balance: statement.endingBalance,
        our_balance: reconciliationLines
            .filter(l => l.status === "MATCHED")
            .reduce((sum, l) => sum + (l.balance || 0), 0),
        discrepancy_count: discrepancies.length,
        lines: reconciliationLines,
        status: discrepancies.length === 0 ? "RECONCILED" : "DISCREPANCIES",
    });

    return {
        reconciliationLines,
        discrepancies,
        totalDiscrepancyAmount: discrepancies.reduce((sum, d) => sum + Math.abs((d as any).discrepancy ?? 0), 0)
    };
}
