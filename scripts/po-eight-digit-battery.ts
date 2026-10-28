/**
 * Adversarial battery — 8-digit dropship PO extraction and base gating.
 *
 * Target: extractPONumbersFromText widened to (\d{8}[A-Z]?|\d{5,7}) plus a bare
 * 2\d{7}[A-Z]? branch, and resolveExtractedPOs gating every 8-digit candidate on
 * a purchase_orders base match.
 *
 * The risk this must fail on: an 8-digit number is the shape of BOTH a real
 * dropship PO and a Finale SALES_ORDER, and the bare branch reads numbers with no
 * label at all. If gating leaks, class 11 comes back through a new door.
 *
 * Run: "/c/Program Files/nodejs/node" --import tsx --env-file=.env.local scripts/po-eight-digit-battery.ts
 */
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { extractPONumbersFromText } from "../src/lib/tracking/email-tracking-ingest";
import { extractPONumberFromText } from "../src/lib/tracking/invoice-tracking-bridge";
import { resolveExtractedPOs, resolveDropshipPOByBase } from "../src/lib/purchasing/po-ref-validator";

type Case = { name: string; got: unknown; want: unknown };
const cases: Case[] = [];
const check = (name: string, got: unknown, want: unknown) => cases.push({ name, got, want });

// real bodies, verbatim shape from gmail ap messages 1a18252b49f9207c / 1a1824fcf9025a42
const BODY_248317 =
    "Your invoice is ready!\n BALANCE DUE $189.03 View and pay 23578097A\n 23578097A UPS - 1Z22YV580360242374";
const BODY_248343 =
    "Your invoice is ready!\n BALANCE DUE $66.05 View and pay 23581487\n 23581487 UPS - 1Z22YV580358574887";

// real OCR, from ap_local_forwards
const db = new Database("aria-local.db", { readonly: true });
const ocr: Record<string, string> = {};
for (const id of ["1a16c4a2f0550ba0", "1a180d27ed8d16fb"]) {
    const row = db.prepare("select ocr_raw_text from ap_local_forwards where gmail_message_id = ?").get(id) as
        | { ocr_raw_text?: string }
        | undefined;
    if (row?.ocr_raw_text) ocr[id] = row.ocr_raw_text;
}
db.close();

(async () => {
    // ═══ A. raw extraction ═══════════════════════════════════════════════════
    check("A autopot 248317 body", extractPONumbersFromText(BODY_248317), ["23578097A"]);
    check("A autopot 248343 body", extractPONumbersFromText(BODY_248343), ["23581487"]);
    check("A label + letter suffix", extractPONumbersFromText("P.O. Number 23578097A"), ["23578097A"]);
    check(
        "A full suffixed spelling",
        extractPONumbersFromText("PO 23578097A-DropshipPO shipped via UPS 1Z22YV580360242374"),
        ["23578097A"],
    );
    check("A six-digit still works", extractPONumbersFromText("Purchase Order # 125333"), ["125333"]);
    check(
        "A both widths in one message",
        extractPONumbersFromText("PO 125333\n23581487 UPS - 1Z22YV580358574887"),
        ["125333", "23581487"],
    );

    // negatives: shipment refs and non-PO digit runs must not become candidates
    check(
        "A AAA freight text (PRO + B.L. + ADV ORDER)",
        extractPONumbersFromText(
            "PRO NUMBER 64058931\n1159492DATE 10/15/26\nP.O.NUMBER\nB.L.NUMBER\nADV\nORDER 4798\n18700362",
        ),
        [],
    );
    check("A nine-digit run", extractPONumbersFromText("PO 235780971"), []);
    check("A two letters after digits", extractPONumbersFromText("P.O. Number 23578097AB"), []);
    check("A ups number", extractPONumbersFromText("UPS 1Z22YV580358574887"), []);
    check("A phone number", extractPONumbersFromText("call 702-338-0373"), []);
    check("A twelve-digit fedex", extractPONumbersFromText("FedEx 772727123456"), []);

    // ═══ B. gating on purchase_orders base ══════════════════════════════════
    check("B letter-suffix base", await resolveExtractedPOs(["23578097A"]), ["23578097A-DropshipPO"]);
    check("B bare base -> -S variant", await resolveExtractedPOs(["23581487"]), ["23581487-S-DropshipPO"]);
    check("B cancelled sales order", await resolveExtractedPOs(["23566017"]), []);
    check("B AAA 8-digit PRO", await resolveExtractedPOs(["64058931"]), []);
    check("B AAA PRO with check suffix", await resolveExtractedPOs(["71473626"]), []);
    check("B yyyymmdd date", await resolveExtractedPOs(["20261028"]), []);
    check("B six-digit passthrough", await resolveExtractedPOs(["125333"]), ["125333"]);
    check(
        "B dedupe base vs full spelling",
        await resolveExtractedPOs(["23581487", "23581487-S-DropshipPO"]),
        ["23581487-S-DropshipPO"],
    );
    check(
        "B determinism (same input twice)",
        [
            await resolveDropshipPOByBase("23578097"),
            await resolveDropshipPOByBase("23578097"),
        ],
        ["23578097A-DropshipPO", "23578097A-DropshipPO"],
    );
    // Known gap, asserted so a future change is visible: 5-7 digit junk passes through
    // ungated (the ingest has no validatePoRef call). Not a regression from this change.
    check("B KNOWN-GAP seven-digit junk passes", await resolveExtractedPOs(["9477993"]), ["9477993"]);

    // KNOWN-GAP, asserted as today's behavior so the resolver change has to touch
    // this line and declare its intent: a candidate whose letter matches no PO
    // spelling resolves to whatever row shares the base. Tolerable while every
    // base has exactly one row (OCR mangles letters — S/5, B/8, A/4), wrong the
    // moment a base carries two spellings. Flip these to [] with the ambiguity
    // hardening.
    check("B KNOWN-GAP wrong letter -> sibling spelling", await resolveExtractedPOs(["23581487B"]), [
        "23581487-S-DropshipPO",
    ]);
    check("B KNOWN-GAP wrong letter -> sibling spelling 2", await resolveExtractedPOs(["23578097B"]), [
        "23578097A-DropshipPO",
    ]);

    // ═══ C. real statements through both layers ═════════════════════════════
    for (const [id, label] of [
        ["1a16c4a2f0550ba0", "statement 2938"],
        ["1a180d27ed8d16fb", "statement 2886"],
    ] as const) {
        const text = ocr[id];
        check(`C ${label}: text present`, !!text, true);
        if (text) {
            const raw = extractPONumbersFromText(text);
            check(`C ${label}: raw candidates`, raw, []);
            check(`C ${label}: after gating`, await resolveExtractedPOs(raw), []);
        }
    }

    // ═══ D. documented sibling gap (not this commit's scope) ════════════════
    check("D bridge extractor still blind to 8-digit", extractPONumberFromText(BODY_248343), null);

    // ─── verdict ─────────────────────────────────────────────────────────────
    const defects = cases.filter((c) => JSON.stringify(c.got) !== JSON.stringify(c.want));
    console.log(`\n${cases.length} cases, ${defects.length} defect(s)\n`);
    for (const d of defects) {
        console.log(`DEFECT ${d.name}\n        got  ${JSON.stringify(d.got)}\n        want ${JSON.stringify(d.want)}`);
    }
    if (defects.length === 0) console.log("BATTERY GREEN — 8-digit extraction is gated and the sales-order door stays shut.");
    else console.log(`\nBATTERY RED — ${defects.length} of ${cases.length} cases fail.`);
    process.exit(defects.length === 0 ? 0 : 1);
})().catch((e) => {
    console.error("ERR", e?.message || e);
    process.exit(2);
});
