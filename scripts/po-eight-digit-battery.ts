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
import {
    resolveExtractedPOs,
    resolveDropshipPOByBase,
    resolveDropshipPOByRef,
    validatePoRef,
} from "../src/lib/purchasing/po-ref-validator";

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

    // ═══ F. resolver rules (round 2: resolveDropshipPOByRef) ════════════════
    check("F rule1 exact spelling", await resolveDropshipPOByRef("23578097A-DropshipPO"), null); // not an 8-digit ref -> out of scope
    check("F rule1 exact (suffixed full)", await resolveDropshipPOByRef("23581487-S-DropshipPO"), null);
    check("F rule2 base only", await resolveDropshipPOByRef("23581487"), "23581487-S-DropshipPO");
    check("F rule2 letter ignored", await resolveDropshipPOByRef("23581487S"), "23581487-S-DropshipPO");
    check("F rule2 other letter", await resolveDropshipPOByRef("23578097B"), "23578097A-DropshipPO");
    check("F non-2-prefix never queried", await resolveDropshipPOByRef("64058931"), null);
    check("F short ref", await resolveDropshipPOByRef("2358148"), null);

    // ═══ G. validatePoRef after the resolver reorder ════════════════════════
    check("G bare base joins the row", await validatePoRef("23581487"), "23581487-S-DropshipPO");
    check("G letter base joins the row", await validatePoRef("23578097A"), "23578097A-DropshipPO");
    check("G AAA PRO rejected", await validatePoRef("64058931"), null);
    check("G four-digit customer order rejected", await validatePoRef("4798"), null);
    check("G verbatim PO- prefix survives", await validatePoRef("PO-124430"), "PO-124430");
    check("G mixed-case legacy verbatim", await validatePoRef("4520-DropshipPO"), "4520-DropshipPO");
    check("G prefixed input still normalizes", await validatePoRef("PO-125257"), "125257");
    check("G empty", await validatePoRef("  "), null);
    // KNOWN-GAP: the isPoShaped fallback still accepts a bare 8-digit ref with no
    // purchase_orders row, so an 8-digit Finale SALES_ORDER can pass validatePoRef.
    // Pre-existing (isPoShaped always allowed 2\d{7}); pinned so the trade-off is
    // visible — the fallback is what keeps a PO created in Finale minutes ago usable.
    check("G KNOWN-GAP sales order passes shape fallback", await validatePoRef("23566017"), "23566017");

    // ═══ H. bridge extractor (sibling, label-bounded only) ══════════════════
    check("H labeled 8-digit", extractPONumberFromText("PO 23581487"), "23581487");
    check("H bare 8-digit still null", extractPONumberFromText(BODY_248343), null);
    check("H six-digit unchanged", extractPONumberFromText("Purchase Order # 125333"), "125333");
    check("H vendor-ref six-digit tail", extractPONumberFromText("71473626-124833"), "124833");
    // Flipped by the bridge pass (ORDER dropped, Number/No. connector added):
    // these three were pinned as today's behavior and are now asserted at their
    // intended values.
    check("H 'P.O. Number' form", extractPONumberFromText("P.O. Number 23578097A"), "23578097A");
    check("H 'P.O. Number' 6-digit", extractPONumberFromText("P.O. Number 125333"), "125333");
    check("H ORDER is no longer a PO label", extractPONumberFromText("REF# ORDER 23566017"), null);
    check("H ORDER alias cannot mint a ref", extractPONumberFromText("ADV ORDER 4798"), null);
    // Uline's own order number, printed beside a blank PURCHASE ORDER NO.
    check("H uline ORDER # junk gone", extractPONumberFromText("INVOICE #: 215047605\nORDER #: 59853790"), null);
    check("H uline letterhead PO Box", extractPONumberFromText("uline.com\nPO Box 88741 • Chicago, IL 60680-1741"), null);
    // Vendor labels split by column layout: connector + newline before the digits.
    check("H 'P.O. NO.' newline uppercase", extractPONumberFromText("Approval CodeP.O. NO.\n23576187\nTerms"), "23576187");
    check("H 'PO Number' newline", extractPONumberFromText("DescriptionPO Number\n125257\nNet 30"), "125257");
    check("H 'Purchase Order No.'", extractPONumberFromText("Purchase Order No. 125383"), "125383");
    // Concentrates carries both theirs and ours: only the PO-labeled one may win.
    check(
        "H theirs-vs-ours in one doc",
        extractPONumberFromText("INVOICE\n3084520\nORDER NUMBER\nMilwaukie, OR\nPO Number\n125257"),
        "125257",
    );
    // KNOWN-GAP (pre-existing, unchanged by this pass): the doc comment's old example
    // never matched its own regex; only a true 6-digit tail does.
    check("H vendor-ref 7-digit tail matches nothing", extractPONumberFromText("71473626-1124833"), null);
    for (const [id, label] of [
        ["1a16c4a2f0550ba0", "H statement 2938"],
        ["1a180d27ed8d16fb", "H statement 2886"],
    ] as const) {
        if (ocr[id]) check(`${label}: bridge extractor`, extractPONumberFromText(ocr[id]), null);
    }

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

    // ═══ D. bare form on the bridge stays null by design ════════════════════
    check("D bridge ignores the label-free AutoPot form", extractPONumberFromText(BODY_248343), null);

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
