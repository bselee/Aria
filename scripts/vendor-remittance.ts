/**
 * @file    scripts/vendor-remittance.ts
 * @purpose Vendor-facing payment detail: which payments went out in a period
 *          and which invoices each one covered, from Bill.com exports.
 * @author  Hermia
 * @created 2026-11-02
 * @deps    src/lib/ap/payments-out, src/lib/ap/overdue-bills, Chrome headless
 * @env     none (no Gmail; this never sends)
 *
 * Usage:
 *   node --import tsx scripts/vendor-remittance.ts \
 *     --vendor="AAA Cooper" --csv="<AllBills.csv>" --payments="<payments_out.csv>" \
 *     --from=2026-10-26 --to=2026-11-01
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { applyPayments, parsePaymentsCsv } from "../src/lib/ap/payments-out";
import { esc, money, parseBillsCsv, md } from "../src/lib/ap/overdue-bills";

const ARIA = path.resolve(__dirname, "..");
const REPORTS = path.join(ARIA, "reports");

/** Render an HTML file to PDF with headless Chrome. */
function chromePdf(htmlPath: string, pdfPath: string): void {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const result = spawnSync(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`chrome pdf failed: ${result.stderr || result.stdout || result.status}`);
  }
}

/** Slug for file names. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const CSS = `
  @page { size: Letter; margin: 0.5in; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 9.5pt; line-height: 1.3; color: #222; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2px 0; font-weight: 600; }
  .meta { font-size: 8.5pt; color: #666; margin-bottom: 10px; }
  h2 { font-size: 10.5pt; margin: 14px 0 4px 0; padding-bottom: 2px; border-bottom: 1px solid #ddd; font-weight: 600; page-break-after: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 0 0 4px 0; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #555; color: #fff; text-align: left; padding: 4px 6px; font-weight: 600; }
  td { padding: 3px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  tr:nth-child(even) td { background: #f8f8f8; }
  .amt { text-align: right; white-space: nowrap; }
  th.amt { text-align: right; }
  .total-row td { font-weight: 600; background: #eee !important; }
  .sub td { background: #f2f2f2 !important; font-weight: 600; }
  .foot { font-size: 8.5pt; color: #666; margin-top: 16px; }
  .note { font-size: 9pt; margin: 6px 0 0 0; }
`;

async function main(): Promise<void> {
  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  const vendorArg = arg("vendor") || "AAA Cooper";
  const csvPath = arg("csv");
  const paymentsPath = arg("payments");
  const from = arg("from");
  const to = arg("to");
  if (!csvPath || !paymentsPath || !from || !to) {
    throw new Error("--csv, --payments, --from and --to are required");
  }

  const bills = parseBillsCsv(fs.readFileSync(csvPath, "utf8"));
  const payments = parsePaymentsCsv(fs.readFileSync(paymentsPath, "utf8"));
  const key = vendorArg.trim().toLowerCase();
  const matches = (name: string): boolean => (name || "").trim().toLowerCase().startsWith(key);

  const vendorBills = bills.filter((b) => matches(b.vendor));
  if (vendorBills.length === 0) throw new Error(`No bills found for vendor "${vendorArg}"`);

  const vendorName = vendorBills[0].vendor;
  const allocation = applyPayments(bills, payments, from);
  const inPeriod = allocation.rows
    .filter(
      (r) =>
        matches(r.payment.vendor) &&
        r.payment.processDate >= from &&
        r.payment.processDate <= to,
    )
    .sort((a, b) => a.payment.processDate.localeCompare(b.payment.processDate));

  if (inPeriod.length === 0) throw new Error(`No payments for ${vendorName} between ${from} and ${to}`);

  const paidTotal = inPeriod.reduce((a, r) => a + r.applied, 0);
  const openRemaining = vendorBills.reduce(
    (a, b) => a + Math.max(0, b.balanceDue - (allocation.paidByBill.get(
      `${b.vendor}|${b.invoiceNo}|${b.dueDate}|${b.balanceDue}`,
    ) ?? 0)),
    0,
  );
  const openCount = vendorBills.filter(
    (b) =>
      b.balanceDue -
        (allocation.paidByBill.get(`${b.vendor}|${b.invoiceNo}|${b.dueDate}|${b.balanceDue}`) ?? 0) >
      0.005,
  ).length;

  const parts: string[] = [];
  parts.push(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>`);
  parts.push(`<h1>Payment Detail — ${esc(vendorName)}</h1>`);
  parts.push(
    `<div class="meta">BuildASoil · payments processed ${md(from)} to ${md(to)} · vendor remittance</div>`,
  );

  parts.push(`<h2>Payments Sent</h2>`);
  parts.push(`<table>
  <thead><tr><th>Processed</th><th>Method</th><th>Reference</th><th>Status</th><th>Arrives</th><th class="amt">Amount</th></tr></thead>
  <tbody>`);
  for (const row of inPeriod) {
    parts.push(
      `<tr><td>${md(row.payment.processDate)}</td><td>${esc(row.payment.method)}</td><td>${esc(
        row.payment.confirmation,
      )}</td><td>${esc(row.payment.status)}</td><td>${md(row.payment.arrivalDate)}</td><td class="amt">${money(
        row.applied,
      )}</td></tr>`,
    );
  }
  parts.push(
    `<tr class="total-row"><td colspan="5">Total sent</td><td class="amt">${money(paidTotal)}</td></tr>`,
  );
  parts.push(`</tbody></table>`);

  parts.push(`<h2>Invoices Covered</h2>`);
  parts.push(
    `<p class="note">Each payment above was applied to the invoices below, oldest first. Amounts are net of any vendor credit.</p>`,
  );
  parts.push(`<table>
  <thead><tr><th>Payment</th><th>Invoice / PRO #</th><th>Invoice date</th><th>Due date</th><th class="amt">Invoice amount</th><th class="amt">Applied</th></tr></thead>
  <tbody>`);
  let invoiceCount = 0;
  for (const row of inPeriod) {
    for (const alloc of row.allocations) {
      invoiceCount += 1;
      parts.push(
        `<tr><td>${md(row.payment.processDate)}</td><td>${esc(alloc.bill.invoiceNo)}</td><td>${md(
          alloc.bill.invoiceDate,
        )}</td><td>${md(alloc.bill.dueDate)}</td><td class="amt">${money(
          alloc.bill.balanceDue,
        )}</td><td class="amt">${money(alloc.amount)}</td></tr>`,
      );
    }
  }
  parts.push(
    `<tr class="total-row"><td colspan="5">${invoiceCount} invoices · total applied</td><td class="amt">${money(
      paidTotal,
    )}</td></tr>`,
  );
  parts.push(`</tbody></table>`);

  parts.push(
    `<h2>Account Status</h2>
     <table>
       <thead><tr><th>Remaining open invoices</th><th class="amt">Count</th><th class="amt">Balance</th></tr></thead>
       <tbody><tr><td>Open balance after these payments</td><td class="amt">${openCount}</td><td class="amt">${money(
         openRemaining,
       )}</td></tr></tbody>
     </table>`,
  );

  parts.push(
    `<div class="foot">Questions on this statement: Bill Selee · bill.selee@buildasoil.com · BuildASoil. ` +
      `Generated ${new Date().toLocaleDateString("en-US", { timeZone: "America/Denver" })}.</div>`,
  );
  parts.push(`</body></html>`);

  fs.mkdirSync(REPORTS, { recursive: true });
  const stem = `remittance-${slug(vendorName)}-${from}`;
  const htmlPath = path.join(REPORTS, `${stem}.html`);
  const pdfPath = path.join(REPORTS, `${stem}.pdf`);
  fs.writeFileSync(htmlPath, parts.join("\n"));
  chromePdf(htmlPath, pdfPath);

  console.log(`WROTE ${pdfPath}`);
  console.log(`${inPeriod.length} payments ${money(paidTotal)} · ${invoiceCount} invoices`);
  console.log(`open after ${openCount} invoices ${money(openRemaining)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
