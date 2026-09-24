/**
 * @file    src/lib/purchasing/po-thread-clock.test.ts
 * @purpose PO 125126 thread clock: sold-out hold is not lead time.
 * @author  Hermia
 * @created 2026-09-24
 * @deps    vitest, po-thread-clock
 * @env     none
 */
import { describe, expect, it } from "vitest";
import { readPoThreadClock, poNumberFromSubject, holdStampRow, applyHoldStamp, type ThreadClockMessage } from "./po-thread-clock";

const HERBSNOW_125126: ThreadClockMessage[] = [
    {
        at: "2026-07-23T13:47:00.000Z",
        fromUs: true,
        text: "Hi Please find purchase order attached. Also, please give an ETA as soon as possible. Thank you!",
    },
    {
        at: "2026-07-24T12:51:00.000Z",
        fromUs: false,
        text: "Hi Bill, I apologize, but we are temporarily sold out. We do have new stock this order when it arrives. Our anticipated arrival for new stock is early September.",
    },
    {
        at: "2026-08-05T16:18:00.000Z",
        fromUs: true,
        text: "Go ahead and fill this order when the new stock arrives in September.",
    },
    {
        at: "2026-08-06T13:29:00.000Z",
        fromUs: false,
        text: "Sounds good! I'll send over an invoice as soon as we're restocked.",
    },
    {
        at: "2026-09-16T20:41:00.000Z",
        fromUs: false,
        text: "Hi Bill, We are fully restocked! I've sent over your invoice via PayPal.",
    },
    {
        at: "2026-09-16T20:52:00.000Z",
        fromUs: true,
        text: "Paid, Thank you!",
    },
    {
        at: "2026-09-17T13:17:00.000Z",
        fromUs: false,
        text: "Hi Bill, Thank you! Your order is shipping today, and I've noted your tracking below. FedEx: 877350371327",
    },
];

describe("readPoThreadClock", () => {
    it("splits the HerbsNOW 125126 hold from the 1-day fulfill", () => {
        const clock = readPoThreadClock(HERBSNOW_125126);
        expect(clock.hold).toBe(true);
        expect(clock.excludeFromLeadPlan).toBe(true);
        expect(clock.holdStartedAt).toBe("2026-07-24");
        expect(clock.availableAt).toBe("2026-09-16");
        expect(clock.shippedAt).toBe("2026-09-17");
        expect(clock.fulfillLeadDays).toBe(1);
        expect(clock.snippet.toLowerCase()).toContain("sold out");
    });

    it("does not treat a future restock promise as available", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-08-06T13:29:00.000Z",
                fromUs: false,
                text: "I'll send over an invoice as soon as we're restocked.",
            },
        ]);
        expect(clock.hold).toBe(false);
        expect(clock.availableAt).toBeNull();
        expect(clock.excludeFromLeadPlan).toBe(false);
    });

    it("leaves a silent send out of the lead exclusion", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-07-23T13:47:00.000Z",
                fromUs: true,
                text: "Please find purchase order attached.",
            },
        ]);
        expect(clock.excludeFromLeadPlan).toBe(false);
        expect(clock.hold).toBe(false);
    });

    it("records a normal ship without calling it a hold", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-09-01T15:00:00.000Z",
                fromUs: false,
                text: "Your order is shipping today. Tracking 1Z999AA10123456784",
            },
        ]);
        expect(clock.hold).toBe(false);
        expect(clock.excludeFromLeadPlan).toBe(false);
        expect(clock.shippedAt).toBe("2026-09-01");
    });

    it("reads a hold out of Gmail HTML", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-07-24T12:51:00.000Z",
                fromUs: false,
                text: "<div>we are <b>temporarily sold out</b>.</div>",
            },
        ]);
        expect(clock.excludeFromLeadPlan).toBe(true);
        expect(clock.snippet.toLowerCase()).toContain("sold out");
    });

    it("joins the PO number off a reply subject", () => {
        expect(poNumberFromSubject("Re: BuildASoil PO # 125126 - HerbsNOW - 7/22/2026")).toBe("125126");
        expect(poNumberFromSubject("invoice attached")).toBeNull();
    });

    it("stamps only a hold, and marks that receipt sample", () => {
        const clock = readPoThreadClock(HERBSNOW_125126);
        const row = holdStampRow("125126", clock, "2026-09-24T16:00:00.000Z");
        expect(row?.thread_hold).toBe(true);
        expect(row?.thread_fulfill_lead_days).toBe(1);
        expect(holdStampRow("1", readPoThreadClock([]))).toBeNull();
        const stamped = applyHoldStamp(
            { days: 56, orderId: "125126" },
            { snippet: String(row?.thread_hold_snippet) },
        );
        expect(stamped.holdExcluded).toBe(true);
        expect(stamped.holdNote).toMatch(/125126/);
    });

    it("does not treat a vendor ban on backorder wording as a hold", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-07-02T16:10:00.000Z",
                fromUs: false,
                text: "Hey Bill- Ok, bummer. I don't want any type of backorder status affecting an order on your website.",
            },
        ]);
        expect(clock.hold).toBe(false);
        expect(clock.excludeFromLeadPlan).toBe(false);
    });

    it("does not treat our quoted chase as the vendor being out of stock", () => {
        const clock = readPoThreadClock([
            {
                at: "2026-08-28T02:01:00.000Z",
                fromUs: false,
                text: "I am sorry about the delays. We have had some major production issues. On Thu, Aug 27, 2026 at 3:21 PM Bill Selee wrote: we are completely out of stock and have customers waiting.",
            },
        ]);
        expect(clock.hold).toBe(false);
    });
});
