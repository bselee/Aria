// Adversarial battery for the LTL delivered-branch fix (tracking-service.ts /
// carrier-poll.ts). Happy-path tests prove nothing here: `delivered` is terminal
// in the monotonic writer, so one false positive is unrecoverable.
//
// Cases marked REAL read committed fixture bytes. Cases marked SYNTHETIC use a
// shape-accurate string and are labelled as such — the delivered-page fixture
// cannot be captured honestly while AAA is throttling this host.
import { readFileSync } from "fs";
import { parseTrackingContent } from "../src/lib/carriers/tracking-service";

type Case = {
    id: string;
    label: string;
    input: string;
    expect: (r: ReturnType<typeof parseTrackingContent>) => string | null; // null = pass, else failure text
};

const bare = readFileSync("scripts/fixtures/aaa-pro-bare-chrome-page.txt", "utf8");

// The real delivered block, exactly as observed on the AAA PRO page for
// 64058937 / 64058930 / 64058932 (chrome stripped by the capture probe).
const deliveredBlock = (args: { date: string; time: string; city: string; st: string; signed: string }) =>
    `Pro Tracking Results | AAA Cooper Transportation Destination Service Center : LOUISVILLE ` +
    `Pickup Date : 10/20/2026 Delivery Date Time : ${args.date} ${args.time} Status : Delivered ` +
    `Signed For : ${args.signed} For real-time continuous transit visibility with progress updates ` +
    `Weight : 2074 Tracing Information Date Time Description ${args.date} ${args.time} Delivered To Consignee In ${args.city}, ${args.st} ` +
    `2026-10-23 16:54 Shipment arrived at destination Service Center`;

const cases: Case[] = [
    {
        id: "A",
        label: "REAL bare chrome page (throttle) -> no claim",
        input: bare,
        expect: (r) => (r === null ? null : `expected null (silence), got ${JSON.stringify(r)}`),
    },
    {
        id: "B",
        label: "SYNTH delivered block, Louisville KY EDT -> 13:25Z + signature",
        input: deliveredBlock({ date: "10/26/2026", time: "09:25", city: "LOUISVILLE", st: "KY", signed: "Davidson" }),
        expect: (r) => {
            if (!r) return "expected a claim, got null";
            if (r.category !== "delivered") return `category ${r.category}`;
            if (r.delivered_at !== "2026-10-26T13:25:00.000Z") return `delivered_at ${r.delivered_at}`;
            if (r.signed_for !== "Davidson") return `signed_for ${r.signed_for}`;
            return null;
        },
    },
    {
        id: "C",
        label: "SYNTH delivered block, San Diego CA PDT -> 21:53Z + signature",
        input: deliveredBlock({ date: "10/21/2026", time: "14:53", city: "SAN DIEGO", st: "CA", signed: "Ben" }),
        expect: (r) => {
            if (!r || r.category !== "delivered") return "expected delivered";
            if (r.delivered_at !== "2026-10-21T21:53:00.000Z") return `delivered_at ${r.delivered_at}`;
            if (r.signed_for !== "Ben") return `signed_for ${r.signed_for}`;
            return null;
        },
    },
    {
        id: "D",
        label: "SYNTH delivered block, San Diego CA after DST end (11/05, PST -8) -> 22:53Z",
        input: deliveredBlock({ date: "11/05/2026", time: "14:53", city: "SAN DIEGO", st: "CA", signed: "Ben" }),
        expect: (r) => {
            if (!r || r.category !== "delivered") return "expected delivered";
            return r.delivered_at === "2026-11-05T22:53:00.000Z" ? null : `DST conversion wrong: ${r.delivered_at}`;
        },
    },
    {
        id: "E",
        label: "SYNTH delivered block, unmapped state -> deployed category but NO timestamp (never guess a zone)",
        input: deliveredBlock({ date: "10/21/2026", time: "14:53", city: "ANCHORAGE", st: "AK", signed: "Ben" }),
        expect: (r) => {
            if (!r || r.category !== "delivered") return "expected delivered";
            return r.delivered_at === undefined ? null : `invented a timestamp for an unmapped state: ${r.delivered_at}`;
        },
    },
    {
        id: "F",
        label: "ADVERSARIAL SYNTH: AAA page WITH Tracing block, no delivery block, word Delivered elsewhere -> must not claim delivered",
        input:
            `AAA Cooper Transportation Pickup Date : 10/20/2026 Delivery Date Time : Status : In Transit ` +
            `Tracing Information Date Time Description 2026-10-23 16:54 Shipment arrived at destination Service Center ` +
            `Legend: Delivered = final status for a completed shipment`,
        expect: (r) => {
            if (!r) return null; // silence is acceptable and preferred
            return r.category === "delivered"
                ? `FALSE POSITIVE: claimed delivered from the bare word — ${r.display}`
                : null;
        },
    },
    {
        id: "G",
        label: "regression: generic text delivered-with-date still parses",
        input: "Package delivered on March 15, 2026",
        expect: (r) => {
            if (!r || r.category !== "delivered") return "expected delivered";
            return r.delivered_at ? null : "lost the date for the generic shape";
        },
    },
    {
        id: "H",
        label: "generic bare delivered without a date -> category only, NO invented timestamp",
        input: "Your package has been delivered",
        expect: (r) => {
            if (!r || r.category !== "delivered") return "expected delivered";
            return r.delivered_at === undefined ? null : `invented a timestamp: ${r.delivered_at}`;
        },
    },
    {
        id: "I",
        label: "SOURCE: carrier-poll must not substitute now() for a missing delivered_at",
        input: "",
        expect: () => {
            const src = readFileSync("src/lib/purchasing/carrier-poll.ts", "utf8");
            const line = src.split(/\r?\n/).find((l) => /newDelivered\s*=\s*newCat\s*===\s*'delivered'/.test(l));
            if (!line) return "could not locate the delivered assignment";
            const next = src.split(/\r?\n/)[src.split(/\r?\n/).indexOf(line) + 1] ?? "";
            return /new Date\(/.test(next) ? `now() substitution still present: ${next.trim()}` : null;
        },
    },
];

let failed = 0;
for (const c of cases) {
    const result = c.id === "I" ? null : parseTrackingContent(c.input);
    const failure = c.expect(result as any);
    if (failure) {
        failed++;
        console.log(`FAIL ${c.id}  ${c.label}\n     ${failure}`);
    } else {
        console.log(`pass ${c.id}  ${c.label}`);
    }
}
console.log(`\n${cases.length - failed}/${cases.length} pass, ${failed} defect(s)`);
process.exit(failed ? 1 : 0);
