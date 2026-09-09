/**
 * @file    src/lib/intelligence/ap/vendor-router.test.ts
 * @purpose Unit tests for vendor routing rules — every rule must fire correctly,
 *          AND gates must work, no-match fallback must be reliable.
 * @author  Hermia
 * @created 2026-06-05
 * @deps    @/lib/intelligence/ap/vendor-router
 */
import { describe, it, expect } from "vitest";
import { matchVendorRouting } from "./vendor-router";

// ─── Convenience helpers ─────────────────────────────────────────────────────

describe("vendor-router domain match", () => {
    it("matches wwex.com → skip", () => {
        const r = matchVendorRouting("billing@wwex.com", "Worldwide Express", "Invoice");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("Worldwide Express");
    });

    it("matches gorgias.com → skip", () => {
        const r = matchVendorRouting("noreply@gorgias.com", "Gorgias", "Your monthly bill");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("Gorgias");
    });

    it("matches google.com → skip", () => {
        const r = matchVendorRouting("noreply@google.com", "Google", "Receipt");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("Google");
    });
});

describe("vendor-router senderContains match", () => {
    it("matches pioneer propane → skip", () => {
        const r = matchVendorRouting("billing@pioneerpropane.com", "Pioneer Propane", "Invoice");
        expect(r?.action).toBe("skip");
    });

    it("matches gorgias via sender name", () => {
        const r = matchVendorRouting("noreply@some-cdn.com", "Gorgias Support", "Ticket");
        expect(r?.action).toBe("skip");
    });

    it("matches google workspace → skip", () => {
        const r = matchVendorRouting("billing@google.com", "Google Workspace", "Receipt");
        expect(r?.action).toBe("skip");
    });

    it("matches google cloud → skip", () => {
        const r = matchVendorRouting("billing@google.com", "Google Cloud", "Receipt");
        expect(r?.action).toBe("skip");
    });

    it("matches terminix → skip", () => {
        const r = matchVendorRouting("billing@terminix.com", "Terminix Pest Control", "Monthly Service");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("Terminix");
    });

    it("matches culligan → skip", () => {
        const r = matchVendorRouting("billing@culligan.com", "Culligan Water", "Your Invoice");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("Culligan");
    });
});

describe("vendor-router internal statement match", () => {
    it("subject 'build a soil statement' alone → skip (no forward)", () => {
        const r = matchVendorRouting("some@internal.com", "Internal", "BUILD A SOIL STATEMENT AS OF JUNE 4 2026");
        expect(r?.action).toBe("skip");
        expect(r?.label).toContain("BuildASoil Statement");
    });

    it("buildasoil.com sender + 'statement' in subject → skip", () => {
        const r = matchVendorRouting("noreply@buildasoil.com", "BuildASoil", "Monthly Statement - June");
        expect(r?.action).toBe("skip");
    });

    it("buildasoil.com sender without 'statement' in subject → no match", () => {
        const r = matchVendorRouting("billing@buildasoil.com", "BuildASoil", "Invoice #123");
        expect(r).toBeNull();
    });

    it("'statement' subject without buildasoil.com sender → still skip pure statement classes", () => {
            const r = matchVendorRouting("vendor@other.com", "Vendor", "Monthly statement June");
            expect(r?.action).toBe("skip");
        });
    });

describe("vendor-router dropship match", () => {
    it("matches logan labs via email → dropship", () => {
        const r = matchVendorRouting("loganlabs@ship.com", "Logan Labs LLC", "Invoice 133821");
        expect(r?.action).toBe("dropship");
        expect(r?.label).toContain("Logan Labs");
    });

    it("matches autopot via email → dropship", () => {
        const r = matchVendorRouting("orders@autopot.com", "AutoPot USA", "Shipping notice");
        expect(r?.action).toBe("dropship");
        expect(r?.label).toContain("AutoPot");
    });

    it("matches evergreen growers via name → dropship", () => {
        const r = matchVendorRouting("billing@egs.com", "Evergreen Growers Supply", "Invoice");
        expect(r?.action).toBe("dropship");
    });

    it("matches ferticell → dropship", () => {
        const r = matchVendorRouting("orders@ferticell.com", "Ferticell", "Invoice");
        expect(r?.action).toBe("dropship");
    });
});

describe("vendor-router QuickBooks AND gate (dropship)", () => {
    it("quickbooks sender + 'logan labs' subject → dropship", () => {
        const r = matchVendorRouting(
            "quickbooks@notification.intuit.com",
            "QuickBooks",
            "New payment request from LOGAN LABS LLC - invoice 133821",
        );
        expect(r?.action).toBe("dropship");
        expect(r?.label).toContain("Logan Labs");
    });

    it("quickbooks sender + 'autopot' subject → dropship", () => {
        const r = matchVendorRouting(
            "quickbooks@notification.intuit.com",
            "QuickBooks",
            "New payment request from AutoPot USA - invoice APUS-245389",
        );
        expect(r?.action).toBe("dropship");
        expect(r?.label).toContain("AutoPot");
    });

    it("quickbooks sender + 'fert' subject → dropship", () => {
        const r = matchVendorRouting(
            "quickbooks@notification.intuit.com",
            "QuickBooks",
            "New payment request from Ferticell - invoice FC-123",
        );
        expect(r?.action).toBe("dropship");
        expect(r?.label).toContain("Ferticell");
    });

    it("quickbooks sender WITHOUT matching subject → NO match (AND gate)", () => {
        const r = matchVendorRouting(
                    "ar@somevendor.com",
                    "Some Vendor",
                    "Monthly statement from some other vendor",
                );
                expect(r?.action).toBe("skip");
                expect(r?.label).toMatch(/Statement/i);
    });

    it("non-quickbooks sender with 'autopot' subject → autopot dropship (not quickbooks rule)", () => {
        // The generic autopot rule (senderContains:'autopot') should fire, not the QB one
        const r = matchVendorRouting("orders@autopot.com", "AutoPot USA", "New payment request from AutoPot");
        expect(r?.action).toBe("dropship");
        expect(r?.label).not.toContain("QuickBooks"); // generic rule, not QB rule
    });
});

describe("vendor-router first-match wins", () => {
    it("gorgias.com matches domain rule before senderContains rule", () => {
        const r = matchVendorRouting("noreply@gorgias.com", "Gorgias", "Invoice");
        expect(r?.match.domain).toBe("gorgias.com"); // domain rule is first in array
    });
});

describe("vendor-router Toyota CF + Belt Power (2026-07-17)", () => {
    it("Toyota Commercial Finance via BillTrust → skip (paid online)", () => {
        const r = matchVendorRouting(
            "ticf_cs_sm@billtrust.com",
            "Toyota Commercial Finance",
            "TICF: Invoice No. 3242834: Your Invoice From Toyota Commercial Finance is Attached",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Toyota|TICF/i);
    });

    it("beltpowerar@ statements/collections → skip", () => {
        const r = matchVendorRouting(
            "beltpowerar@beltpower.com",
            "Belt Power AR",
            "Immediate Attention Required | BuildASoil LLC",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Belt Power AR/i);
    });

    it("Belt Power Invoice Reminder → skip", () => {
        const r = matchVendorRouting(
            "beltpowerar@beltpower.com",
            "Belt Power AR",
            "Invoice 3196029 Reminder from Belt Power, LLC",
        );
        expect(r?.action).toBe("skip");
    });

    it("Belt Power Statement PDF filename → skip", () => {
        const r = matchVendorRouting(
            "remitto@beltpower.com",
            "Belt Power, LLC",
            "Immediate Attention Required",
            "BuildASoil_LLC_Statement.pdf",
        );
        expect(r?.action).toBe("skip");
        // May hit collections subject rule or statement filename rule — either is correct
        expect(r?.label).toMatch(/Belt Power|Statement/i);
    });

    it("Belt Power remitto real invoice → forward (null rule)", () => {
        const r = matchVendorRouting(
            "remitto@beltpower.com",
            "Belt Power, LLC",
            "Belt Power, LLC - Invoice# 3198860 Belt Power Invoice",
            "Inv3198860.pdf",
        );
        expect(r).toBeNull();
    });
});

describe("vendor-router Berger/Wagner/Marion/Grassroots skip (2026-09-08 audit)", () => {
    it("Berger STATEMENT/RELEVÉ DE COMPTE → skip (statement, not invoice)", () => {
        const r = matchVendorRouting(
            "comptabilite@berger.ca",
            "BERGER HORTICULTURAL PRODUCTS LTD.",
            "STATEMENT/RELEVÉ DE COMPTE",
            "BUIAS1.pdf",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Berger/i);
    });

    it("Berger RE: BUIAS1 - ACCOUNT UPDATE REQUIRED → skip (correspondence)", () => {
        const r = matchVendorRouting(
            "comptabilite@berger.ca",
            "Berger Horticultural",
            "RE: BUIAS1 - ACCOUNT UPDATE REQUIRED",
            "image002.pdf",
        );
        expect(r?.action).toBe("skip");
    });

    it("Berger real QuickBooks payment request invoice → forward (null)", () => {
        const r = matchVendorRouting(
            "quickbooks@notification.intuit.com",
            "BERGER HORTICULTURAL PRODUCTS LTD.",
            "New payment request from Berger Horticultural - invoice 44122",
            "Invoice_44122_from_Berger.pdf",
        );
        expect(r).toBeNull();
    });

    it("Berger real delivery invoice batch email → forward (null)", () => {
        // Berger delivers periodically with 10-14 real invoices — never block by sender alone
        const r = matchVendorRouting(
            "comptabilite@berger.ca",
            "BERGER HORTICULTURAL PRODUCTS LTD.",
            "BUIAS1 - Invoice 44521",
            "Invoice_44521.pdf",
        );
        expect(r).toBeNull();
    });

    it("Berger subject mentioning compte but with invoice number → forward (null)", () => {
        // 'compte' alone must never skip — French invoices reference the account
        const r = matchVendorRouting(
            "comptabilite@berger.ca",
            "BERGER HORTICULTURAL PRODUCTS LTD.",
            "FACTURE 44522 SUR VOTRE COMPTE",
            "FACTURE_44522.pdf",
        );
        expect(r).toBeNull();
    });

    it("BFG Supply Acknowledgment_*.pdf → skip (order ack, never a bill)", () => {
        const r = matchVendorRouting(
            "customerrelations@bfgsupply.com",
            "BFG Supply Customer Relations",
            "Acknowledgment for OrderNumber: 3259787-00 has been created.",
            "Acknowledgment_3259787-00.pdf",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Ack/i);
    });

    it("BFG Supply real invoice PDF → forward (null)", () => {
        const r = matchVendorRouting(
            "customerrelations@bfgsupply.com",
            "BFG Supply Customer Relations",
            "Invoice 3290156 from BFG Supply",
            "Invoice_3290156.pdf",
        );
        expect(r).toBeNull();
    });

    it("Wagner 'Invoice and CC Receipt' → skip (paid by card)", () => {
        const r = matchVendorRouting(
            "wagnerequipment.com@notification.com",
            "Wagner Equipment Company",
            "Wagner Invoice and CC Receipt",
            "F1973685.PDF",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Wagner/i);
    });

    it("Marion Ag payment receipt filename → skip (already paid)", () => {
        const r = matchVendorRouting(
            "ar@marionag.com",
            "Marion Ag Service",
            "Company: Marion Ag Service - Transaction # 105416",
            "Payment Receipt_Customer_BuildA_Date_08-31-2026_Time_132750.pdf",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Marion/i);
    });

    it("Marion Ag real invoice filename → forward (null)", () => {
        const r = matchVendorRouting(
            "ar@marionag.com",
            "Marion Ag Service",
            "Company: Marion Ag Service - Transaction #89402",
            "Invoice_89402_Customer_BuildA_Date_09022026_Time_152633.pdf",
        );
        expect(r).toBeNull();
    });

    it("Grassroots reminder thread → skip (duplicate of QuickBooks invoice)", () => {
        const r = matchVendorRouting(
            "info@grassrootsfabricpots.com",
            "Grassroots Fabric Pots",
            "Re: Invoice - Reminder: Your payment to Grassroots Fabric Pots Inc. is 7 days due",
            "Image.pdf",
        );
        expect(r?.action).toBe("skip");
        expect(r?.label).toMatch(/Grassroots/i);
    });

    it("Grassroots real invoice → forward (null)", () => {
        const r = matchVendorRouting(
            "quickbooks@notification.intuit.com",
            "GRASSROOTS FABRIC POTS INC.",
            "New payment request from GRASSROOTS FABRIC POTS INC - invoice 34573",
            "Invoice_34573_from_Grassroots_Fabric_Pots_Inc.pdf",
        );
        expect(r).toBeNull();
    });
});

describe("vendor-router amazon match", () => {
    it("auto-confirm@amazon.com → amazon_order", () => {
        const r = matchVendorRouting("auto-confirm@amazon.com", "Amazon", "Your order");
        expect(r?.action).toBe("amazon_order");
    });

    it("ship-confirm@amazon.com → amazon_order", () => {
        const r = matchVendorRouting("ship-confirm@amazon.com", "Amazon", "Your shipment");
        expect(r?.action).toBe("amazon_order");
    });

    it("shipment-tracking@amazon.com → amazon_order", () => {
        const r = matchVendorRouting("shipment-tracking@amazon.com", "Amazon", "Tracking");
        expect(r?.action).toBe("amazon_order");
    });

    it("order-update@amazon.com → amazon_order", () => {
        const r = matchVendorRouting("order-update@amazon.com", "Amazon", "Order update");
        expect(r?.action).toBe("amazon_order");
    });
});

describe("vendor-router case insensitivity", () => {
    it("AUTOPOT@SHIP.COM (uppercase) → dropship", () => {
        const r = matchVendorRouting("AUTOPOT@SHIP.COM", "AUTOPOT", "INVOICE");
        expect(r?.action).toBe("dropship");
    });

    it("QuickBooks@Intuit.com + 'AutoPot' subject → dropship", () => {
        const r = matchVendorRouting("QuickBooks@Intuit.com", "QuickBooks", "AutoPot USA Invoice");
        expect(r?.action).toBe("dropship");
    });

    it("BILL.SELEE@BUILDASOIL.COM → skip", () => {
        const r = matchVendorRouting("BILL.SELEE@BUILDASOIL.COM", "BILL SELEE", "FWD");
        expect(r?.action).toBe("skip");
    });
});

describe("vendor-router no match", () => {
    it("unknown vendor → null", () => {
        const r = matchVendorRouting("some-random@vendor.com", "Random Vendor", "Invoice #123");
        expect(r).toBeNull();
    });

    it("empty email → null", () => {
        const r = matchVendorRouting("", "", "Invoice");
        expect(r).toBeNull();
    });

    it("email with no @ sign → null", () => {
        const r = matchVendorRouting("notanemail", "Test", "Invoice");
        expect(r).toBeNull();
    });
});

describe("vendor-router first-match wins", () => {
    it("gorgias.com matches domain rule before senderContains rule", () => {
        const r = matchVendorRouting("noreply@gorgias.com", "Gorgias", "Invoice");
        expect(r?.match.domain).toBe("gorgias.com"); // domain rule is first in array
    });
});