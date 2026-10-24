/**
 * @file    scripts/estimate-ref-battery.ts
 * @purpose Adversarial acceptance harness for the rating-estimate exclusion
 *          (`isRatingEstimateRef` = /^\d{9}-1$/) in `src/lib/carriers/tracking-service.ts`
 *          and its second enforcement point, the `ltl_pro_suffix` supplementary pass in
 *          `src/lib/tracking/email-tracking-ingest.ts`.
 *
 *          The defect: AAA Cooper prints an 8-digit `PRO NUMBER` and a 9-digit `ESTIMATE NUMBER: nnnnnnnnn-1`
 *          in the same OCR column band. The canonical extractor dropped the estimate via a label check, but
 *          the suffix pass re-scanned the raw text and re-added it as `ltl_pro_suffix`, creating 45 shipment
 *          rows that are not parcels.
 *
 *          A recovery/exclusion guard is only accepted when the POSITIVES still come through untouched:
 *          a guard that also eats a real 8-digit AAA PRO with its `-1` suffix, or a pure 9/10-digit LTL PRO,
 *          is worse than the defect it fixes.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/estimate-ref-battery.ts
 */
import {
  extractTrackingNumbers,
  isRatingEstimateRef,
  TRACKING_PATTERNS,
} from "../src/lib/carriers/tracking-service";

let pass = 0;
const defects: string[] = [];
const notes: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    return;
  }
  defects.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const nums = (t: string) => extractTrackingNumbers(t).map((e) => e.trackingNumber);
const has = (t: string, n: string) => nums(t).includes(n);

// ── Section A: isRatingEstimateRef truth table ────────────────────────────────────────────────────
console.log("\nA. isRatingEstimateRef truth table");
for (const n of [
  "278411572-1",
  "276170239-1",
  "268244264-1",
  "269178799-1",
  "270404873-1",
  "275691812-1",
  "123456789-1",
]) {
  check(`A true ${n}`, isRatingEstimateRef(n) === true, "expected rejection");
}
for (const n of [
  "71473626-1", // AAA Cooper 8-digit PRO with a -1 check suffix — a REAL shipment
  "64058931",
  "64058928",
  "278411572", // estimate without the suffix is not an estimate ref
  "278411572-2",
  "1234567890-1",
  "1Z999AA10123456784",
  "520484908553",
  "9400111899223814512345",
  "",
]) {
  check(`A false ${JSON.stringify(n)}`, isRatingEstimateRef(n) === false, "must NOT be rejected");
}
// Documented, not a defect: the predicate is anchored and does not trim. Callers pass regex captures,
// so leading whitespace cannot reach it — but flag it so nobody "improves" it into /\s*\d{9}-1\s*$/.
notes.push(
  `A. anchored+untrimmed by design: " 278411572-1" → ${isRatingEstimateRef(" 278411572-1")} (callers pass regex captures)`,
);

// ── Section B: the real statement text ───────────────────────────────────────────────────────────
console.log("\nB. Real AAA Cooper statement 2938 (scanned BOL, vision OCR)");
// Verbatim lines from the OCR of tmp_bol/1a16c4a2f0550ba0_ACT_STMD_ID_2938.PDF
const STATEMENT_2938 = `ACT
AAA COOPER
TRANSPORTATION
SHIPPER
BUILDASOIL
5146 N TOWNSEND AVE
ATTN BUILDASOIL FREIGHT
MONTROSE, CO 81401-0817
CONSIGNEE
NEW EARTH
9806 TAYLORSVILLE RD
ATTN MICHAEL DAVIDSON
LOUISVILLE, KY 40299-0315
Pieces
Plthm
1 1
1
3746570
INVOICE
CUSTOMER NUMBER
1159492
BILL TO
BUILDASOIL
5016 N TOWNSEND AVE
MONTROSE, CO 81401-0000
PRO NUMBER
64058931
1159492DATE
10/15/26
ORIGIN
GJT
DEST
LOU
1740269
P.O.NUMBER
B.L.NUMBER
ADV
ORDER 4798
18700362
$.00
CUSTOMER NUMBER: NS
BEYOND
$.00
ADVANCE CARRIER
AACT
BEYOND ROUTE
$.00
NMFC-Sub
Class Weight
Rate
Charges
70
891
219.22
$1,953.25 AS
1000
109
219.22
$238.95 DEF
Description
1 PC BUILD A SOIL PRODUCTS-SOI
DEFICIT WEIGHT
NUTRIENTS, AMENDMENTS
48X40X44IN
DIMENSIONS INCLUDED
CPH# 502-261-0005
STANDARD RATE
REF# ORDER 4798
DO NOT DOUBLE STACK
LIFTGATE DELIVERY
APPOINTMENT DELIVERY REQUIRED
ESTIMATE NUMBER: 278411572-1
NOTIFY CHARGE
DISCOUNT 94.16%
FUEL SURCHARGE @ 53.70%
** WNI @ DEN **
** DIMENSIONED @ DEN **
PCS TTL ( 1 ON 1 PLT)
If you have rating questions
about this shipment please email
ratedispute@aaacooper.com
$60.00
$23.50
-$2,064.18
$68.75
*Prepaid*
1000
$280.27 PPD
REMIT TO: P. O. Box 935003`;

const stmt = nums(STATEMENT_2938);
console.log(`   extractor output: ${JSON.stringify(extractTrackingNumbers(STATEMENT_2938))}`);
check("B. real PRO 64058931 extracted", stmt.includes("64058931"), `got ${JSON.stringify(stmt)}`);
check("B. estimate 278411572-1 NOT extracted", !stmt.includes("278411572-1"), `got ${JSON.stringify(stmt)}`);
check("B. customer order 4798 not a tracking", !stmt.includes("4798"));
check("B. B.L. number 18700362 not a tracking", !stmt.includes("18700362"));
// The authoritative statement PRO must survive with an LTL carrier label, not fall back to generic.
const stmtEntry = extractTrackingNumbers(STATEMENT_2938).find((e) => e.trackingNumber === "64058931");
check("B. 64058931 labelled LTL/pro, not generic", !!stmtEntry && stmtEntry.carrier !== "generic", JSON.stringify(stmtEntry));

// ── Section C: the ltl_pro_suffix pass must not re-add what the extractor dropped ────────────────
console.log("\nC. ltl_pro_suffix supplementary pass (email-tracking-ingest.ts)");
// Mirrors the shipped condition verbatim: matchAll(ltlPro) → num && !isRatingEstimateRef(num) && not already present
function suffixPassAdds(text: string, withGuard: boolean): string[] {
  const extracted = extractTrackingNumbers(text);
  const added: string[] = [];
  for (const m of Array.from(text.matchAll(new RegExp(TRACKING_PATTERNS.ltlPro, "gi")))) {
    const num = m[1] || m[0];
    const guardOk = withGuard ? !isRatingEstimateRef(num) : true;
    if (num && guardOk && !extracted.some((e) => e.trackingNumber === num)) added.push(num);
  }
  return added;
}
const preFix = suffixPassAdds(STATEMENT_2938, false);
const postFix = suffixPassAdds(STATEMENT_2938, true);
console.log(`   pre-fix added: ${JSON.stringify(preFix)} | post-fix added: ${JSON.stringify(postFix)}`);
check("C. pre-fix reproduced the defect", preFix.includes("278411572-1"), `pre-fix ${JSON.stringify(preFix)}`);
check("C. post-fix adds no estimate", !postFix.includes("278411572-1"), `post-fix ${JSON.stringify(postFix)}`);
check("C. post-fix adds nothing at all on this doc", postFix.length === 0, JSON.stringify(postFix));

// Label-free shape rejection: the lookbehind matches "Reference Number:" too, so only the shape saves us.
const REF_NO_LABEL = "Reference Number: 278411572-1\nReference Number: 276170239-1";
check("C. label-free estimate refs not extracted", nums(REF_NO_LABEL).length === 0, JSON.stringify(nums(REF_NO_LABEL)));
check("C. label-free suffix pass adds nothing", suffixPassAdds(REF_NO_LABEL, true).length === 0);

// ── Section D: positives the guard must not touch ───────────────────────────────────────────────
console.log("\nD. Positives unchanged");
const POSITIVES: Array<[string, string, string]> = [
  ["AAA Cooper 8-digit PRO with -1 suffix", "AAA Cooper-71473626-1", "71473626-1"],
  ["AAA Cooper PRO NUMBER label", "PRO NUMBER 64058931", "64058931"],
  ["AAA statement, PRO + estimate together", "PRO NUMBER 64058928\nESTIMATE NUMBER: 276170239-1", "64058928"],
  ["Old Dominion 9-digit pure PRO", "PRO NUMBER 123456789", "123456789"],
  ["ABF 10-digit pure PRO", "PRO 1234567890", "1234567890"],
  ["UPS 1Z", "UPS tracking 1Z999AA10123456784", "1Z999AA10123456784"],
  ["DHL JD", "DHL JD011000000000000001", "JD011000000000000001"],
  ["FedEx 12", "FedEx tracking 123456789012", "123456789012"],
  ["FedEx Ground 15", "FedEx 520484908553999", "520484908553999"],
  ["USPS 22", "USPS 9400111899223814512345", "9400111899223814512345"],
];
for (const [label, text, expected] of POSITIVES) {
  check(`D. ${label}`, has(text, expected), `got ${JSON.stringify(nums(text))}`);
}
// An 8-digit-plus-"-1" AAA PRO must still be ADMITTED by the shape predicate's absence of match.
check("D. 71473626-1 passes isRatingEstimateRef", isRatingEstimateRef("71473626-1") === false);

// ── Section E: OCR whitespace and punctuation variants ──────────────────────────────────────────
console.log("\nE. OCR variants");
const VARIANTS: Array<[string, string]> = [
  ["double space after label", "ESTIMATE NUMBER:  278411572-1"],
  ["trailing period", "ESTIMATE NUMBER: 278411572-1."],
  ["parenthesised", "(278411572-1)"],
  ["hyphen spaced", "ESTIMATE NUMBER: 278411572 -1"],
  ["uppercase EST", "ESTIMATE NUMBER: 278411572-1 "],
];
for (const [label, text] of VARIANTS) {
  const got = nums(text);
  const leaked = got.filter((n) => /^\d{9}-1$/.test(n));
  check(`E. ${label} no estimate leak`, leaked.length === 0, `leaked ${JSON.stringify(leaked)} from ${JSON.stringify(got)}`);
  console.log(`   ${label}: ${JSON.stringify(got)}`);
}
// A visible suffix other than -1 is NOT the AAA estimate shape; record what happens so the next
// person knows the boundary of the guard rather than assuming full coverage.
const otherSuffix = nums("Reference Number: 278411572-2");
notes.push(`E. suffix boundary: "-2" refs → ${JSON.stringify(otherSuffix)} (guard is -1 only; AAA prints -1)`);

// ── Section F: a real shipment that merely sits near an estimate line ───────────────────────────
console.log("\nF. Mixed document — estimate present, real PRO must survive");
const MIXED = "PRO NUMBER 64058931\nESTIMATE NUMBER: 278411572-1\nReference Number: 276170239-1";
const mixedNums = nums(MIXED);
check("F. real PRO kept", mixedNums.includes("64058931"), JSON.stringify(mixedNums));
check("F. no estimate kept", mixedNums.every((n) => !/^\d{9}-1$/.test(n)), JSON.stringify(mixedNums));

// ── Result ─────────────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(78));
for (const n of notes) console.log(`note: ${n}`);
console.log(`\ncases passed: ${pass} | defects: ${defects.length}`);
if (defects.length) {
  for (const d of defects) console.log(`  DEFECT: ${d}`);
  process.exit(1);
}
console.log("BATTERY GREEN — estimate exclusion holds and every positive survives intact.");
