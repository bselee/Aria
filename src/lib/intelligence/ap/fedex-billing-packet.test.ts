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
    extractFedExInvoiceNumberFromText,
    extractFedExInvoiceTotal,
    detectFedExBillingServiceHint,
} from "./fedex-billing-packet";

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

    it("extracts TOTAL THIS INVOICE amount (no-space INVOICEUSD variant)", () => {
        expect(extractFedExInvoiceTotal("TOTAL THIS INVOICEUSD$15,287.10")).toBe(15287.1);
        expect(extractFedExInvoiceTotal("TOTAL THIS INVOICE\nUSD\n$6,765.86")).toBe(6765.86);
        expect(extractFedExInvoiceTotal("no total here")).toBeNull();
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
    it("marks packet, forbids trim, skips product PO match", () => {
        const meta = classifyFedExBillingAttachment({
            from: "noreply@fedex.com",
            subject: "Your New FedEx Billing Online invoice is attached",
            filename: GROUND_NAME,
            pdfTextPreview: "FedEx Ground Services\nTOTAL THIS INVOICE\nUSD\n$13,499.43",
        });
        expect(meta.isPacket).toBe(true);
        expect(meta.mayTrimPages).toBe(false);
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
        expect(meta.mayTrimPages).toBe(false);
    });

    it("derives display invoice# from filename digits when packet text is unavailable", () => {
        // Real-world case: local forwarder's first classify runs before OCR text
        // exists. The filename digits MUST still yield the dashed number that gets
        // passed into forwardInvoiceOnce (ocr_invoice_number / dedup layers 4-6).
        const meta = classifyFedExBillingAttachment({
            from: "noreply@fedex.com",
            subject: "Your New FedEx Billing Online invoice is attached",
            filename: "12.99999.10033.942652443.XXXXX5250.000030.pdf",
            pdfTextPreview: undefined,
        });
        expect(meta.isPacket).toBe(true);
        expect(meta.invoiceNumberDisplay).toBe("9-426-52443");
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

    it("queue fields force carrier_bill + no trim", () => {
        const meta = classifyFedExBillingAttachment({
            filename: EXPRESS_NAME,
            from: "noreply@fedex.com",
            subject: "invoice",
        });
        const fields = buildFedExCarrierBillQueueFields(meta);
        expect(fields.vendor_routing_action).toBe(FEDEX_CARRIER_BILL_ACTION);
        expect(fields.fedex_may_trim_pages).toBe(false);
        expect(fields.skip_product_po_match).toBe(true);
        expect(fields.skip_uline_bas_freight).toBe(true);
        expect(isFedExCarrierBillExtractedJson(fields)).toBe(true);
    });
});

describe("detectFedExBillingServiceHint", () => {
    it("prefers Ground / Express / Freight labels", () => {
        expect(detectFedExBillingServiceHint("FedEx Ground Services")).toBe("Ground");
        expect(detectFedExBillingServiceHint("FedEx Express Services")).toBe("Express");
        expect(detectFedExBillingServiceHint("FedEx Freight LTL FXFE")).toBe("Freight");
    });
});
