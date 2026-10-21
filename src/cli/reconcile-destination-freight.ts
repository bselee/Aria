/**
 * @file    reconcile-destination-freight.ts
 * @purpose READ-ONLY reconciliation of DestiNATION Transport freight invoices
 *          against Finale POs. DestiNATION carries the 6-digit Finale PO in the
 *          SHIPPER PO / CONSIGNEE REF / BILL OF LADING field and bills flat-rate
 *          (no reweigh), so a correct PO matches the invoice to the cent. Flags:
 *            EXACT          PO freight == invoice amount
 *            DRIFT          PO freight differs from the invoice
 *            NO-FREIGHT     invoice matches a PO that has no freight line
 *            PO-NOT-FOUND   PO number not in the loaded window
 *            UNPARSED       no PO extracted from the PDF
 *
 *          Report-only by default — never writes to Finale. This exists because
 *          the 2026-10 audit found the same failures by hand: a PO silently
 *          holding a stale amount (Malibu 125171 $444.58 vs $464.58) and a load
 *          billed by a different carrier entirely (Gary 124927 via WWEX).
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/reconcile-destination-freight.ts \
 *            --dir .tmp/gary-dest [--days 400] [--gap 900]
 *
 * @author  Hermia
 * @created 2026-10-21
 * @deps    finale/client, pdftotext on PATH (poppler)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const DIR = argVal("--dir") || "";
const DAYS = Number(argVal("--days") || 400);
const GAP = Number(argVal("--gap") || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DestInvoice {
    file: string;
    invoiceNo: string;
    po: string | null;
    amount: number | null;
    deliveryDate: string;
}

/** Extract the invoice's key triple (PO / amount / delivery date) from one PDF. */
function parseInvoicePdf(fp: string): DestInvoice {
    const file = path.basename(fp);
    const out: DestInvoice = { file, invoiceNo: file.replace(/\D/g, ""), po: null, amount: null, deliveryDate: "" };
    let txt = "";
    try {
        txt = execFileSync("pdftotext", ["-layout", fp, "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
        return out;
    }
    // PO lives on the SHIPPER PO / CONSIGNEE REF / BILL OF LADING lines only —
    // matching document-wide would pick up random 6-digit numbers. Range guard:
    // current Finale POs are 12xxxx (rejects carrier ref codes like 7G-096761-01).
    const poLineRe = /(?:SHIPPER PO|CONSIGNEE REF|BILL OF LADING)[^\r\n]*/gi;
    for (const m of txt.matchAll(poLineRe)) {
        const po = m[0].match(/(?:PO\s*)?(12\d{4})/);
        if (po) { out.po = po[1]; break; }
    }
    const amt = txt.match(/PLEASE PAY THIS AMOUNT\s*\$?([\d,]+\.\d{2})/i);
    if (amt) out.amount = Number(amt[1].replace(/,/g, ""));
    const del = txt.match(/DELIVERY DATE\s*:?\s*([\d/]+)/i);
    if (del) out.deliveryDate = del[1];
    return out;
}

/** Sum of the PO's carrier-freight /10007 lines (fee lanes /10015+ excluded). */
function poFreight(po: any): number {
    return (po.orderAdjustmentList || [])
        .filter((a: any) => (a.productPromoUrl || "").includes("/10007") && Number(a.amount) > 2.5)
        .reduce((s: number, a: any) => s + (Number(a.amount) || 0), 0);
}

async function main(): Promise<void> {
    if (!DIR || !fs.existsSync(DIR)) {
        console.error("usage: reconcile-destination-freight.ts --dir <pdf dir> [--days 400] [--gap 900]");
        process.exit(2);
    }
    const pdfs = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
    const invoices = pdfs.map((f) => parseInvoicePdf(path.join(DIR, f)));
    const withPo = invoices.filter((i) => i.po && i.amount !== null);
    const unparsed = invoices.filter((i) => !i.po || i.amount === null);
    console.log(`DestiNATION invoices: ${invoices.length} (${withPo.length} parsed, ${unparsed.length} unparsed)\n`);

    const finale = new FinaleClient() as any;
    const pos = await finale.getRecentPurchaseOrders(DAYS, 1000);
    const byId = new Map(pos.map((p: any) => [String(p.orderId), p]));
    // getRecentPurchaseOrders' GraphQL does not request orderAdjustmentList, so
    // freight is read via getOrderDetails per matched PO (Finale-gentle: GAP between calls).
    async function freightFor(poId: string): Promise<{ freight: number; status: string } | null> {
        try {
            const d = await finale.getOrderDetails(poId);
            await sleep(GAP);
            return { freight: poFreight(d), status: d.statusId || "?" };
        } catch {
            return null;
        }
    }

    const rows: Array<{ po: string; verdict: string; invoice: string; amount: string; poFreight: string; file: string }> = [];
    for (const inv of withPo) {
        let freight: number | null = null;
        if (byId.has(inv.po!)) {
            freight = (await freightFor(inv.po!))?.freight ?? null;
        } else {
            // Outside the (possibly truncated) window — fetch by ID directly.
            const d = await freightFor(inv.po!);
            freight = d?.freight ?? null;
        }
        if (inv.amount === null) continue;
        if (freight === null) {
            rows.push({ po: inv.po!, verdict: "PO-NOT-FOUND", invoice: inv.invoiceNo, amount: `$${inv.amount.toFixed(2)}`, poFreight: "-", file: inv.file });
            continue;
        }
        const diff = Math.round((freight - inv.amount) * 100) / 100;
        const verdict = Math.abs(diff) < 0.02 ? "EXACT" : freight === 0 ? "NO-FREIGHT" : "DRIFT";
        rows.push({ po: inv.po!, verdict, invoice: inv.invoiceNo, amount: `$${inv.amount.toFixed(2)}`, poFreight: `$${freight.toFixed(2)}`, file: inv.file });
    }

    const order = { EXACT: 0, DRIFT: 1, "NO-FREIGHT": 2, "PO-NOT-FOUND": 3 };
    rows.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) || a.po.localeCompare(b.po));
    console.log("PO       verdict        invoice      bill          on-PO        file");
    for (const r of rows) {
        console.log(`${r.po.padEnd(8)} ${r.verdict.padEnd(14)} ${r.invoice.padEnd(12)} ${r.amount.padEnd(13)} ${r.poFreight.padEnd(12)} ${r.file}`);
    }

    const flagged = rows.filter((r) => r.verdict !== "EXACT");
    console.log(`\n${rows.length - flagged.length}/${rows.length} EXACT, ${flagged.length} flagged.`);
    if (unparsed.length) {
        console.log(`\nUnparsed (no PO or amount extracted — read manually):`);
        for (const u of unparsed) console.log(`  ${u.file} (inv ${u.invoiceNo})`);
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
