/**
 * @file    fedex-billing-packet.test.ts
 * @purpose Unit tests for FedEx Billing Online packet detection + no-trim rules.
 * @author  Hermia
 * @created 2026-08-05
 */
import { describe, expect, it } from "vitest";
import {
    FEDEX_CARRIER_BILL_ACTION,
    buildFedExBillComFilename,
    buildFedExCarrierBillQueueFields,
    classifyFedExBillingAttachment,
    extractInvoiceDigitsFromFedExFilename,
    formatFedExInvoiceDisplay,
    isFedExBillingOnlineEmail,
    isFedExBillingPacketFilename,
    isFedExCarrierBillExtractedJson,
    isFedExExcludedFromBillCom,
    extractFedExInvoiceNumberFromText,
    detectFedExBillingServiceHint,
    trimToFirstPage,
} from "./fedex-billing-packet";
import { PDFDocument } from "pdf-lib";

const EXPRESS_NAME = "12.99999.10033.939879901.XXXXX5250.000030.pdf";
const GROUND_NAME = "12.99999.10033.939879902.XXXXX5250.000002.pdf";

describe("isFedExBillingPacketFilename", () => {
    it("accepts verified FBO packet names", () => {
        expect(isFedExBillingPacketFilename(EXPRESS_NAME)).toBe(true);
        expect(isFedExBillingPacketFilename(GROUND_NAME)).toBe(true);
    });

    it("rejects normal vendor invoices", () => {
        expect(isFedExBillingPacketFilename("Uline_Invoice_201.pdf")).toBe(false);
        expect(isFedExBillingPacketFilename("Invoice_00414_from_Granite.pdf")).toBe(false);
    });
});

describe("extract + format invoice #", () => {
    it("pulls digits from filename and formats 9-digit display", () => {
        expect(extractInvoiceDigitsFromFedExFilename(EXPRESS_NAME)).toBe("939879901");
        expect(formatFedExInvoiceDisplay("939879901")).toBe("9-398-79901");
        expect(formatFedExInvoiceDisplay("939879902")).toBe("9-398-79902");
    });

    it("parses Invoice Number from summary text", () => {
        const text = "Invoice Number\n9-398-79901\nAccount Number\nXXXX-X525-0\nTOTAL THIS INVOICE\nUSD\n$10,958.44";
        expect(extractFedExInvoiceNumberFromText(text)).toBe("9-398-79901");
    });
});

describe("isFedExExcludedFromBillCom", () => {
    it("excludes FBO parcel, Freight, past-due, and packet filenames", () => {
        expect(isFedExExcludedFromBillCom({
            from: "FedEx Billing Online <noreply@fedex.com>",
            subject: "Your New FedEx Billing Online invoice is attached",
        })).toBe(true);
        expect(isFedExExcludedFromBillCom({
            from: "BillingOnline <BillingOnline@fedex.com>",
            subject: "FedEx Billing Online - Invoice(s) Past Due",
        })).toBe(true);
        expect(isFedExExcludedFromBillCom({
            from: "BuildASoil Support <support@buildasoil.com>",
            subject: "Fwd: invoice",
            filename: "12.99999.10033.939879901.XXXXX5250.000030.pdf",
        })).toBe(true);
        expect(isFedExExcludedFromBillCom({
            from: "support@buildasoil.com",
            subject: "Fwd: Acct No. 646135168: Your Bill from FedEx Freight is Available Online",
        })).toBe(true);
    });

    it("does not exclude a vendor invoice that only mentions FedEx", () => {
        expect(isFedExExcludedFromBillCom({
            from: "accounts.receivable@uline.com",
            subject: "Uline Invoice 211897049 shipped via FedEx",
            filename: "Uline_Invoice_201.pdf",
            pdfText: "Ship Via FEDEX FREIGHT COLLECT",
        })).toBe(false);
    });
});

describe("isFedExBillingOnlineEmail", () => {
    it("matches noreply + Billing Online subject", () => {
        expect(
            isFedExBillingOnlineEmail(
                "FedEx Billing Online <noreply@fedex.com>",
                "Your New FedEx Billing Online invoice is attached",
                "invoice available",
                [EXPRESS_NAME, GROUND_NAME],
            ),
        ).toBe(true);
    });

    it("matches by packet filename alone", () => {
        expect(
            isFedExBillingOnlineEmail("someone@other.com", "fw", "", [GROUND_NAME]),
        ).toBe(true);
    });

    it("rejects billingonline past-due sender without packet name", () => {
        expect(
            isFedExBillingOnlineEmail(
                "billingonline@fedex.com",
                "Past Due",
                "pay now",
                [],
            ),
        ).toBe(false);
    });
});

describe("classifyFedExBillingAttachment", () => {
    it("marks packet, trims to first page, skips product PO match", () => {
        const meta = classifyFedExBillingAttachment({
            from: "noreply@fedex.com",
            subject: "Your New FedEx Billing Online invoice is attached",
            filename: GROUND_NAME,
            pdfTextPreview: "FedEx Ground Services\nTOTAL THIS INVOICE\nUSD\n$13,499.43",
        });
        expect(meta.isPacket).toBe(true);
        expect(meta.mayTrimPages).toBe(true);
        expect(meta.skipProductPoMatch).toBe(true);
        expect(meta.invoiceNumberDisplay).toBe("9-398-79902");
        expect(meta.serviceHint).toBe("Ground");
    });

    it("detects Express service hint", () => {
        const meta = classifyFedExBillingAttachment({
            from: "noreply@fedex.com",
            subject: "invoice attached",
            filename: EXPRESS_NAME,
            pdfTextPreview: "FedEx Express Services\nFedEx 2Day",
        });
        expect(meta.serviceHint).toBe("Express");
        expect(meta.mayTrimPages).toBe(true);
    });
});

describe("Bill.com filename + queue fields", () => {
    it("builds clean human filename", () => {
        const name = buildFedExBillComFilename({
            invoiceNumberDisplay: "9-398-79902",
            serviceHint: "Ground",
        });
        expect(name).toBe("FedEx_Ground_9-398-79902.pdf");
    });

    it("queue fields force carrier_bill + first-page trim", () => {
        const meta = classifyFedExBillingAttachment({
            filename: EXPRESS_NAME,
            from: "noreply@fedex.com",
            subject: "invoice",
        });
        const fields = buildFedExCarrierBillQueueFields(meta);
        expect(fields.vendor_routing_action).toBe(FEDEX_CARRIER_BILL_ACTION);
        expect(fields.fedex_may_trim_pages).toBe(true);
        expect(fields.skip_product_po_match).toBe(true);
        expect(fields.skip_uline_bas_freight).toBe(true);
        expect(isFedExCarrierBillExtractedJson(fields)).toBe(true);
    });

    it("trims a multi-page PDF to page 1", async () => {
        const src = await PDFDocument.create();
        src.addPage([612, 792]);
        src.addPage([612, 792]);
        src.addPage([612, 792]);
        const full = Buffer.from(await src.save());

        const trimmed = await trimToFirstPage(full);
        const reloaded = await PDFDocument.load(trimmed);
        expect(reloaded.getPageCount()).toBe(1);
    });

    it("returns the original buffer when already single-page", async () => {
        const src = await PDFDocument.create();
        src.addPage([612, 792]);
        const one = Buffer.from(await src.save());
        const out = await trimToFirstPage(one);
        expect(out).toBe(one);
    });
});

describe("detectFedExBillingServiceHint", () => {
    it("prefers Ground / Express / Freight labels", () => {
        expect(detectFedExBillingServiceHint("FedEx Ground Services")).toBe("Ground");
        expect(detectFedExBillingServiceHint("FedEx Express Services")).toBe("Express");
        expect(detectFedExBillingServiceHint("FedEx Freight LTL FXFE")).toBe("Freight");
    });
});
