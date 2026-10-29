// Capture a real AAA Cooper PRO page to a fixture file so the "throttle is
// silence" case is pinned against observed bytes, not a guess.
//
//   node --import tsx scripts/_capture-aaa-fixture.ts <PRO> <outfile>
import { writeFileSync } from "fs";

const pro = process.argv[2];
const out = process.argv[3];
const url = `https://www.aaacooper.com/pwb/Transit/ProTrackResults.aspx?ProNum=${pro}&AllAccounts=true`;

(async () => {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    const html = await res.text();
    const text = html
        .replace(/<script[\s\S]*?<\/script/gi, " ")
        .replace(/<style[\s\S]*?<\/style/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    writeFileSync(out, text, "utf8");
    const hasTracing = /Tracing Information/i.test(text);
    const hasDeliveryBlock = /Delivery Date Time/i.test(text);
    console.log(`http ${res.status} bytes ${html.length} -> ${out}`);
    console.log(`hasTracingBlock=${hasTracing} hasDeliveryBlock=${hasDeliveryBlock}`);
    console.log(
        hasTracing
            ? "REAL tracking page captured"
            : "bare chrome page — this is the throttle fixture (silence, not in transit)",
    );
})();
