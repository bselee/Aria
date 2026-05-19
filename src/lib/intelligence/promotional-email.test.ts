import { describe, expect, it } from "vitest";

import { isObviousPromotionalEmail } from "./promotional-email";

describe("isObviousPromotionalEmail", () => {
    it("detects obvious marketing subjects from recent inbox misses", () => {
        const cases = [
            {
                from: '"Uline | Specials" <specials@e.uline.com>',
                subject: "Save Up to 40% on ECT Boxes",
                snippet: "Shop now and save on packaging supplies. Unsubscribe",
            },
            {
                from: "Global Industrial <global@message.globalindustrial.com>",
                subject: "New Game-Changing Cat Material Handling Equipment Protects Your Team",
                snippet: "See the latest offers and promotions.",
            },
            {
                from: "AeroPress <sales@aeropress.com>",
                subject: "FINAL CHANCE ALERT",
                snippet: "Tomorrow is the last day to save.",
            },
            {
                from: "Coursera <Coursera@m.learn.coursera.org>",
                subject: "Ready: Google AI Essentials",
                snippet: "Explore courses and unsubscribe from marketing emails.",
            },
        ];

        for (const email of cases) {
            expect(isObviousPromotionalEmail(email)).toBe(true);
        }
    });

    it("does not classify payable or operational emails as promotional", () => {
        const cases = [
            {
                from: "AutoPot Watering Systems USA <quickbooks@notification.intuit.com>",
                subject: "New payment request from AutoPot USA - Invoice APUS-245048",
                snippet: "Please review and pay this invoice.",
            },
            {
                from: "Granite Mill Farms <granitemillfarms@gmail.com>",
                subject: "PO ready",
                snippet: "Your purchase order is ready for pickup.",
            },
            {
                from: "BillingOnline <BillingOnline@fedex.com>",
                subject: "FedEx Billing Online - Demand for Payment",
                snippet: "Payment is due for your account.",
            },
            {
                from: "Alisa-Colorful Packaging Limited <sales02@colorfulpackaging.com>",
                subject: "Re:Proofs confirmation",
                snippet: "Please confirm the proofs. Unsubscribe footer",
            },
            {
                from: "Tigerseal Products <sales@tigerseal.com>",
                subject: "[Tigerseal] Order 33277 - May 11, 2026 - Entered",
                snippet: "Your order has been received. Unsubscribe footer",
            },
            {
                from: "Alibaba <credit@notice.alibaba.com>",
                subject: "The payment status for your Trade Assurance order has changed",
                snippet: "The payment status changed for order 300280955501024781.",
            },
        ];

        for (const email of cases) {
            expect(isObviousPromotionalEmail(email)).toBe(false);
        }
    });
});
