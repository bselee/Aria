// @file    src/cli/reconcile-billcom.ts
// @purpose MANUAL reconciliation CLI (2026-09-02: promoted from scratch probe).
//          Import Bill's fresh All Bills CSV exports from
//          ~/Downloads/Aria-Ingest/billcom/, then reconcile every FORWARDED
//          invoice against them to find what genuinely didn't land in
//          Bill.com. Manual as-needed only — never scheduled.
// @usage   node --import tsx src/cli/reconcile-billcom.ts
// @deps    import-billcom-ref (importCsvFile), billcom-verify (sweep), local-db
// @env     none (SQLite only)
import { importCsvFile } from "./import-billcom-ref";
import { runForwardVerificationSweep } from "../lib/intelligence/ap/billcom-verify";
import { getLocalDb } from "../lib/storage/local-db";
import { deriveCanonicalVendorName, extractInvoiceNumber } from "../lib/intelligence/ap/vendor-invoice-patterns";
import fs from "fs";
import path from "path";

const DIR = path.resolve(process.env.USERPROFILE || "~", "Downloads", "Aria-Ingest", "billcom");

async function main() {
  // 1. Import the three fresh exports (page 1/2/3 of ~100 rows each).
  const files = ["AllBillsPage (1).csv", "AllBillsPage (2).csv", "AllBillsPage (3).csv"];
  for (const f of files) {
    const p = path.join(DIR, f);
    if (fs.existsSync(p)) {
      await importCsvFile(p);
    } else {
      console.log(`MISSING ${p}`);
    }
  }

  const db = getLocalDb();
  const ref = db
    .prepare("SELECT vendor_name, invoice_number, invoice_amount, invoice_date, created_at FROM billcom_bills_ref")
    .all() as Array<{ vendor_name: string; invoice_number: string; invoice_amount: number | null; invoice_date: string | null; created_at: string | null }>;

  console.log(`\n=== billcom_bills_ref after import: ${ref.length} rows ===`);
  console.log("newest invoice_date:", db.prepare("SELECT MAX(invoice_date) m FROM billcom_bills_ref WHERE invoice_date IS NOT NULL AND invoice_date != ''").get().m);

  // Build normalized lookup: vendor -> set of normalized invoice#s
  const normV = (s: string) =>
    s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|llc|l\.l\.c|ltd|co|corp|company|incorporated)\b/g, " ").replace(/[^a-z0-9]+/g, "").trim();
  const normI = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");

  const refMap = new Map<string, Map<string, { n: string; amt: number | null; d: string | null }>>();
  for (const r of ref) {
    const v = normV(r.vendor_name ?? "");
    const n = normI(r.invoice_number ?? "");
    if (!v || !n) continue;
    if (!refMap.has(v)) refMap.set(v, new Map());
    refMap.get(v)!.set(n, { n: r.invoice_number, amt: r.invoice_amount, d: r.invoice_date });
  }

  // 2. Every FORWARDED row (last 45 days) — full reconciliation, no filtering.
  const fwds = db
    .prepare(
      `SELECT id, email_from, email_subject, ocr_vendor_name, ocr_invoice_number, forwarded_at
       FROM ap_local_forwards
       WHERE status='FORWARDED' AND forwarded_at >= datetime('now', '-45 days')
       ORDER BY forwarded_at DESC`,
    )
    .all() as Array<{ id: number; email_from: string | null; email_subject: string | null; ocr_vendor_name: string | null; ocr_invoice_number: string | null; forwarded_at: string }>;

  const missing: string[] = [];
  const landed: string[] = [];
  const noIdentity: string[] = [];
  for (const f of fwds) {
    const from = f.email_from ?? "";
    const subj = f.email_subject ?? "";
    let vendor = from ? (deriveCanonicalVendorName(from) ?? "").trim() : "";
    if (!vendor) vendor = (f.ocr_vendor_name ?? "").trim();
    let inv = (f.ocr_invoice_number ?? "").trim();
    const fromSubj = extractInvoiceNumber(from, subj);
    if (fromSubj) inv = fromSubj.trim();
    if (inv.includes(",")) inv = "";

    const v = normV(vendor);
    const n = normI(inv);
    if (!v || !n) {
      noIdentity.push(`${f.forwarded_at?.slice(0,10)} | ${(subj || from).slice(0,60)}`);
      continue;
    }
    const hit = refMap.get(v)?.get(n);
    if (hit) {
      landed.push(`${f.forwarded_at?.slice(0,10)} | ${vendor} | ${inv} | Bill.com ${hit.n} $${hit.amt ?? "?"}`);
    } else {
      missing.push(`${f.forwarded_at?.slice(0,10)} | ${vendor} | ${inv} | subj: ${subj.slice(0,45)}`);
    }
  }

  console.log(`\n=== FORWARDED (last 45d): ${fwds.length} ===`);
  console.log(`LANDED (matched Bill.com): ${landed.length}`);
  console.log(`NO IDENTITY (vendor+inv# unrecoverable): ${noIdentity.length}`);
  console.log(`MISSING (no Bill.com bill): ${missing.length}`);

  console.log(`\n--- MISSING (${missing.length}) ---`);
  for (const m of missing) console.log(m);

  console.log(`\n--- NO IDENTITY (${noIdentity.length}) ---`);
  for (const m of noIdentity) console.log(m);

  console.log(`\n--- LANDED sample (last 25) ---`);
  for (const m of landed.slice(0, 25)) console.log(m);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
