import { describe, expect, it } from "vitest";
import { classifyHumanInquiry } from "./payment-inquiry-classifier";

describe("classifyHumanInquiry", () => {
    it("flags Auto-Submitted header as automated", () => {
        expect(classifyHumanInquiry({
            from: "ar@vendor.com",
            subject: "Payment status",
            headers: { "auto-submitted": "auto-generated" },
        })).toBe("automated_noreply");
    });

    it("flags noreply / do-not-reply senders as automated", () => {
        expect(classifyHumanInquiry({
            from: "no-reply@billing.example.com",
            subject: "Statement",
        })).toBe("automated_noreply");
        expect(classifyHumanInquiry({
            from: '"Billing Bot" <donotreply@vendor.io>',
            subject: "Past due",
        })).toBe("automated_noreply");
    });

    it("detects Mitzi-style past-due human asks", () => {
        expect(classifyHumanInquiry({
            from: '"Mitzi Abraham" <mitzi@diamondk.com>',
            subject: "PAST DUE INVOICE",
            snippet: "Can I please get payment status on the attached past due invoice.",
        })).toBe("payment_inquiry");
    });

    it("detects 'when will we get paid' phrasings in body", () => {
        expect(classifyHumanInquiry({
            from: "ar@vendor.com",
            subject: "Quick question",
            body: "Hi — when will we get paid on invoice 12345? Thanks.",
        })).toBe("payment_inquiry");
    });

    it("detects payment reminder / aging report subjects", () => {
        expect(classifyHumanInquiry({
            from: "ar@vendor.com",
            subject: "Payment reminder — INV-001",
        })).toBe("payment_inquiry");
        expect(classifyHumanInquiry({
            from: "ar@vendor.com",
            subject: "Monthly aging report",
        })).toBe("payment_inquiry");
    });

    it("treats general human chatter as general_human", () => {
        expect(classifyHumanInquiry({
            from: '"Rep" <rep@vendor.com>',
            subject: "Quick question about lead times",
            snippet: "Hey just wondering if you're still planning to order more.",
        })).toBe("general_human");
    });

    it("treats a bare 'thanks' email as general_human", () => {
        expect(classifyHumanInquiry({
            from: '"Rep" <rep@vendor.com>',
            subject: "Re: order",
            snippet: "Sounds good, thanks!",
        })).toBe("general_human");
    });

    it("prefers automated over payment_inquiry when both match", () => {
        // A no-reply dunning email could match payment patterns too; the
        // automated classification wins because we never want to escalate or
        // reply to a machine sender.
        expect(classifyHumanInquiry({
            from: "noreply@dunning.example.com",
            subject: "Your invoice is past due",
        })).toBe("automated_noreply");
    });
});
