/**
 * @file    src/cli/verify-forwards-in-billcom.ts
 * @purpose After Bill drops a weekly All Bills CSV, import it and report which
 *          Gmail forwards are actually in Bill.com. No Playwright. No CUA.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    import-billcom-ref, billcom-verify, billcom-csv-source
 * @env     none (SQLite local)
 *
 * Usage:
 *   npx tsx --env-file=.env.local src/cli/verify-forwards-in-billcom.ts
 *   npx tsx --env-file=.env.local src/cli/verify-forwards-in-billcom.ts --csv="C:/Users/BuildASoil/Downloads/AllBillsPage (29).csv"
 *
 * Drop folder: C:\Users\BuildASoil\Downloads\Aria-Ingest\billcom\
 * Also accepts a fresh multi-vendor AllBillsPage*.csv in ~/Downloads.
 */
import { importInbox, importCsvFile } from "@/cli/import-billcom-ref";
import { resolveBillComCsv } from "@/lib/intelligence/ap/billcom-csv-source";
import { runForwardVerificationSweep } from "@/lib/intelligence/ap/billcom-verify";

/** Weekly drop cadence — 10 days before we refuse to judge. */
const WEEKLY_STALE_HOURS = 240;

async function ingest(): Promise<void> {
  const csvArg = process.argv.find((a) => a.startsWith("--csv="));
  if (csvArg) {
    await importCsvFile(csvArg.slice("--csv=".length));
    return;
  }

  await importInbox();

  const resolved = resolveBillComCsv();
  if (
    resolved.path &&
    (resolved.vendorCount ?? 0) > 1 &&
    resolved.ageHours !== null &&
    resolved.ageHours < WEEKLY_STALE_HOURS
  ) {
    console.log(
      `[verify-forwards] also ingesting ${resolved.source} ${resolved.path} ` +
        `(vendors=${resolved.vendorCount}, age=${resolved.ageHours.toFixed(1)}h)`,
    );
    await importCsvFile(resolved.path);
  }
}

async function main(): Promise<void> {
  await ingest();

  const result = runForwardVerificationSweep({
    staleHours: WEEKLY_STALE_HOURS,
    lookbackDays: 14,
  });

  console.log("");
  console.log("=== Gmail forwarded → in Bill.com (last 14 days) ===");
  if (result.refStale) {
    console.log(
      `REF STALE (${result.refAgeHours?.toFixed(1) ?? "?"}h). Drop this week's All Bills CSV and re-run.`,
    );
    process.exitCode = 2;
    return;
  }

  console.log(`in Bill.com (this run):     ${result.verified}`);
  console.log(`already marked processed:   ${result.alreadyProcessed}`);
  console.log(`cannot judge:               ${result.unadjudicable}`);
  console.log(`NOT in this export:         ${result.unconfirmed.length}`);
  console.log(`ref coverage from:          ${result.refCoverageStart ?? "?"}`);

  if (result.unconfirmed.length === 0) {
    console.log("All identifiable recent forwards are in Bill.com.");
    return;
  }

  console.log("");
  console.log("Missing from Bill.com export:");
  for (const r of result.unconfirmed) {
    console.log(
      `  ${r.vendorName ?? "?"}  #${r.invoiceNumber ?? "?"}  ${r.emailSubject.slice(0, 50)}  (${r.ageHours.toFixed(0)}h)`,
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[verify-forwards]", err);
    process.exit(1);
  });
}
