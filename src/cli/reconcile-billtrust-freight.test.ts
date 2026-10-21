/**
 * @file    reconcile-billtrust-freight.test.ts
 * @purpose Phase 5.2 golden pins for the Billtrust CSV parser and the COLLECT
 *          inbound dedup — the shared-source half of reconcile-freight.
 *          Imports the CLI's exported pure functions directly (the CLI has an
 *          entrypoint guard, so importing it never runs main()).
 *
 *          These pins capture CURRENT behavior before the Phase 5.2
 *          extraction into src/lib/freight/apply.ts — if the merge changes
 *          any of them, that is a deliberate, reviewed decision, not drift.
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    vitest, fs/os (fixture CSV in a temp dir), ./reconcile-billtrust-freight
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseBilltrustCsv, dedupInboundInvoices } from "./reconcile-billtrust-freight";

const HEADER = "TEMPLATE_TYPE,INVOICE_NUMBER,INVOICE_DATE,SHIP_DATE,TERMS,AMT_DUE,BILL_LADING,PO_NUMBER,REF_NUM,SHIP_FROM_ADDRESS,SHIPPING_ADDRESS,DOC_TYPE";

function row(over: Record<string, string>): string {
    const base: Record<string, string> = {
        TEMPLATE_TYPE: "INVHDR",
        INVOICE_NUMBER: "",
        INVOICE_DATE: "2026-10-01",
        SHIP_DATE: "2026-09-28",
        TERMS: "COLLECT",
        AMT_DUE: "100.00",
        BILL_LADING: "BOL123",
        PO_NUMBER: "125000",
        REF_NUM: "",
        SHIP_FROM_ADDRESS: "Rootwise Soil Dynamics, Some Town",
        SHIPPING_ADDRESS: "BuildASoil, Montrose CO",
        DOC_TYPE: "INVOICE",
    };
    const merged = { ...base, ...over };
    // Real CSV exports escape embedded quotes as "" inside a quoted field.
    return Object.values(merged).map((v) => `"${v.replace(/"/g, '""')}"`).join(",");
}

function writeFixture(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "billtrust-golden-"));
    const file = join(dir, "FEDEX_123_test.csv");
    writeFileSync(file, [HEADER, ...lines].join("\r\n"), "utf-8");
    return file;
}

describe("parseBilltrustCsv", () => {
    it("parses INVHDR rows and skips detail lines", () => {
        const file = writeFixture([
            row({ INVOICE_NUMBER: "INV-1" }),
            row({ TEMPLATE_TYPE: "DETAIL", INVOICE_NUMBER: "INV-1" }), // detail line
            row({ INVOICE_NUMBER: "INV-2" }),
        ]);
        const rows = parseBilltrustCsv(file);
        expect(rows).toHaveLength(2);
        expect(rows[0].INVOICE_NUMBER).toBe("INV-1");
        expect(rows[1].INVOICE_NUMBER).toBe("INV-2");
        rmSync(join(file, ".."), { recursive: true, force: true });
    });

    it("handles quoted commas, escaped quotes and CRLF line endings", () => {
        const file = writeFixture([
            row({ SHIP_FROM_ADDRESS: 'Rootwise Soil Dynamics, 123 "Main St", Suite 2' }),
        ]);
        const rows = parseBilltrustCsv(file);
        expect(rows[0].SHIP_FROM_ADDRESS).toContain('123 "Main St"');
        expect(rows[0].SHIP_FROM_ADDRESS).toContain("Suite 2");
        rmSync(join(file, ".."), { recursive: true, force: true });
    });
});

describe("dedupInboundInvoices (golden pins — current behavior pre-5.2 extraction)", () => {
    it("keeps only COLLECT invoices shipped to BuildASoil", () => {
        const file = writeFixture([
            row({ INVOICE_NUMBER: "KEEP-1" }),
            row({ INVOICE_NUMBER: "PREPAID-1", TERMS: "PREPAID" }),
            row({ INVOICE_NUMBER: "OTHER-DEST", SHIPPING_ADDRESS: "Somebody Else, Somewhere" }),
        ]);
        const invoices = dedupInboundInvoices(parseBilltrustCsv(file));
        expect(invoices.map((i) => i.invoiceNumber)).toEqual(["KEEP-1"]);
        rmSync(join(file, ".."), { recursive: true, force: true });
    });

    it("dedups by invoice number (multi-row exports)", () => {
        const file = writeFixture([
            row({ INVOICE_NUMBER: "INV-9" }),
            row({ INVOICE_NUMBER: "INV-9", AMT_DUE: "999.00" }), // duplicate — first wins
        ]);
        const invoices = dedupInboundInvoices(parseBilltrustCsv(file));
        expect(invoices).toHaveLength(1);
        expect(invoices[0].amountDue).toBe(100); // FIRST row captured, not the $999 dup
        rmSync(join(file, ".."), { recursive: true, force: true });
    });

    it("parses comma-formatted amounts and maps vendor from the ship-from address", () => {
        const file = writeFixture([
            row({ INVOICE_NUMBER: "V-1", AMT_DUE: "1,397.94" }),
            row({ INVOICE_NUMBER: "V-2", SHIP_FROM_ADDRESS: "Malibu Compost c/o Redi-Gro, CA" }),
            row({ INVOICE_NUMBER: "V-3", SHIP_FROM_ADDRESS: "Gro Kashi - Alan Adkinson" }),
            row({ INVOICE_NUMBER: "V-4", SHIP_FROM_ADDRESS: "Unknown Shipper LLC" }),
        ]);
        const invoices = dedupInboundInvoices(parseBilltrustCsv(file));
        const byInv = new Map(invoices.map((i) => [i.invoiceNumber, i]));
        expect(byInv.get("V-1")!.amountDue).toBe(1397.94);
        expect(byInv.get("V-2")!.vendorName).toBe("Malibu Compost");
        expect(byInv.get("V-3")!.vendorName).toBe("Grokashi");
        expect(byInv.get("V-4")!.vendorName).toBeNull();
        expect(byInv.get("V-4")!.vendorMatchedBy).toBeNull();
        rmSync(join(file, ".."), { recursive: true, force: true });
    });

    it("sorts newest invoice date first", () => {
        const file = writeFixture([
            row({ INVOICE_NUMBER: "OLD", INVOICE_DATE: "2026-08-01" }),
            row({ INVOICE_NUMBER: "NEW", INVOICE_DATE: "2026-10-15" }),
        ]);
        const invoices = dedupInboundInvoices(parseBilltrustCsv(file));
        expect(invoices[0].invoiceNumber).toBe("NEW");
        rmSync(join(file, ".."), { recursive: true, force: true });
    });
});
