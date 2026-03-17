/**
 * @file    invoice-lookup.ts
 * @purpose CLI tool to search and display vendor invoices from the unified archive.
 *          Quick reference for "What did we pay vendor X?" without opening Supabase.
 * @author  Will / Antigravity
 * @created 2026-03-17
 * @updated 2026-03-17
 * @deps    dotenv, supabase/client, storage/vendor-invoices
 *
 * Usage:
 *   node --import tsx src/cli/invoice-lookup.ts --vendor ULINE
 *   node --import tsx src/cli/invoice-lookup.ts --vendor ULINE --year 2025
 *   node --import tsx src/cli/invoice-lookup.ts --vendor FedEx --month 2
 *   node --import tsx src/cli/invoice-lookup.ts --unpaid
 *   node --import tsx src/cli/invoice-lookup.ts --po 124426
 *   node --import tsx src/cli/invoice-lookup.ts --summary              # Spend by vendor
 *   node --import tsx src/cli/invoice-lookup.ts --summary --year 2025
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
    lookupVendorInvoices,
    vendorSpendSummary,
    type InvoiceLookupFilters,
    type InvoiceStatus,
} from "../lib/storage/vendor-invoices";

// ── CLI Arg Parsing ───────────────────────────────────────────────────────────

function parseArgs(): InvoiceLookupFilters & { summary: boolean } {
    const args = process.argv.slice(2);

    const getFlag = (name: string): string | undefined => {
        const idx = args.indexOf(`--${name}`);
        if (idx === -1) return undefined;
        return args[idx + 1];
    };

    return {
        vendor: getFlag("vendor"),
        year: getFlag("year") ? parseInt(getFlag("year")!) : undefined,
        month: getFlag("month") ? parseInt(getFlag("month")!) : undefined,
        status: getFlag("status") as InvoiceStatus | undefined,
        po: getFlag("po"),
        unpaid: args.includes("--unpaid"),
        summary: args.includes("--summary"),
        limit: getFlag("limit") ? parseInt(getFlag("limit")!) : 100,
    };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatCurrency(n: number | null | undefined): string {
    if (n == null) return "-";
    return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null | undefined): string {
    if (!d) return "-";
    return d.slice(0, 10);
}

function padRight(s: string, len: number): string {
    return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
    return s.length >= len ? s.slice(0, len) : " ".repeat(len - s.length) + s;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs();

    if (args.summary) {
        // ── Spend summary mode ────────────────────────────────────────────
        const sinceDate = args.year
            ? `${args.year}-01-01`
            : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

        const label = args.year ? `Year ${args.year}` : "Last 12 Months";

        console.log("");
        console.log("╔══════════════════════════════════════════════════════════════════╗");
        console.log(`║   Vendor Spend Summary — ${padRight(label, 38)}║`);
        console.log("╠══════════════════════════════════════════════════════════════════╣");
        console.log(
            `║ ${padRight("Vendor", 25)} ${padLeft("Invoices", 8)} ${padLeft("Total", 14)} ${padLeft("Freight", 12)} ║`
        );
        console.log("╠══════════════════════════════════════════════════════════════════╣");

        const summary = await vendorSpendSummary(sinceDate);

        let grandTotal = 0;
        let grandFreight = 0;
        let grandCount = 0;

        for (const row of summary) {
            const vendor = (row as any).vendor ?? (row as any).vendor_name ?? "?";
            const count = (row as any).count ?? (row as any).invoice_count ?? 0;
            const total = Number((row as any).total ?? (row as any).total_spend ?? 0);
            const freight = Number((row as any).freight ?? (row as any).total_freight ?? 0);

            grandTotal += total;
            grandFreight += freight;
            grandCount += count;

            console.log(
                `║ ${padRight(vendor, 25)} ${padLeft(String(count), 8)} ${padLeft(formatCurrency(total), 14)} ${padLeft(formatCurrency(freight), 12)} ║`
            );
        }

        console.log("╠══════════════════════════════════════════════════════════════════╣");
        console.log(
            `║ ${padRight("TOTAL", 25)} ${padLeft(String(grandCount), 8)} ${padLeft(formatCurrency(grandTotal), 14)} ${padLeft(formatCurrency(grandFreight), 12)} ║`
        );
        console.log("╚══════════════════════════════════════════════════════════════════╝");
        console.log("");
        return;
    }

    // ── Detail mode ───────────────────────────────────────────────────────
    const filters: InvoiceLookupFilters = {
        vendor: args.vendor,
        year: args.year,
        month: args.month,
        status: args.status,
        po: args.po,
        unpaid: args.unpaid,
        limit: args.limit,
    };

    // Build a description of what we're searching for
    const parts: string[] = [];
    if (args.vendor) parts.push(`vendor="${args.vendor}"`);
    if (args.year) parts.push(`year=${args.year}`);
    if (args.month) parts.push(`month=${args.month}`);
    if (args.status) parts.push(`status=${args.status}`);
    if (args.po) parts.push(`PO=${args.po}`);
    if (args.unpaid) parts.push("unpaid only");
    const desc = parts.length > 0 ? parts.join(", ") : "all invoices";

    console.log("");
    console.log(`🔍 Searching vendor invoices: ${desc}`);
    console.log("");

    const invoices = await lookupVendorInvoices(filters);

    if (invoices.length === 0) {
        console.log("   No invoices found matching your criteria.\n");
        return;
    }

    // Table header
    console.log(
        `${padRight("Date", 12)} ${padRight("Vendor", 22)} ${padRight("Invoice #", 16)} ${padRight("PO", 8)} ${padLeft("Total", 12)} ${padLeft("Freight", 10)} ${padRight("Status", 12)} ${padRight("Source", 18)}`
    );
    console.log("─".repeat(112));

    let runningTotal = 0;
    let runningFreight = 0;

    for (const inv of invoices) {
        const total = Number(inv.total) || 0;
        const freight = Number(inv.freight) || 0;
        runningTotal += total;
        runningFreight += freight;

        console.log(
            `${padRight(formatDate(inv.invoice_date), 12)} ${padRight((inv.vendor_name || "?").slice(0, 21), 22)} ${padRight((inv.invoice_number || "-").slice(0, 15), 16)} ${padRight((inv.po_number || "-").slice(0, 7), 8)} ${padLeft(formatCurrency(total), 12)} ${padLeft(formatCurrency(freight), 10)} ${padRight(inv.status || "-", 12)} ${padRight(inv.source || "-", 18)}`
        );
    }

    console.log("─".repeat(112));
    console.log(
        `${padRight("", 12)} ${padRight("", 22)} ${padRight(`${invoices.length} invoices`, 16)} ${padRight("", 8)} ${padLeft(formatCurrency(runningTotal), 12)} ${padLeft(formatCurrency(runningFreight), 10)}`
    );
    console.log("");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
