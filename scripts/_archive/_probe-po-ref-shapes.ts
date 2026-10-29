// Can a "PO-"-prefixed or fully dashed ref ever reach the -S- gate? Trace the
// extractor's capture groups through resolveExtractedPOs on real-world strings.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { extractPONumbersFromText } from "../src/lib/tracking/email-tracking-ingest";
import { resolveExtractedPOs } from "../src/lib/purchasing/po-ref-validator";

const cases = [
    "P.O. 23582767-S-DropshipPO shipped today",
    "PO # 23582767-S-DropshipPO",
    "23582767-S-DropshipPO",
    "PO-23582767-S-DropshipPO",
    "P.O. NUMBER 23582767",
    "P.O. NO. 23580437-DropshipPO",
    "ORDER 4808",
    "PO 125333",
    "23578097A-DropshipPO",
];

(async () => {
    for (const t of cases) {
        const raw = extractPONumbersFromText(t);
        let resolved: string[] = [];
        try { resolved = await resolveExtractedPOs(raw); } catch (e: any) { resolved = ["ERR:" + e.message]; }
        console.log(`${JSON.stringify(t)}\n    raw=${JSON.stringify(raw)}  resolved=${JSON.stringify(resolved)}`);
    }
    // The invariant only holds if every emitted ref that starts with a non-digit
    // is a stored spelling. Show the non-digit emissions specifically.
    const nondigit = new Set<string>();
    for (const t of cases) for (const r of extractPONumbersFromText(t)) if (!/^\d/.test(r)) nondigit.add(r);
    console.log(`non-digit refs emitted by the extractor: ${JSON.stringify([...nondigit])}`);
})();
