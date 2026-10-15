/**
 * @file    src/cli/reconcile-uline-freight.ts
 * @purpose Put the real inbound freight on ULINE purchase orders, keeping Uline's
 *          $1.50 house charge, and report where a PO does not match its invoice.
 *
 *          Target freight for a Uline PO = every ULINE invoice's SHIPPING/HANDLING
 *          column (the $1.50 on a freight-collect shipment, real freight when Uline
 *          billed it) PLUS one line per carrier bill (FedEx Freight collect).
 *          Every freight line is written as bare `Freight` with ADJ_BY_WEIGHT and an
 *          allocation list sized to the order's item list, so both halves reach
 *          landed cost. A PO that already carries the target and is fully allocated
 *          is left alone.
 *
 *          Report only by default. `--live` writes Finale.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-uline-freight.ts \
 *     --invoices .tmp/uline-invoices.json \
 *     --carrier .tmp/uline-carrier-bills.json \
 *     --report-only | --live
 *
 *   --pos 124289,124312   restrict to specific POs
 *   --json <path>         also write the report as JSON
 *   --quiet               summary only
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, finale/freight-adjustment, fetch-uline-invoices
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import {
    buildFinaleFreightAdjustment,
    freightLineSkipsLandedCost,
} from "../lib/finale/freight-adjustment";
import { isCollectShipVia, type UlineInvoice } from "./fetch-uline-invoices";

/** One carrier freight bill for a PO (FedEx Freight collect bill). */
export interface CarrierBill {
    po: string;
    /** Carrier invoice / freight bill number. */
    invoice: string;
    amount: number;
    /** Where the number came from: `billtrust-csv`, `fedex-invoice-pdf`, `sheet`. */
    source: string;
}

const TAX_PROMO_SUFFIX = "/10008";
const HOUSE_CHARGE_MAX = 2.5;
const EPS = 0.005;

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
};
const LIVE = args.includes("--live");
const QUIET = args.includes("--quiet");
const INVOICES_PATH = argVal("--invoices") || path.join(process.cwd(), ".tmp", "uline-invoices.json");
const CARRIER_PATH = argVal("--carrier");
const POS_FILTER = (argVal("--pos") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const JSON_OUT = argVal("--json");
/** Write the invoice's sales tax onto the PO as well as freight. Off by default. */
const WRITE_TAX = args.includes("--write-tax");
/** Pause between Finale calls. Finale rate-limits hard; raise this after a 429. */
const GAP_MS = Number(argVal("--gap") || 400);
/** POs that carry a carrier bill belonging to a different PO — strip every freight line. */
const STRIP_POS = new Set(
    (argVal("--strip-freight") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
);
const ACCOUNT = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";

type Promo = { productPromoUrl?: string | null; description?: string | null; amount?: number | string };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const promoOf = (a: Promo): string => String(a.productPromoUrl || "");
const isFreightLine = (a: Promo): boolean => promoOf(a).endsWith("/10007");
const isTaxLine = (a: Promo): boolean => promoOf(a).endsWith(TAX_PROMO_SUFFIX);
const sum = (ns: number[]): number => round2(ns.reduce((s, n) => s + n, 0));

interface Target {
    /** What the PO's Tax adjustment should be, or null when no invoice was found. */
    tax: number | null;
    /** Freight lines the PO should carry. */
    freight: Array<{ amount: number; ref: string }>;
    goodsOnInvoice: number | null;
    invoices: UlineInvoice[];
    bills: CarrierBill[];
}

/** Build the target state for one PO from its Uline invoices plus its carrier bills. */
function targetFor(po: string, invoices: UlineInvoice[], bills: CarrierBill[]): Target {
    const freight: Array<{ amount: number; ref: string }> = [];
    for (const inv of invoices) {
        const handling = Number(inv.handling || 0);
        if (handling > 0) {
            freight.push({
                amount: round2(handling),
                ref: `ULINE ${inv.invoiceNo}${isCollectShipVia(inv.shipVia) ? " house charge" : " freight"}`,
            });
        }
    }
    for (const b of bills) freight.push({ amount: round2(b.amount), ref: `carrier ${b.invoice} (${b.source})` });
    return {
        tax: invoices.length ? sum(invoices.map((i) => Number(i.tax || 0))) : null,
        freight,
        goodsOnInvoice: invoices.length ? sum(invoices.map((i) => Number(i.goods || 0))) : null,
        invoices,
        bills,
    };
}

/** Read a JSON file, or exit with a clear message. Accepts a bare array or `{ bills: [...] }`. */
function readJson<T>(file: string, what: string, key?: string): T[] | null {
    if (!file) return null;
    if (!fs.existsSync(file)) {
        console.error(`missing ${what}: ${file}`);
        return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) return parsed as T[];
    if (key && Array.isArray(parsed?.[key])) return parsed[key] as T[];
    console.error(`${what}: ${file} is not an array${key ? ` or {${key}: []}` : ""}`);
    return null;
}

async function main(): Promise<void> {
    const invoices = readJson<UlineInvoice>(INVOICES_PATH, "ULINE invoice file") || [];
    const bills = (CARRIER_PATH ? readJson<CarrierBill>(CARRIER_PATH, "carrier bill file", "bills") : null) || [];

    const pos = new Set<string>(POS_FILTER);
    if (!POS_FILTER.length) {
        for (const i of invoices) if (i.poOnInvoice) pos.add(i.poOnInvoice);
        for (const b of bills) if (b.po) pos.add(b.po);
    }
    if (!pos.size) {
        console.error("no POs to reconcile — pass --pos, --invoices or --carrier");
        process.exit(1);
    }

    const byInvoicePo = new Map<string, UlineInvoice[]>();
    for (const i of invoices) {
        if (!i.poOnInvoice) continue;
        const list = byInvoicePo.get(i.poOnInvoice) || [];
        list.push(i);
        byInvoicePo.set(i.poOnInvoice, list);
    }
    const byBillPo = new Map<string, CarrierBill[]>();
    for (const b of bills) {
        const list = byBillPo.get(b.po) || [];
        list.push(b);
        byBillPo.set(b.po, list);
    }

    console.log(`Mode: ${LIVE ? "LIVE" : "REPORT ONLY"}   account: ${ACCOUNT}`);
    console.log(`Invoices: ${INVOICES_PATH} (${invoices.length})   Carrier bills: ${CARRIER_PATH || "-"} (${bills.length})\n`);

    const client: any = new FinaleClient();
    const report: any[] = [];
    let written = 0;
    let held = 0;

    for (const po of [...pos].sort()) {
        const poInvoices = byInvoicePo.get(po) || [];
        const poBills = byBillPo.get(po) || [];
        const target = targetFor(po, poInvoices, poBills);

        let doc: any;
        try {
            doc = await client.getOrderDetails(po);
        } catch (err: any) {
            console.log(`${po}: NOT FOUND — ${err?.message?.slice(0, 90)}`);
            continue;
        }

        const rawCount = (doc.orderItemList || []).length;
        const adjs: Promo[] = doc.orderAdjustmentList || [];
        const freightLines = adjs.filter(isFreightLine);
        const curFreight = sum(freightLines.map((a) => Number(a.amount || 0)));
        const curTax = sum(adjs.filter(isTaxLine).map((a) => Number(a.amount || 0)));
        const unallocated = freightLines.filter((a) => freightLineSkipsLandedCost(a as any, rawCount)).length;
        const goodsOnPo = round2(
            (doc.orderItemList || []).reduce(
                (s: number, i: any) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0),
                0,
            ),
        );

        // A PO with no matched invoice keeps whatever house charge it already shows.
        let freightTargets = target.freight;
        if (!poInvoices.length) {
            const house = freightLines
                .map((a) => Number(a.amount || 0))
                .filter((n) => n > 0 && n <= HOUSE_CHARGE_MAX);
            const existing = house[0] ? [{ amount: round2(house[0]), ref: "existing ULINE house charge" }] : [];
            freightTargets = [...existing, ...target.freight];
        }
        if (STRIP_POS.has(po)) {
            freightTargets = [];
        }
        const targetFreight = sum(freightTargets.map((f) => f.amount));
        const freightGap = round2(targetFreight - curFreight);
        const taxGap = target.tax === null ? 0 : round2(target.tax - curTax);
        const goodsGap =
            target.goodsOnInvoice === null ? 0 : round2(target.goodsOnInvoice - goodsOnPo);
        // A PO carrying real freight with no carrier bill to replace it: do not touch it.
        // Writing would delete freight we cannot re-derive (e.g. 125127's $414.22 line).
        const unexplained = round2(curFreight - targetFreight);
        const holdNoBill = !STRIP_POS.has(po) && !poBills.length && unexplained > HOUSE_CHARGE_MAX + EPS;
        const needsRewrite =
            !holdNoBill &&
            (Math.abs(freightGap) > EPS ||
                unallocated > 0 ||
                (STRIP_POS.has(po) && curFreight > EPS) ||
                (WRITE_TAX && target.tax !== null && Math.abs(taxGap) > EPS));

        const line = (s: string) => (QUIET ? undefined : console.log(s));
        const freightDisplay = holdNoBill
            ? `freight ${curFreight.toFixed(2)} (held)`
            : `freight ${curFreight.toFixed(2)} -> ${targetFreight.toFixed(2)}`;
        console.log(
            `${po}  ${String(doc.statusId).replace("ORDER_", "").padEnd(9)} items=${String(rawCount).padEnd(3)} ` +
                `goods PO ${goodsOnPo.toFixed(2)}${target.goodsOnInvoice === null ? "" : ` / inv ${target.goodsOnInvoice.toFixed(2)}`}  ` +
                `tax ${curTax.toFixed(2)}${target.tax === null ? "" : ` -> ${target.tax.toFixed(2)}`}  ` +
                `${freightDisplay}  ` +
                `${needsRewrite ? (LIVE ? "WRITE" : "WOULD WRITE") : holdNoBill ? "HOLD" : "ok"}`,
        );
        for (const f of freightTargets) line(`      target freight $${f.amount.toFixed(2)}  ${f.ref}`);
        for (const a of freightLines) {
            line(
                `      on PO        $${Number(a.amount || 0).toFixed(2)}  "${a.description}"` +
                    ` alloc=${(a as any).orderAdjustmentAllocationList?.length ?? "none"}` +
                    `${freightLineSkipsLandedCost(a as any, rawCount) ? "  <== skips landed cost" : ""}`,
            );
        }
        if (Math.abs(goodsGap) > EPS) line(`      !! goods differ by ${goodsGap.toFixed(2)} (report only)`);
        if (Math.abs(taxGap) > EPS) {
            line(
                `      !! tax differs by ${taxGap.toFixed(2)} (${WRITE_TAX && !holdNoBill ? "written" : "report only"})`,
            );
        }
        if (!poInvoices.length) line(`      !! no ULINE invoice matched this PO`);
        if (holdNoBill) {
            line(
                `      !! HOLD — $${unexplained.toFixed(2)} of freight on the PO with no carrier bill to match it; not touched`,
            );
        }

        report.push({
            po,
            status: doc.statusId,
            itemCount: rawCount,
            goodsOnPo,
            goodsOnInvoice: target.goodsOnInvoice,
            taxOnPo: curTax,
            taxTarget: target.tax,
            freightOnPo: curFreight,
            freightTarget: targetFreight,
            freightTargets,
            unallocatedFreightLines: unallocated,
            needsRewrite,
            holdNoCarrierBill: holdNoBill,
            stripped: STRIP_POS.has(po),
            written: false,
        });

        if (!needsRewrite) {
            await new Promise((r) => setTimeout(r, GAP_MS));
            continue;
        }
        if (!LIVE) {
            held++;
            await new Promise((r) => setTimeout(r, GAP_MS));
            continue;
        }

        // ── write ────────────────────────────────────────────────────────────
        const originalStatus = doc.statusId;
        try {
            const allocLines = await client.freightAllocLines(doc.orderItemList);
            // Tax is written as one bare line with no allocation: that is how every PO
            // in the system carries it, pre-existing and untouched.
            const keep = adjs.filter((a) => !isFreightLine(a) && !(WRITE_TAX && isTaxLine(a)));
            // Every freight line is bare `Freight` + ADJ_BY_WEIGHT + a weight allocation
            // sized to the raw item list, or Finale skips the landed-cost roll.
            const built = freightTargets.map((f) =>
                buildFinaleFreightAdjustment(f.amount, allocate(allocLines, f.amount)),
            );
            const taxLine =
                WRITE_TAX && target.tax !== null
                    ? [
                          {
                              amount: target.tax,
                              description: "Tax",
                              productPromoUrl: `/${ACCOUNT}/api/productpromo/10008`,
                          },
                      ]
                    : [];
            const newAdjs: any[] = [...keep, ...taxLine, ...built];

            await client.unlockForEditing(doc, po);
            await client.post(`/${ACCOUNT}/api/order/${encodeURIComponent(po)}`, {
                ...doc,
                orderAdjustmentList: newAdjs,
            });
            await client.restoreOrderStatus(po, originalStatus);
            if (originalStatus === "ORDER_COMPLETED") await client.completeOrder(po);

            const after: any = await client.getOrderDetails(po);
            const afterAdjs: Promo[] = after.orderAdjustmentList || [];
            const afterFreight = afterAdjs.filter(isFreightLine);
            const afterSum = sum(afterFreight.map((a) => Number(a.amount || 0)));
            const afterTax = sum(afterAdjs.filter(isTaxLine).map((a) => Number(a.amount || 0)));
            const afterBad = afterFreight.filter((a) =>
                freightLineSkipsLandedCost(a as any, (after.orderItemList || []).length),
            );
            const ok =
                after.statusId === originalStatus &&
                Math.abs(afterSum - targetFreight) <= EPS &&
                afterBad.length === 0 &&
                (!WRITE_TAX || target.tax === null || Math.abs(afterTax - target.tax) <= EPS);
            console.log(
                `      ${ok ? "verified" : "VERIFY FAILED"}: status=${after.statusId} freight=${afterSum.toFixed(2)}` +
                    ` lines=${afterFreight.map((a) => Number(a.amount || 0).toFixed(2)).join("+")}` +
                    `${afterBad.length ? ` unallocated=${afterBad.length}` : ""}` +
                    `${WRITE_TAX && target.tax !== null ? ` tax=${afterTax.toFixed(2)}` : ""}`,
            );
            written++;
            report[report.length - 1].written = ok;
        } catch (err: any) {
            // A 429 mid-write can leave the PO unlocked — say so loudly and keep going.
            console.log(`      WRITE FAILED: ${err?.message?.slice(0, 140)}`);
            console.log(`      re-check status of ${po} before trusting it`);
            report[report.length - 1].error = String(err?.message || err).slice(0, 200);
        }
        await new Promise((r) => setTimeout(r, GAP_MS));
    }

    console.log(
        `\n${report.length} POs checked | ${report.filter((r) => r.needsRewrite).length} need freight work | ` +
            `${written} written | ${held} held (report only) | ` +
            `${report.filter((r) => r.holdNoCarrierBill).length} held on a missing carrier bill`,
    );
    console.log(`adjustment lines are Tax and Freight only — no other line types are ever written`);

    if (JSON_OUT) {
        fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
        fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
        console.log(`report -> ${JSON_OUT}`);
    }
}

/** Weight-based allocation for one freight amount, sized to the order's item list. */
function allocate(lines: Array<{ quantity: number; weight?: number }>, amount: number): number[] {
    const masses = lines.map((l) => {
        const qty = Number(l.quantity) || 0;
        if (qty <= 0) return 0;
        const w = Number(l.weight);
        return Number.isFinite(w) && w > 0 ? qty * w : qty;
    });
    const total = masses.reduce((s, m) => s + m, 0);
    if (!lines.length) return [round2(amount)];
    if (total <= 0) {
        const out = lines.map(() => 0);
        out[0] = round2(amount);
        return out;
    }
    const parts = masses.map((m) => round2((m / total) * amount));
    const diff = round2(amount - parts.reduce((s, n) => s + n, 0));
    if (diff !== 0) {
        for (let i = parts.length - 1; i >= 0; i--) {
            if (masses[i] > 0) {
                parts[i] = round2(parts[i] + diff);
                break;
            }
        }
    }
    return parts;
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
