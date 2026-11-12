/**
 * @file    invoice-field-normalize.test.ts
 * @purpose Tests for invoice field sanitization + OCR regex fallbacks
 */
import { describe, it, expect } from "vitest";
import {
    cleanInvoiceField,
    extractInvoiceFieldsFromOcrText,
    normalizeInvoiceForDb,
} from "./invoice-field-normalize";
import { sanitizeOcrPoCandidate } from "../purchasing/ocr-po-sanitize";

const DTE_OCR = `DOWN TO EARTH WORMS, LLC.
GARY L. & LUANN AMBRIOLE
Invoice
DATE
INVOICE #
4/24/2026
1682
BILL TO:
Build A Soil
P.O. NUMBER
#124661
Net 30
QUANTITY
ITEM CODE
21 Bulk
Ton bulk castings
375.00
7,875.00
Total
$7,875.00
`;

describe("cleanInvoiceField", () => {
    it("nulls UNKNOWN sentinels", () => {
        expect(cleanInvoiceField("UNKNOWN")).toBeNull();
        expect(cleanInvoiceField("unknown")).toBeNull();
        expect(cleanInvoiceField("n/a")).toBeNull();
        expect(cleanInvoiceField("1682")).toBe("1682");
    });

    it("nulls parse-failure sentinels so fallbacks get their chance (2026-10-28)", () => {
        expect(cleanInvoiceField("error")).toBeNull();
        expect(cleanInvoiceField("ERROR")).toBeNull();
        expect(cleanInvoiceField("failed")).toBeNull();
        expect(cleanInvoiceField("parse error")).toBeNull();
    });
});

describe("extractInvoiceFieldsFromOcrText", () => {
    // Real OCR text from ap@ forwards row 1141 (Evergreen invoice 151185).
    // The PO is printed as a bare 8-digit sales-order base in a combined
    // "Approval CodeP.O. NO." header block. The 6-digit-only pattern matched
    // nothing, so vendor/PO came back null on 125 dropship forwards.
    const EVERGREEN_DROPSHIP_OCR = `Invoice
Date
10/27/2026
Invoice #
151185
Bill To:
BuildASoil LLC
5016 N Townsend Ave
Montrose, CO 81401
Ship To:
Tyler Cooper
2267 SPLIT ROCK DR
COLORADO SPGS, CO 80919-3077 USA
Evergreen Growers Supply, LLC.
Approval CodeP.O. NO.
23580437
Terms
Net 30
Due Date
11/26/2026
Shipping-FedExS/H - FedEx Tracking #5204849091041ea56.7756.77
InsulationInsulation for hot or cold weather1ea7.007.00
Total
$152.77`;

    it("extracts a bare 8-digit dropship PO base (Evergreen 151185)", () => {
        const f = extractInvoiceFieldsFromOcrText(EVERGREEN_DROPSHIP_OCR);
        expect(f.poNumber).toBe("23580437");
        expect(f.invoiceNumber).toBe("151185");
        expect(f.total).toBe(152.77);
        expect(f.invoiceDate).toBe("2026-10-27");
    });

    it("still prefers a standard 6-digit PO over an 8-digit base", () => {
        const both = `P.O. NUMBER\n125257\nSales Order\n23580437\nTotal\n$10.00`;
        expect(extractInvoiceFieldsFromOcrText(both).poNumber).toBe("125257");
    });

    it("does not truncate a longer digit run into a fake PO", () => {
        // 9-digit run must not yield the first 8 as a PO.
        const long = `P.O. NO.\n235804371\nTotal\n$10.00`;
        expect(extractInvoiceFieldsFromOcrText(long).poNumber).toBeNull();
    });

    it("extracts freight from the real Evergreen 151185 layout", () => {
        const f = extractInvoiceFieldsFromOcrText(EVERGREEN_DROPSHIP_OCR);
        expect(f.freight).toBe(56.77);
    });

    it("takes freight, not the insulation amount, when OCR glues them on one line", () => {
        // aria-purchasing: last-plausible would return 7.00 (insulation).
        const glued = [
            "P.O. NO.",
            "23580437",
            "Shipping-FedExS/H - FedEx Tracking #5204849091041ea56.7756.77Insulation1ea7.007.00",
            "Total",
            "$152.77",
        ].join("\n");
        expect(extractInvoiceFieldsFromOcrText(glued).freight).toBe(56.77);
    });

    it("refuses freight when the tracking number bleeds into the amount", () => {
        // "…9104156.777.00" — 56.77 is not recoverable, so null beats a guess.
        const bleed = [
            "P.O. NO.",
            "23580437",
            "Shipping-FedExS/H - FedEx Tracking #520484909104156.777.00",
            "Total",
            "$152.77",
        ].join("\n");
        expect(extractInvoiceFieldsFromOcrText(bleed).freight).toBeNull();
    });

    it("wires OCR freight into normalizeInvoiceForDb and derives subtotal", () => {
        const n = normalizeInvoiceForDb(null, EVERGREEN_DROPSHIP_OCR, {});
        expect(n.freight).toBe(56.77);
        expect(n.total).toBe(152.77);
        // 152.77 - 56.77 freight - 0 tax = 96.00 (goods 89.00 + 7.00 insulation)
        expect(n.subtotal).toBe(96);
    });

    // AutoPot/QuickBooks (pdf-parse) layout, verified from
    // tmp_bol/1a18c9b656bfba17_…APUS248353….pdf. Two things are unique here:
    // the shipping label is glued straight to the amount ("SHIPPING32.00"), and
    // the PO is a STANDALONE unlabeled 8-digit line (AutoPot prints the sales
    // order there, not "P.O. NO."). Both were previously missed.
    const AUTOPOT_248353_OCR = [
        "APUS-248353",
        "DATE 10/30/2026",
        "DUE DATE11/14/2026",
        "SHIP DATETRACKING NO.",
        "10/30/20261Z22YV580358863869",
        "ACTIVITYQTYRATEAMOUNT",
        "APWS010",
        "FLEXITANK - 25 Gallon FlexiTank",
        "148.0048.00",
        "23581947",
        "Ways to pay",
        "SUBTOTAL156.03",
        "TAX0.00",
        "SHIPPING32.00",
        "TOTAL188.03",
        "BALANCE DUE",
        "$188.03",
    ].join("\n");

    it("reads a glued SHIPPING32.00 label, not just 'SHIPPING 32.00'", () => {
        const f = extractInvoiceFieldsFromOcrText(AUTOPOT_248353_OCR);
        expect(f.freight).toBe(32);
    });

    it("reads the standalone unlabeled 8-digit AutoPot sales order as the PO", () => {
        const f = extractInvoiceFieldsFromOcrText(AUTOPOT_248353_OCR);
        expect(f.poNumber).toBe("23581947");
    });

    it("reconciles AutoPot goods to the PO total and keeps freight separate", () => {
        const n = normalizeInvoiceForDb(null, AUTOPOT_248353_OCR, {});
        expect(n.poNumber).toBe("23581947");
        expect(n.subtotal).toBe(156.03);
        expect(n.freight).toBe(32);
        expect(n.total).toBe(188.03);
        // goods == PO total to the cent; freight is the only delta
        expect(156.03 + 32).toBeCloseTo(188.03, 2);
    });

    it("does not treat an unrelated standalone 8-digit number as a PO", () => {
        // 8-digit run embedded in a longer line must not match.
        const noPo = ["ITEM 12345678 units", "SHIPPING5.00", "TOTAL10.00"].join("\n");
        expect(extractInvoiceFieldsFromOcrText(noPo).poNumber).toBeNull();
    });

    // Real two-PO fixture: Grassroots invoice 34658, from
    // tmp_bol/1a18dead968d88f8_….pdf. One invoice, two POs, both printed on a
    // single line glued after the tracking number, and the invoice number uses a
    // bare "INVOICE 34658" label with no NO/NUM/# token. Money reconciles both
    // ways: goods 1059.25 + freight 46.00 = 1105.25, and 942.25 + 163.00 = 1105.25.
    const GRASSROOTS_34658_OCR = [
        "Grassroots Fabric Pots Inc.",
        "614 Springlake Dr",
        "INVOICE 34658",
        "DATE 09/30/2026    TERMS Net 30",
        "DUE DATE 10/30/2026",
        "SHIP DATESHIP VIATRACKING NO.P.O. NUMBER",
        "09/30/2026UPS1ZH4D1120321913678125332, 125341",
        "DESCRIPTIONQTYRATEAMOUNT",
        '3x3 Living Soil Beds: 33"W x 33"L x 18"H Tan (No fittings)2536.49912.25T',
        'Living Soil Pot 5g (12"d x 9"h)502.94147.00T',
        "SUBTOTAL1,059.25",
        "TAX0.00",
        "SHIPPING46.00",
        "TOTAL1,105.25",
        "TOTAL DUE",
        "$1,105.25",
    ].join("\n");

    it("reads a bare 'INVOICE 34658' label with no NO/NUM/# token", () => {
        expect(extractInvoiceFieldsFromOcrText(GRASSROOTS_34658_OCR).invoiceNumber).toBe("34658");
    });

    it("captures BOTH POs from a glued comma-separated printed list", () => {
        const f = extractInvoiceFieldsFromOcrText(GRASSROOTS_34658_OCR);
        expect(f.poNumbers).toEqual(["125332", "125341"]);
        // poNumber stays null: one field cannot honestly represent a two-PO
        // document, and picking either would be a partial truth.
        expect(f.poNumber).toBeNull();
    });

    it("keeps a single-PO document's poNumbers to exactly that one PO", () => {
        const f = extractInvoiceFieldsFromOcrText(EVERGREEN_DROPSHIP_OCR);
        expect(f.poNumbers).toEqual(["23580437"]);
    });

    it("reconciles the Grassroots two-PO split against PO totals", () => {
        const n = normalizeInvoiceForDb(null, GRASSROOTS_34658_OCR, {});
        expect(n.subtotal).toBe(1059.25);
        expect(n.freight).toBe(46);
        expect(n.total).toBe(1105.25);
        // PO totals: 125332 = 912.25 goods + 30 freight; 125341 = 147 goods + 16 freight
        expect(912.25 + 30 + 147 + 16).toBeCloseTo(1105.25, 2);
    });

    it("pulls inv# PO total date from DTE photo OCR", () => {
        const f = extractInvoiceFieldsFromOcrText(DTE_OCR);
        expect(f.invoiceNumber).toBe("1682");
        expect(f.poNumber).toMatch(/124661/);
        expect(f.total).toBe(7875);
        expect(f.invoiceDate).toBe("2026-04-24");
        expect(f.vendorHint).toBe("Down to Earth Worms");
    });

    it("reads the Miles 'Invoice ID' label with thousands comma (2026-10-28)", () => {
        const MILES_OCR = `INVOICE\nInvoice For: BuildASoil\n\nFrom:\nInvoice ID Issue Date Terms\n\nMiles Filippelli Fermented Plant Extracts\n10,272,026 10.27.2026 Due Upon Delivery\n\nDESCRIPTION Comfrey Gallon Pumpkin Gallon\nQUANTITY 26.00 56.00\nUNIT PRICE $24.00 $24.00\nAMOUNT $624.00 $1,344.00\nTOTAL\n$2,688.00`;
        const f = extractInvoiceFieldsFromOcrText(MILES_OCR);
        expect(f.invoiceNumber).toBe("10,272,026");
        expect(f.total).toBe(2688);
    });
});

describe("normalizeInvoiceForDb", () => {
    it("replaces UNKNOWN parse with regex", () => {
        const n = normalizeInvoiceForDb(
            { invoiceNumber: "UNKNOWN", vendorName: "UNKNOWN", total: 0 } as any,
            DTE_OCR,
        );
        expect(n.invoiceNumber).toBe("1682");
        expect(n.vendorName).toBe("Down to Earth Worms");
        expect(n.total).toBe(7875);
        expect(n.poNumber).toMatch(/124661/);
        expect(n.lineItems).toEqual([
            expect.objectContaining({ qty: 21, unit_price: 375, ext_price: 7875 }),
        ]);
    });

    it("keeps the text-layer lines when the model parse dropped them", () => {
        const n = normalizeInvoiceForDb(
            { invoiceNumber: "1682", vendorName: "Down to Earth Worms", total: 7875, lineItems: [] } as any,
            DTE_OCR,
        );
        expect(n.lineItems[0]).toEqual(expect.objectContaining({ qty: 21, unit_price: 375, ext_price: 7875 }));
    });
});

describe("vendor sales-order refs must never become a PO", () => {
    // Maple Jet Limited prints a Shipment Order against THEIR sales order
    // SO-2681. That reference is the vendor's, not a Finale PO: if it were ever
    // written to po_number the invoice would match a PO that does not exist and
    // reconciliation would chase it forever. Verified 2026-11-11 — there is no
    // purchase_orders row for Maple Jet at all.
    const SO_REFS = [
        "SO-2681", "SO 2681", "SO2681", "SO#2681", "SO# 2681", "so-2681",
        "SHP-00362", "SHP00362", "Sales Order SO-2681", "Sales Order# : SO-2681",
    ];

    it("extracts no PO from a shipment-order document", () => {
        const doc = [
            "Maple Jet Limited",
            "Aurora Ontario L4G 4B6",
            "SHIPMENT ORDER",
            "Shipment Order# SHP-00362",
            "Sales Order# : SO-2681",
            "Order Date : 2026/11/11",
            "HX Chronplast-W Black Cart - 46ml (Tag) - 17282-05",
            "SKU : 17282-05 HX Chronplast-W Black Cart - 46ml",
            "Qty 3.00 Cart",
        ].join("\n");
        const f = extractInvoiceFieldsFromOcrText(doc);
        expect(f.poNumber).toBeNull();
        expect(f.poNumbers).toEqual([]);
    });

    it("extracts no PO even when the vendor types SO-2681 into a P.O. field", () => {
        const doc = [
            "Maple Jet Limited",
            "INVOICE",
            "Invoice No: MJ-2026-4471",
            "Sales Order# : SO-2681",
            "P.O. Number: SO-2681",
            "SUBTOTAL135.00",
            "TOTAL160.00",
        ].join("\n");
        const f = extractInvoiceFieldsFromOcrText(doc);
        expect(f.poNumber).toBeNull();
        expect(f.poNumbers).toEqual([]);
    });

    it("no SO-style ref survives the PO-shape sanitiser", () => {
        for (const ref of SO_REFS) {
            expect(sanitizeOcrPoCandidate(ref)).toBeNull();
        }
    });
});

describe("Evergreen glued OCR: freight, not the insulation line", () => {
    // Real pdf-parse text from invoices 151475 and 151435 (both 2026-11-11).
    // The Insulation line prints AFTER the shipping line on both, which is the
    // exact shape that once made a "last money amount" rule return 7.00 instead
    // of the real freight. These two invoices are the standing regression.
    const EV_151475 = [
        "Evergreen Growers Supply, LLC.",
        "Invoice # 151475",
        "Date 11/11/2026",
        "P.O. NO.",
        "23593207",
        "Terms Net 30",
        "Due Date",
        "12/11/2026",
        "Shipping-FedExS/H - FedEx Tracking #1ea60.4660.46",
        "InsulationInsulation for hot or cold weather1ea7.007.00",
        "Total",
        "$113.96",
    ].join("\n");

    const EV_151435 = [
        "Evergreen Growers Supply, LLC.",
        "Invoice # 151435",
        "Date 11/11/2026",
        "P.O. NO.",
        "23591857",
        "Shipping-FedExS/H - FedEx Tracking #1ea61.3461.34",
        "InsulationInsulation for hot or cold weather1ea7.007.00",
        "Shipment Date: 11/11/2026 Tracking # 520484911295",
        "Total",
        "$99.84",
    ].join("\n");

    it("reads 60.46 freight on 151475, not the 7.00 insulation", () => {
        const f = extractInvoiceFieldsFromOcrText(EV_151475);
        expect(f.freight).toBe(60.46);
        expect(f.freight).not.toBe(7);
        expect(f.total).toBe(113.96);
        expect(f.poNumber).toBe("23593207");
    });

    it("reads 61.34 freight on 151435, not the 7.00 insulation", () => {
        const f = extractInvoiceFieldsFromOcrText(EV_151435);
        expect(f.freight).toBe(61.34);
        expect(f.freight).not.toBe(7);
        expect(f.total).toBe(99.84);
        expect(f.poNumber).toBe("23591857");
    });

    it("derives a subtotal that reconciles with freight on both", () => {
        const a = normalizeInvoiceForDb(null, EV_151475, {});
        expect(a.subtotal + a.freight + a.tax).toBeCloseTo(a.total, 2);
        const b = normalizeInvoiceForDb(null, EV_151435, {});
        expect(b.subtotal + b.freight + b.tax).toBeCloseTo(b.total, 2);
    });
});

describe("subtotal must reconcile with freight and tax", () => {
    const OCR = ["Invoice # 151475", "P.O. NO.", "23593207", "Shipping-FedExS/H - FedEx Tracking #1ea60.4660.46", "Insulation1ea7.007.00", "Total", "$113.96"].join("\n");

    it("re-derives a subtotal that contradicts total - freight - tax", () => {
        // The 151475 defect: LLM returned subtotal == total, freight on top.
        const n = normalizeInvoiceForDb({ subtotal: 113.96, freight: 60.46, tax: 0, total: 113.96 } as any, OCR, {});
        expect(n.subtotal).toBe(53.5);
        expect(n.subtotal + n.freight + n.tax).toBeCloseTo(n.total, 2);
    });

    it("keeps a subtotal that already reconciles", () => {
        const n = normalizeInvoiceForDb({ subtotal: 38.5, freight: 61.34, tax: 0, total: 99.84 } as any, OCR, {});
        expect(n.subtotal).toBe(38.5);
    });

    it("never leaves an inconsistent row behind", () => {
        for (const parsed of [
            { subtotal: 113.96, freight: 60.46, tax: 0, total: 113.96 },
            { subtotal: 31.5, freight: 61.34, tax: 0, total: 99.84 },
            { subtotal: 0, freight: 12.68, tax: 0, total: 52.68 },
        ]) {
            const n = normalizeInvoiceForDb(parsed as any, OCR, {});
            expect(n.subtotal + n.freight + n.tax).toBeCloseTo(n.total, 2);
        }
    });
});

describe("pure freight bills: subtotal 0 is CORRECT, not a failure", () => {
    // AAA Cooper PRO 64058950 (statement ACT_STMD_ID_2973) is our own outbound
    // move. The rate block prints:
    //   gross line charge 2,487.21, + notify 23.50, - discount 93.60% 2,328.03,
    //   + fuel surcharge 88.34  =>  AMOUNT DUE 271.02
    // The extractor saw the GROSS rate (2,487.21) and a ledger row was written
    // as subtotal 2487.21 + freight 271.02 vs total 271.02. The gross is NOT a
    // subtotal: the entire payable is freight, so subtotal must derive to 0.
    // A `derived > 0` guard skipped this case and left the row inconsistent.
    const OCR = [
        "AAA COOPER TRANSPORTATION",
        "P.O.NUMBER B.L.NUMBER ADV",
        "ORDER 4813 18924041 $.00",
        "1 1PK BUILD A SOUL PRODUCTS 60 2812 88.45 $2,487.21",
        "NOTIFY CHARGE $23.50",
        "DISCOUNT 93.60% - $2,328.03",
        "FUEL SURCHARGE @ 55.50% $88.34",
        "1 Pcs TTL ( 1 ON 1 PLT) *Prepaid*: 2812 $271.02 PPD",
        "AMOUNT DUE 11/26/26 64058950 $271.02",
    ].join("\n");

    it("derives subtotal 0 when the whole payable is freight", () => {
        const n = normalizeInvoiceForDb(
            { subtotal: 2487.21, freight: 271.02, tax: 0, total: 271.02 } as any,
            OCR, {},
        );
        expect(n.subtotal).toBe(0);
        expect(n.freight).toBe(271.02);
        expect(n.subtotal + n.freight + n.tax).toBeCloseTo(n.total, 2);
    });

    it("still refuses to derive a negative subtotal", () => {
        // freight > total is a misread, not a zero-subtotal bill: leave for review.
        const n = normalizeInvoiceForDb(
            { subtotal: 500, freight: 600, tax: 0, total: 100 } as any,
            OCR, {},
        );
        expect(n.subtotal).toBe(500);
    });

    it("does not turn a carrier statement's references into a PO", () => {
        expect(extractInvoiceFieldsFromOcrText(OCR).poNumber).toBeNull();
        expect(extractInvoiceFieldsFromOcrText(OCR).poNumbers).toEqual([]);
    });
});
