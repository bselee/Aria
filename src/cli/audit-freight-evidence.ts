/**
 * @file    src/cli/audit-freight-evidence.ts
 * @purpose Audit and repair po_freight_evidence rows that were written before a
 *          vendor's house charge was separated from real carriage.
 *
 *          Uline bills $1.50 on every invoice as its own house charge; the carriage
 *          arrives on the FedEx Freight COLLECT bill. Rows written under the old rule
 *          recorded invoice_freight 1.50 with freight_matched true on POs that carried
 *          no carriage at all, so the evidence claimed a reconciled PO while a
 *          four-figure collect went unallocated. This re-derives each row from the live
 *          PO and rewrites it with the carriage made explicit.
 *
 * Usage:
 *   tsx src/cli/audit-freight-evidence.ts --vendor uline
 *   tsx src/cli/audit-freight-evidence.ts --vendor uline --live
 *   --gap <ms>   pause between Finale reads (default 900)
 *
 * Exit code 1 when a row still counts a house charge as carriage.
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, purchasing/vendor-freight-pattern, db
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, PGRST_URL
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { createClient } from "../lib/db";
import { assessFreightEvidence } from "../lib/purchasing/vendor-freight-pattern";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const VENDOR = argVal("--vendor") || "uline";
const GAP = Number(argVal("--gap") || process.env.AUDIT_GAP_MS || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sum every FREIGHT adjustment on a PO document. */
function freightOnPo(po: any, accountPath: string): number | null {
    const feeTypeId = (FinaleClient as any).FINALE_FEE_TYPES?.FREIGHT?.id;
    if (!feeTypeId) return null;
    const promoUrl = `/${accountPath}/api/productpromo/${feeTypeId}`;
    const lines = (po.orderAdjustmentList || []).filter((a: any) => a.productPromoUrl === promoUrl);
    if (!lines.length) return null;
    return Math.round(lines.reduce((s: number, a: any) => s + Number(a.amount || 0), 0) * 100) / 100;
}

async function main(): Promise<void> {
    const sb = createClient();
    if (!sb) throw new Error("no DB client");
    const { data, error } = await sb
        .from("po_freight_evidence")
        .select("order_id, vendor_name, had_freight_on_po, invoice_freight, freight_matched, po_freight_total, house_freight_charge, inbound_freight")
        .ilike("vendor_name", `%${VENDOR}%`)
        .order("order_id");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    console.log(`${rows.length} ${VENDOR} evidence row(s) | mode=${LIVE ? "LIVE" : "report only"}\n`);
    console.log("order   row:inv-frt  matched  ->  live:poFrt  carriage  house  should-be-matched  verdict");
    const stale: any[] = [];
    const client: any = new FinaleClient();
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";

    for (const row of rows) {
        let poTotal = 0;
        let readOk = true;
        try {
            const doc = await client.getOrderDetails(row.order_id);
            poTotal = freightOnPo(doc, accountPath) ?? 0;
        } catch {
            readOk = false;
        }
        const assessment = assessFreightEvidence({
            vendorName: row.vendor_name,
            poFreightTotal: poTotal,
            vendorInvoiceFreight: Number(row.invoice_freight || 0),
        });
        const houseAsFreight =
            Number(row.invoice_freight || 0) > 0 &&
            assessment.invoiceInboundFreight === 0 &&
            assessment.houseFreightCharge > 0;
        const needsRepair =
            readOk &&
            (houseAsFreight ||
                Number(row.inbound_freight || 0) !== assessment.inboundFreight ||
                Boolean(row.freight_matched) !== assessment.freightMatched);
        if (needsRepair) stale.push({ row, assessment, poTotal });
        console.log(
            `${String(row.order_id).padEnd(8)} ${String(row.invoice_freight).padStart(8)}  ${String(row.freight_matched).padEnd(7)} ->  ${String(poTotal).padStart(9)} ${String(assessment.inboundFreight).padStart(9)} ${String(assessment.houseFreightCharge).padStart(6)}  ${String(assessment.freightMatched).padEnd(17)}  ${readOk ? (needsRepair ? (houseAsFreight ? "HOUSE CHARGE AS FREIGHT" : "stale") : "ok") : "read failed"}`,
        );
        await sleep(GAP);
    }

    console.log(`\n${stale.length} row(s) to correct${LIVE ? "" : " (report only)"}`);
    if (!LIVE) {
        process.exitCode = stale.some((s) => s.assessment.freightMatched === false) ? 1 : 0;
        return;
    }
    for (const { row, assessment, poTotal } of stale) {
        const { error: e2 } = await sb
            .from("po_freight_evidence")
            .update({
                invoice_freight: assessment.invoiceInboundFreight,
                po_freight_total: poTotal,
                house_freight_charge: assessment.houseFreightCharge,
                inbound_freight: assessment.inboundFreight,
                freight_matched: assessment.freightMatched,
            })
            .eq("order_id", row.order_id);
        console.log(`  ${row.order_id}: ${e2 ? `FAILED ${e2.message}` : `carriage ${assessment.inboundFreight}, house ${assessment.houseFreightCharge}, matched ${assessment.freightMatched}`}`);
        await sleep(200);
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
