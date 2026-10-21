/**
 * @file    reconcile-invoice-freight.ts
 * @purpose Put the carriage a vendor charged us onto the right Finale PO.
 *
 *          For vendors whose invoice carries freight (PPD-ADD) the invoice is
 *          the authority on the amount; for vendors shipping free (CIP / "Free
 *          Freight") there is nothing to add; for COLLECT the charge arrives on
 *          the carrier bill instead and is handled by the freight lane.
 *
 *          This CLI reads the vendor's invoice emails, parses the invoice
 *          header (printed PO, ship via, shipping terms, amount block),
 *          correlates each invoice to a PO (the printed PO only wins when the
 *          goods totals agree — a vendor can print the wrong PO), and reports
 *          the freight that is on the invoice but missing from the PO.
 *
 *          Defaults to a dry-run report. `--live` writes the missing amount as
 *          a plain `Freight` adjustment via FinaleClient.addOrderAdjustment.
 *
 * @author  Hermia
 * @created 2026-10-07
 * @deps    gmail/auth, pdf extractor, pdf-parse, finale/client,
 *          purchasing/invoice-header, purchasing/invoice-po-correlate, lib/db
 * @env     Gmail OAuth tokens (default + ap), FINALE_API_KEY, FINALE_API_SECRET,
 *          FINALE_ACCOUNT_PATH
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-invoice-freight.ts --vendor "Stock Bag Depot"
 *   node --env-file=.env.local --import tsx src/cli/reconcile-invoice-freight.ts --vendor "Stock Bag Depot" --live
 */

import { readFileSync } from "fs";
import { pathToFileURL } from "url";
const envRaw = readFileSync(".env.local", "utf8");
for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

import { createClient } from "../lib/db";
import { FinaleClient } from "../lib/finale/client";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { parseVendorInvoiceHeader, classifyInvoiceFreight, FREIGHT_CHARGE_FLOOR } from "../lib/purchasing/invoice-header";
import { correlateInvoiceToPo, type PoRef } from "../lib/purchasing/invoice-po-correlate";

/** Auth client shape accepted by the Gmail factory (avoids a type-only dep). */
type GmailAuth = Parameters<typeof GmailApi>[0]["auth"];

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (flag: string, dflt: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const VENDOR = argVal("--vendor", "Stock Bag Depot");
const FROM = argVal("--from", "stockbagdepot.com");
const DAYS = Number(argVal("--days", "400"));
const LIVE = args.includes("--live");

/** A freight figure at or below this is Finale's Uline-style house charge, not real carrier freight. */
const HOUSE_CHARGE_MAX = 2.5;

interface ReportRow {
    invoice: string;
    order: string;
    statedPo: string | null;
    shipVia: string | null;
    terms: string | null;
    payer: string;
    invoiceFreight: number;
    poNumber: string | null;
    poFreight: number | null;
    correlateReason: string;
    action: "ADD" | "OK" | "NONE" | "HOLD";
    detail: string;
}

// ── Finale surface (protected methods reached through a local interface) ─────

interface FinaleAdjustment {
    amount?: number;
    description?: string;
    productPromoUrl?: string;
}
interface FinalePoDoc {
    statusId?: string;
    orderItemListTotal?: number;
    orderAdjustmentList?: FinaleAdjustment[];
}
interface FinaleWriteSurface {
    getOrderDetails(orderId: string): Promise<FinalePoDoc>;
    addOrderAdjustment(orderId: string, feeType: "FREIGHT", amount: number): Promise<unknown>;
}

/**
 * Extract the carrier freight already on a Finale PO, ignoring small house
 * charges (any `/10007` line at or below {@link HOUSE_CHARGE_MAX}).
 *
 * @param po Finale PO document.
 * @returns  Sum of real freight adjustments in dollars.
 */
function freightOnPo(po: FinalePoDoc | null): number {
    const adjs = po?.orderAdjustmentList || [];
    return adjs
        .filter((a) => (a.productPromoUrl || "").includes("/10007") || (a.description || "").toLowerCase().includes("freight"))
        .reduce((s, a) => {
            const amt = Number(a.amount) || 0;
            return amt > HOUSE_CHARGE_MAX ? s + amt : s;
        }, 0);
}

/** Vendor's POs from the local mirror, shaped for the correlator. */
async function loadVendorPos(vendor: string): Promise<PoRef[]> {
    const db = createClient();
    const { data } = await db
        .from("purchase_orders")
        .select("po_number, vendor_name, total_amount, total, issue_date, status")
        .ilike("vendor_name", `%${vendor}%`);
    return ((data || []) as Array<Record<string, unknown>>)
        .filter((r) => r.po_number && !/DropshipPO$/i.test(String(r.po_number)))
        .map((r) => ({
            poNumber: String(r.po_number),
            vendorName: String(r.vendor_name || ""),
            totalAmount: Number(r.total_amount ?? r.total ?? 0),
            issueDate: (r.issue_date as string) || null,
            status: (r.status as string) || null,
        }));
}

/** Download the invoice PDFs the vendor emailed (both inboxes), deduped by invoice number. */
async function loadInvoices(): Promise<Array<{ invoiceNumber: string; text: string }>> {
    const seen = new Set<string>();
    const out: Array<{ invoiceNumber: string; text: string }> = [];
    for (const account of ["default", "ap"]) {
        let gmail: ReturnType<typeof GmailApi>;
        try {
            const auth = await getAuthenticatedClient(account);
            gmail = GmailApi({ version: "v1", auth: auth as unknown as GmailAuth });
        } catch (e: unknown) {
            console.warn(`[gmail:${account}] auth failed: ${(e as Error).message}`);
            continue;
        }
        const q = `from:${FROM} has:attachment filename:pdf newer_than:${DAYS}d`;
        const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100 });
        for (const mm of list.data.messages || []) {
            const m = await gmail.users.messages.get({ userId: "me", id: mm.id!, format: "full" });
            const part = (m.data.payload?.parts as GmailPart[] | undefined)?.find(
                (p) => p.filename?.toLowerCase().endsWith(".pdf") && p.body?.attachmentId,
            );
            if (!part) continue;
            const att = await gmail.users.messages.attachments.get({ userId: "me", messageId: mm.id!, id: part.body!.attachmentId! });
            const buf = Buffer.from(att.data.data!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
            let text = "";
            try {
                const pdfParse = (await import("pdf-parse")).default as (b: Buffer) => Promise<{ text?: string }>;
                text = (await pdfParse(buf)).text || "";
            } catch {
                continue;
            }
            const header = parseVendorInvoiceHeader(text);
            const key = header.invoiceNumber || `msg:${mm.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ invoiceNumber: key, text });
        }
    }
    return out;
}

async function main(): Promise<void> {
    console.log(`\n╔═══════════════════════════════════════════════════╗`);
    console.log(`║   Vendor invoice freight → Finale PO              ║`);
    console.log(`╚═══════════════════════════════════════════════════╝`);
    console.log(`Vendor: ${VENDOR}   From: ${FROM}   Window: ${DAYS}d   Mode: ${LIVE ? "🔴 LIVE" : "🔵 DRY RUN"}\n`);

    const pos = await loadVendorPos(VENDOR);
    console.log(`POs in mirror for vendor: ${pos.length}`);

    const invoices = await loadInvoices();
    console.log(`Invoice emails parsed: ${invoices.length}\n`);

    const finale = new FinaleClient() as unknown as FinaleWriteSurface;
    const rows: ReportRow[] = [];
    const poFreightCache = new Map<string, number>();
    const finaleGoodsCache = new Map<string, number>();

    /** Goods total from Finale (`orderItemListTotal`), for amount confirmation. */
    const finaleGoods = async (poNumber: string): Promise<number> => {
        if (!finaleGoodsCache.has(poNumber)) {
            try {
                const d = await finale.getOrderDetails(poNumber);
                finaleGoodsCache.set(poNumber, Number(d?.orderItemListTotal) || 0);
            } catch {
                finaleGoodsCache.set(poNumber, NaN);
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        return finaleGoodsCache.get(poNumber)!;
    };

    for (const inv of invoices) {
        const header = parseVendorInvoiceHeader(inv.text);
        const { payer, amount } = classifyInvoiceFreight(header);

        // Some invoices render the amount block with no values (e.g. Stock Bag
        // 110102), so the parsed Sales Amount can be 0. Fall back to Finale's own
        // goods total for the stated PO instead of correlating on a $0.
        let salesAmount = header.salesAmount;
        let goodsFromFinale = false;
        if (!(salesAmount > 0) && header.statedPo) {
            const g = await finaleGoods(header.statedPo);
            if (Number.isFinite(g) && g > 0) {
                salesAmount = g;
                goodsFromFinale = true;
            }
        }

        const corr = correlateInvoiceToPo(
            { statedPo: header.statedPo, salesAmount, invoiceDate: header.invoiceDate },
            pos,
        );
        let poNumber = corr.match?.poNumber ?? null;
        let correlateReason = corr.reason;
        let detail = corr.detail;
        if (goodsFromFinale) detail += " (goods from Finale; invoice amount block blank)";

        // A stated PO the mirror does not carry (older POs fall outside the
        // mirror window) is still usable when Finale confirms its goods total.
        if (!poNumber && header.statedPo && salesAmount > 0) {
            const goods = await finaleGoods(header.statedPo);
            if (Number.isFinite(goods) && Math.abs(goods - salesAmount) <= 0.5) {
                poNumber = header.statedPo;
                correlateReason = "stated_po_finale_amount_confirmed";
                detail = `printed PO ${header.statedPo} = $${goods.toFixed(2)} in Finale`;
            } else if (Number.isFinite(goods)) {
                detail = `printed PO ${header.statedPo} is $${goods.toFixed(2)} in Finale, invoice sales $${salesAmount.toFixed(2)}`;
            }
        }

        let current: number | null = null;
        if (poNumber) {
            if (!poFreightCache.has(poNumber)) {
                try {
                    const doc = await finale.getOrderDetails(poNumber);
                    poFreightCache.set(poNumber, freightOnPo(doc));
                } catch (e: unknown) {
                    console.warn(`[finale] ${poNumber}: ${(e as Error).message}`);
                    poFreightCache.set(poNumber, NaN);
                }
                await new Promise((r) => setTimeout(r, 300));
            }
            current = poFreightCache.get(poNumber) ?? null;
        }

        let action: ReportRow["action"];
        if (!poNumber) action = "HOLD";
        else if (payer !== "vendor_charged" || amount <= FREIGHT_CHARGE_FLOOR) action = "NONE";
        else if (current != null && current + 0.01 >= amount) action = "OK";
        else action = "ADD";

        rows.push({
            invoice: header.invoiceNumber || inv.invoiceNumber,
            order: header.orderNumber || "",
            statedPo: header.statedPo,
            shipVia: header.shipVia,
            terms: header.shippingTerms,
            payer,
            invoiceFreight: amount,
            poNumber,
            poFreight: Number.isFinite(current as number) ? current : null,
            correlateReason,
            action,
            detail,
        });
    }

    // ── Report ──────────────────────────────────────────────────────────────
    console.log("invoice  order   PO       terms     payer            inv-frt  po-frt   action");
    console.log("─".repeat(92));
    for (const r of rows) {
        console.log(
            `${r.invoice.padEnd(8)} ${r.order.padEnd(7)} ${(r.poNumber || "—").padEnd(8)} ${(r.terms || "—").padEnd(9)} ${
                r.payer.padEnd(16)
            } ${r.invoiceFreight.toFixed(2).padStart(7)}  ${(r.poFreight == null ? "—" : r.poFreight.toFixed(2)).padStart(7)}  ${r.action}`,
        );
    }

    const toAdd = rows.filter((r) => r.action === "ADD");
    const holds = rows.filter((r) => r.action === "HOLD");
    console.log(`\nSummary: ${rows.length} invoices · ${toAdd.length} missing freight · ${holds.length} held (no unambiguous PO)`);
    for (const r of toAdd) console.log(`  ADD  PO ${r.poNumber}  $${r.invoiceFreight.toFixed(2)}  (invoice ${r.invoice})`);
    for (const r of holds) console.log(`  HOLD invoice ${r.invoice}: ${r.detail}`);

    if (!LIVE) {
        console.log(`\nDry run — re-run with --live to write the ${toAdd.length} Freight line(s).`);
        return;
    }

    // ── Apply ───────────────────────────────────────────────────────────────
    for (const r of toAdd) {
        try {
            await finale.addOrderAdjustment(r.poNumber!, "FREIGHT", r.invoiceFreight);
            const after = await finale.getOrderDetails(r.poNumber!);
            const landed = freightOnPo(after);
            const ok = Math.abs(landed - r.invoiceFreight) < 0.01;
            console.log(`  ${ok ? "✅" : "⚠️ "} PO ${r.poNumber} freight now $${landed.toFixed(2)} (${after.statusId}) [invoice ${r.invoice}]`);
            await new Promise((res) => setTimeout(res, 500));
        } catch (e: unknown) {
            console.log(`  ❌ PO ${r.poNumber}: ${e.message}`);
        }
    }
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((e: unknown) => {
        console.error("ERR", (e as Error).message);
        process.exit(1);
    });
}
