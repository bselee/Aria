/**
 * @file    scripts/_battery-glue-guard.ts
 * @purpose Adversarial battery for `recoverTrackingNumber` (PDF column-glue recovery in
 *          src/lib/carriers/tracking-service.ts). Positive cases must recover the real carrier
 *          number; negatives must be left EXACTLY as they are (null) — a recovery that truncates a
 *          clean number corrupts a live parcel and is worse than the bug it fixes.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/_battery-glue-guard.ts
 */
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { recoverTrackingNumber, extractTrackingNumbers } from "../src/lib/carriers/tracking-service";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(`${label}: got ${a} want ${e}`);
    console.log(`  FAIL  ${label} -> got ${a} want ${e}`);
  }
}

console.log("\n== A. positives: glued tokens must recover the real number ==");
eq("Evergreen 5204849085531ea56", recoverTrackingNumber("5204849085531ea56"), "520484908553");
eq("sibling 5204849077191ea64", recoverTrackingNumber("5204849077191ea64"), "520484907719");
eq("sibling 5204848926311ea59", recoverTrackingNumber("5204848926311ea59"), "520484892631");
eq("15-digit FedEx Ground + glue", recoverTrackingNumber("1234567890123451ea56"), "123456789012345");
eq("UPS 1Z+16 + glue", recoverTrackingNumber("1Z999AA101234567841ea56"), "1Z999AA10123456784");
eq("DHL JD+18 + glue", recoverTrackingNumber("JD01460000628123092811ea56"), "JD014600006281230928");
eq("USPS 22 + glue", recoverTrackingNumber("94001112062123456789011ea56"), "9400111206212345678901");
eq("SmartPost 20 + glue", recoverTrackingNumber("960011120621234567891ea56"), "96001112062123456789");

console.log("\n== B. negatives: clean tokens must be left alone ==");
eq("FedEx 12 clean", recoverTrackingNumber("520484908553"), null);
eq("FedEx 15 clean", recoverTrackingNumber("123456789012345"), null);
eq("USPS 22 clean", recoverTrackingNumber("9400111206212345678901"), null);
eq("USPS 26 clean (long IMpb)", recoverTrackingNumber("94001112062123456789012345"), null);
eq("SmartPost 20 clean", recoverTrackingNumber("96001112062123456789"), null);
eq("UPS 18 exact", recoverTrackingNumber("1Z999AA10123456784"), null);
eq("DHL 20 exact", recoverTrackingNumber("JD014600006281230928"), null);
eq("AAA PRO 64058928", recoverTrackingNumber("64058928"), null);
eq("Certis PRO 2130919952", recoverTrackingNumber("2130919952"), null);
eq("estimate 276170239-1", recoverTrackingNumber("276170239-1"), null);
eq("bare 23576187 sales order", recoverTrackingNumber("23576187"), null);

console.log("\n== C. adversarial: token where the tail is genuinely not glue ==");
// A real number with a trailing unit that the pattern absorbed: still must keep the number.
eq("12-digit + bare 'ea'", recoverTrackingNumber("520484908553ea"), "520484908553");
// Digit runs with NO letter tail are never glue (pure digits are handled by B).
const ambiguous13 = recoverTrackingNumber("1234567890123ea56");
console.log(`  NOTE  13-digit run + letter tail -> ${JSON.stringify(ambiguous13)} (no 13-digit carrier family exists)`);
const ambiguous18 = recoverTrackingNumber("123456789012345678ea56");
console.log(`  NOTE  18-digit run + letter tail -> ${JSON.stringify(ambiguous18)} (sliced to Ground-15; drops 3 digits)`);
const longUsps = recoverTrackingNumber("94001112062123456789012345ea");
console.log(`  NOTE  26-digit USPS + letter tail -> ${JSON.stringify(longUsps)} (sliced to 22; drops 4 digits)`);

console.log("\n== D. integration: extractTrackingNumbers over real document text ==");
const pdf = "tmp_bol/1a164340513f3823_Inv_151119_from_Evergreen_Growers_Supply_LLC._23316.pdf";
if (existsSync(pdf)) {
  const layout = execSync(`pdftotext -layout "${pdf}" -`, { encoding: "utf8" });
  const collapsed = execSync(`pdftotext "${pdf}" -`, { encoding: "utf8" });

  const l = extractTrackingNumbers(layout).map((h) => h.trackingNumber);
  const c = extractTrackingNumbers(collapsed).map((h) => h.trackingNumber);
  console.log(`  layout    -> ${JSON.stringify(l.slice(0, 5))}`);
  console.log(`  collapsed -> ${JSON.stringify(c.slice(0, 5))}`);

  const anyGlued = (arr: string[]) => arr.some((n) => /1ea\d{2}$/i.test(n));
  eq("layout: no glued token emitted", anyGlued(l), false);
  eq("collapsed: no glued token emitted", anyGlued(c), false);
  eq("layout: real 520484908553 present", l.includes("520484908553"), true);
  eq("collapsed: real 520484908553 present", c.includes("520484908553"), true);
} else {
  console.log("  SKIP  invoice PDF not on disk");
}

console.log("\n== E. integration: syntactically glued email body ==");
const body = [
  "Evergreen Growers Supply invoice 151119",
  "Shipping-FedEx S/H - FedEx Tracking # 5204849085531ea56",
  "P.O. NO. 23576187    Ship Via: FedEx",
].join("\n");
const got = extractTrackingNumbers(body).map((h) => h.trackingNumber);
console.log(`  body -> ${JSON.stringify(got)}`);
eq("glued body yields real number", got.includes("520484908553"), true);
eq("glued body yields no glued token", got.some((n) => /1ea\d{2}$/i.test(n)), false);

console.log("\n== F. integration: must not corrupt other document classes ==");
const pod = "PRO NUMBER 2130919952  DELIVERY STATUS: Good Order  SKU# 154250  PO-125333  2,530";
const podNums = extractTrackingNumbers(pod).map((h) => h.trackingNumber);
console.log(`  pod -> ${JSON.stringify(podNums)}`);
eq("POD keeps PRO 2130919952 uncleaved", podNums.includes("2130919952"), true);

const upsAdjacent = "Tracking Number 1Z999AA10123456784   2 ea   56.16";
const upsNums = extractTrackingNumbers(upsAdjacent).map((h) => h.trackingNumber);
eq("adjacent-qty UPS intact", upsNums.includes("1Z999AA10123456784"), true);

console.log("\n== G. carrier label + dedupe after recovery ==");
const body2 = [
  "FedEx Tracking # 5204849085531ea56",
  "Reference: 520484908553 (clean copy printed elsewhere on the page)",
].join("\n");
const hits2 = extractTrackingNumbers(body2);
console.log(`  hits -> ${JSON.stringify(hits2)}`);
eq("glued+clean in one document dedupes to ONE hit", hits2.length, 1);
eq("surviving hit is the clean number", hits2[0]?.trackingNumber, "520484908553");

const carrierOf = (txt: string) => extractTrackingNumbers(txt).find((h) => h.trackingNumber === "520484908553")?.carrier;
console.log(`  carrier after recovery (glued only) -> ${carrierOf("FedEx Tracking # 5204849085531ea56")}`);
console.log(`  carrier after recovery (clean only) -> ${carrierOf("FedEx Tracking # 520484908553")}`);
eq(
  "recovered hit is labelled the same as the clean hit",
  carrierOf("FedEx Tracking # 5204849085531ea56"),
  carrierOf("FedEx Tracking # 520484908553"),
);


console.log(`\n=== battery: ${pass} passed, ${fail} failed ===`);
if (fail) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
