/**
 * @file    src/lib/tracking/email-tracking-ingest-inference.test.ts
 * @purpose Regression tests for PO inference on carrier notification emails.
 *
 *          Real failure this encodes (2026-11-11): PO 125487 (Cen-Tec Systems,
 *          $324.25) collected 28 unrelated parcel links. The UPS ship notification
 *          ("visit our help and support center") matched the vendor token "cen",
 *          and a FedEx Billing Online invoice ("protected by copyright") matched
 *          "tec". Substring token matching made every carrier footer a vendor
 *          match, and Step 3 then handed the newest PO of that vendor to all of
 *          them. A PO with no tracking is honest; a PO with someone else's
 *          parcels is a lie the dashboard reports as "fully tracked".
 *
 * @author  Hermia
 * @created 2026-11-11
 * @deps    ./email-tracking-ingest (inferPONumberFromRecentPOs)
 * @env     none
 */
import { describe, expect, it } from "vitest";
import { inferPONumberFromRecentPOs, type RecentPurchaseOrder } from "./email-tracking-ingest";

const RECENT: RecentPurchaseOrder[] = [
    { po_number: "125487", vendor_name: "Cen-Tec Systems", created_at: "2026-11-09T18:32:57Z" },
    { po_number: "125488", vendor_name: "ULINE", created_at: "2026-11-10T16:17:41Z" },
    { po_number: "125490", vendor_name: "New Moon Development Co", created_at: "2026-11-10T16:20:00Z" },
];

const infer = (msg: { subject?: string; bodySnippet?: string; fromEmail?: string }, vendor?: string | null) =>
    inferPONumberFromRecentPOs(msg, RECENT, vendor ?? null);

describe("inferPONumberFromRecentPOs — carrier boilerplate must never name a vendor", () => {
    it("does not read 'cen' out of 'support center' (UPS ship notification)", () => {
        const result = infer({
            subject: "UPS Ship Notification, Tracking Number 1Z94Y00A6718975526",
            fromEmail: "pkginfo@ups.com",
            bodySnippet:
                "Tracking Number: 1Z94Y00A6718975526\nWeight: 1.0 LBS\n" +
                "For questions, visit our help and support center https://www.ups.com/us/en/support",
        });
        expect(result).toBeNull();
    });

    it("does not read 'tec' out of 'protected' (FedEx Billing Online footer)", () => {
        const result = infer({
            subject: "Your New FedEx Billing Online invoice is attached",
            fromEmail: "noreply@fedex.com",
            bodySnippet:
                "Your invoice 953868426 is attached.\n" +
                "The content of this message is protected by copyright and trademark laws under U.S. law.",
        });
        expect(result).toBeNull();
    });

    it("ignores a lone generic vendor word ('systems')", () => {
        const result = infer({
            subject: "Shipping confirmation",
            fromEmail: "notifications@netparcel.com",
            bodySnippet: "Your parcel left our systems and is in transit.",
        });
        expect(result).toBeNull();
    });

    it("still links when the vendor is named explicitly in the email", () => {
        const result = infer({
            subject: "Cen-Tec Systems order 125487 has shipped",
            fromEmail: "noreply@fedex.com",
            bodySnippet: "Cen-Tec Systems shipped 1 package. Tracking 879740990262.",
        });
        expect(result).toBe("125487");
    });

    it("still links a single-word vendor named as a whole word", () => {
        const result = infer({
            subject: "ULINE order 125488 shipped",
            fromEmail: "noreply@ups.com",
            bodySnippet: "ULINE order 125488 left the warehouse.",
        });
        expect(result).toBe("125488");
    });

    it("keeps the resolved-sender single-PO path (vendor_emails match)", () => {
        const result = infer(
            { subject: "Your order shipped", fromEmail: "orders@centecsystems.com", bodySnippet: "On the way." },
            "Cen-Tec Systems",
        );
        expect(result).toBe("125487");
    });

    it("does not substring-match the full vendor name either", () => {
        const result = infer({
            subject: "Update",
            fromEmail: "noreply@usps.com",
            bodySnippet: "The Cen-Tec Systemsx tracking is unavailable.",
        });
        expect(result).toBeNull();
    });
});
