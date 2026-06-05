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

// ─── Convenience: typical name from address pattern ─────────────────────────
function nameFromEmail(email: string): string {
    return email.split("@")[0].replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

describe("vendor-router domain match", () => {
    it("matches wwex.com → autopay", () => {
        const r = matchVendorRouting("billing@wwex.com", "Worldwide Express", "Invoice");
        expect(r?.action).toBe("autopay");
        expect(r?.label).toContain("Worldwide Express");
    });

    it("matches gorgias.com → autopay", () => {
        const r = matchVendorRouting("noreply@gorgias.com", "Gorgias", "Your monthly bill");
        expect(r?.action).toBe("autopay");
        expect(r?.label).toContain("Gorgias");
    });

    it("matches google.com → autopay", () => {
        const r = matchVendorRouting("noreply@google.com", "Google", "Receipt");
        expect(r?.action).toBe("autopay");
        expect(r?.label).toContain("Google");
    });
});

describe("vendor-router senderContains match", () => {
    it("matches pioneer propane → autopay", () => {
        const r = matchVendorRouting("billing@pioneerpropane.com", "Pioneer Propane", "Invoice");
        expect(r?.action).toBe("autopay");
    });

    it("matches gorgias via sender name", () => {
        const r = matchVendorRouting("noreply@some-cdn.com", "Gorgias Support", "Ticket");
        expect(r?.action).toBe("autopay");
    });

    it("matches google workspace → autopay", () => {
        const r = matchVendorRouting("billing@google.com", "Google Workspace", "Receipt");
        expect(r?.action).toBe("autopay");
    });

    it("matches google cloud → autopay", () => {
        const r = matchVendorRouting("billing@google.com", "Google Cloud", "Receipt");
        expect(r?.action).toBe("autopay");
    });

    it("matches terminix → autopay", () => {
        const r = matchVendorRouting("billing@terminix.com", "Terminix Pest Control", "Monthly Service");
        expect(r?.action).toBe("autopay");
        expect(r?.label).toContain("Terminix");
    });

    it("matches culligan → autopay", () => {
        const r = matchVendorRouting("billing@culligan.com", "Culligan Water", "Your Invoice");
        expect(r?.action).toBe("autopay");
        expect(r?.label).toContain("Culligan");
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
            "quickbooks@notification.intuit.com",
            "QuickBooks",
            "Monthly statement from some other vendor",
        );
        expect(r).toBeNull();
    });

    it("non-quickbooks sender with 'autopot' subject → autopot dropship (not quickbooks rule)", () => {
        // The generic autopot rule (senderContains:'autopot') should fire, not the QB one
        const r = matchVendorRouting("orders@autopot.com", "AutoPot USA", "New payment request from AutoPot");
        expect(r?.action).toBe("dropship");
        expect(r?.label).not.toContain("QuickBooks"); // generic rule, not QB rule
    });
});

describe("vendor-router ignore match", () => {
    it("bill.selee@buildasoil.com → ignore", () => {
        const r = matchVendorRouting("bill.selee@buildasoil.com", "Bill Selee", "Fwd: something");
        expect(r?.action).toBe("ignore");
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

    it("BILL.SELEE@BUILDASOIL.COM → ignore", () => {
        const r = matchVendorRouting("BILL.SELEE@BUILDASOIL.COM", "BILL SELEE", "FWD");
        expect(r?.action).toBe("ignore");
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