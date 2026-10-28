/**
 * @file    scripts/overdue-bills-report.ts
 * @purpose Bill.com overdue-bills report: age the All Bills CSV, lay out the
 *          Friday payment plan, render PDF, optionally email bill.selee@.
 * @author  Hermia
 * @created 2026-10-26
 * @deps    src/lib/ap/overdue-bills, gmail send-email, Chrome headless
 * @env     token.json (slot "default") only when --send is passed
 *
 * Usage:
 *   node --import tsx scripts/overdue-bills-report.ts --csv="BillsPage.csv"
 *   node --import tsx scripts/overdue-bills-report.ts --csv="BillsPage.csv" --send
 *   node --import tsx scripts/overdue-bills-report.ts --csv="BillsPage.csv" --asof=2026-10-26
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildOverdueModel,
  money,
  renderOverdueHtml,
  runLabel,
  type HeldDispute,
} from "../src/lib/ap/overdue-bills";
import { sendGmailPdfEmail } from "../src/lib/gmail/send-email";
import { createClient } from "../src/lib/db";

/** Open overbill holds from the local data plane (best-effort: report still
 *  renders without them when PostgREST is down). */
async function fetchOpenOverbillDisputes(): Promise<HeldDispute[]> {
  try {
    const db = createClient();
    if (!db) return [];
    const { data } = await db
      .from("overbill_disputes")
      .select(
        "po_number, vendor_name, invoice_number, invoiced_total, received_value, delta, vendor_notified_at, created_at",
      )
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .limit(50);
    return ((data || []) as Array<Record<string, unknown>>).map((r) => ({
      poNumber: String(r.po_number || ""),
      vendorName: String(r.vendor_name || ""),
      invoiceNumber: r.invoice_number ? String(r.invoice_number) : null,
      invoicedTotal: Number(r.invoiced_total || 0),
      receivedValue: Number(r.received_value || 0),
      delta: Number(r.delta || 0),
      vendorNotified: !!r.vendor_notified_at,
      createdAt: String(r.created_at || ""),
    }));
  } catch (err) {
    console.warn(`[overdue-bills] held-dispute fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const ARIA = path.resolve(__dirname, "..");
const REPORTS = path.join(ARIA, "reports");
const TO = "bill.selee@buildasoil.com";
const DEFAULT_CSV = path.join(ARIA, "data", "AllBillsPage.csv");

/** Denver-local calendar date (the aging reference). */
function denverToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

/** Render the HTML file to PDF with headless Chrome. */
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

async function main(): Promise<void> {
  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const send = process.argv.includes("--send");
  const asOf = arg("asof") || denverToday();
  const csvPath = arg("csv") || DEFAULT_CSV;
  const paymentsPath = arg("payments");

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }
  if (paymentsPath && !fs.existsSync(paymentsPath)) {
    throw new Error(`Payments CSV not found: ${paymentsPath}`);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");
  const paymentsCsv = paymentsPath ? fs.readFileSync(paymentsPath, "utf8") : undefined;
  const heldDisputes = await fetchOpenOverbillDisputes();
  const model = buildOverdueModel(
    csvText,
    asOf,
    path.basename(csvPath),
    new Date().toLocaleString("en-US", { timeZone: "America/Denver" }),
    paymentsCsv,
    heldDisputes,
  );

  if (model.overdue.length === 0 && model.heldDisputes.length === 0) {
    console.log("No overdue bills and no held overbills. Nothing to report.");
    return;
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  const stem = `overdue-bills-${asOf}`;
  const htmlPath = path.join(REPORTS, `${stem}.html`);
  const pdfPath = path.join(REPORTS, `${stem}.pdf`);
  fs.writeFileSync(htmlPath, renderOverdueHtml(model));
  chromePdf(htmlPath, pdfPath);

  console.log(`WROTE ${pdfPath}`);
  console.log(`${model.overdue.length} bills ${money(model.totalOverdue)} past due`);
  if (model.paymentSummary) {
    console.log(
      `applied ${model.paymentSummary.applied.length} payments ${money(
        model.paymentSummary.totalApplied,
      )} · unapplied ${model.paymentSummary.unappliedCount} ${money(
        model.paymentSummary.totalUnapplied,
      )}`,
    );
  }
  for (const g of model.exclusionSummary) {
    console.log(
      `excluded ${g.count} bills ${money(g.amount)}: ${g.vendors.join(", ")} (${g.reason})`,
    );
  }
  for (const run of model.runs) {
    console.log(
      `  ${runLabel(run.date)}  ${String(run.bills.length).padStart(2)} bills  ` +
        `${money(run.overdueAmount).padStart(12)}  +new due ${money(run.newDueAmount)}`,
    );
  }

  if (send) {
    const runs = model.runs.filter((r) => r.bills.length > 0);
    const planLines = runs.map(
      (r) => `  ${runLabel(r.date)} - ${r.bills.length} bills - ${money(r.overdueAmount)}`,
    );
    const body = [
      `Past-due stack as of ${new Date(`${asOf}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        timeZone: "UTC",
      })}`,
      "",
      `Total past due: ${model.overdue.length} bills / ${money(model.totalOverdue)}`,
      ...model.exclusionSummary.map(
        (g) =>
          `Not in this run: ${g.vendors.join(", ")} ${g.count} bills / ${money(
            g.amount,
          )} (${g.reason}).`,
      ),
      "",
      "Friday plan, oldest first:",
      ...planLines,
      "",
      "PDF attached.",
    ].join("\n");

    const res = await sendGmailPdfEmail({
      tokenName: "default",
      to: TO,
      subject: `Overdue bills ${model.overdue.length} / ${money(
        model.totalOverdue,
      )} - plan through ${runLabel(runs[runs.length - 1].date)}`,
      body,
      pdfBuffer: fs.readFileSync(pdfPath),
      pdfFilename: path.basename(pdfPath),
    });
    console.log(JSON.stringify(res));
    if (!res.messageId || !res.verified) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
