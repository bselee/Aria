/**
 * @file    src/cli/audit-freight-lines.ts
 * @purpose Read-only audit of one vendor's (or a PO list's) adjustment lines:
 *          every Freight line must be bare `Freight`, carry ADJ_BY_WEIGHT, and
 *          have an allocation list sized to the raw order item count, or it never
 *          reaches landed cost. Also flags any adjustment that is not Tax (10008)
 *          or Freight (10007) — Bill's rule is Tax and Freight only.
 *
 *          Uses the repo's canonical detector `freightLineSkipsLandedCost`, never a
 *          hand-rolled description grep.
 *
 * Usage:
 *   tsx src/cli/audit-freight-lines.ts --vendor uline            # Finale list + invoice POs
 *   tsx src/cli/audit-freight-lines.ts --pos 124636,125127
 *   tsx src/cli/audit-freight-lines.ts --invoices .tmp/uline-invoices.json
 *   --json <path>   write the findings
 *   --gap <ms>      pause between Finale reads (default 900)
 *
 * Exit code 1 when any violation is found.
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, finale/freight-adjustment
 * @env     FINALE_API_KEY, FINALE_API_SECRET
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { freightLineSkipsLandedCost, FINALE_FREIGHT_DESCRIPTION } from "../lib/finale/freight-adjustment";

const TAX_PROMO = "/10008";
const FREIGHT_PROMO = "/10007";

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
};
const VENDOR = argVal("--vendor");
const INVOICES = argVal("--invoices");
const JSON_OUT = argVal("--json");
const GAP_MS = Number(argVal("--gap") || 900);
const POS = (argVal("--pos") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

interface Finding {
    po: string;
    status: string;
    itemCount: number;
    goods: number;
    lines: Array<{
        amount: number;
        description: string;
        promo: string;
        enumId: string | null;
        allocLength: number | null;
        flags: string[];
    }>;
    violations: string[];
}

/** Collect PO ids from the invoice JSON (Uline invoice side). */
function posFromInvoices(file: string): string[] {
    const rows = JSON.parse(fs.readFileSync(file, "utf-8"));
    const out = new Set<string>();
    for (const r of rows) if (r.poOnInvoice) out.add(String(r.poOnInvoice));
    return [...out];
}

async function main(): Promise<void> {
    const pos = new Set<string>(POS);
    if (INVOICES && fs.existsSync(INVOICES)) for (const p of posFromInvoices(INVOICES)) pos.add(p);

    const client: any = new FinaleClient();
    if (VENDOR) {
        const list: any[] = await client.getRecentPurchaseOrders(400);
        for (const p of list) {
            if (new RegExp(VENDOR, "i").test(p.vendorName || "")) pos.add(String(p.orderId));
        }
        console.log(`${list.length} POs in the 400d window, ${pos.size} in scope for /${VENDOR}/`);
    }
    if (!pos.size) {
        console.error("nothing in scope — pass --vendor, --pos or --invoices");
        process.exit(1);
    }

    const findings: Finding[] = [];
    let violationCount = 0;

    for (const po of [...pos].sort()) {
        let doc: any;
        try {
            doc = await client.getOrderDetails(po);
        } catch (err: any) {
            console.log(`${po}: NOT FOUND (${err?.message?.slice(0, 60)})`);
            await new Promise((r) => setTimeout(r, GAP_MS));
            continue;
        }
        const rawItems = doc.orderItemList || [];
        const rawCount = rawItems.length;
        const goods = rawItems.reduce((s: number, i: any) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0), 0);
        const lines: Finding["lines"] = [];
        const violations: string[] = [];

        for (const a of doc.orderAdjustmentList || []) {
            const promo = String(a.productPromoUrl || "");
            const desc = String(a.description ?? "");
            const enumId = a.adjustmentAllocationEnumId ?? null;
            const alloc = a.orderAdjustmentAllocationList ?? null;
            const flags: string[] = [];
            if (promo.endsWith(FREIGHT_PROMO)) {
                if (desc !== FINALE_FREIGHT_DESCRIPTION) flags.push(`DESCRIPTION("${desc}")`);
                if (enumId !== "ADJ_BY_WEIGHT") flags.push("NO_ENUM");
                if (!alloc) flags.push("NO_ALLOC");
                else if (alloc.length !== rawCount) flags.push(`ALLOC_LEN(${alloc.length}!=${rawCount})`);
                if (freightLineSkipsLandedCost(a, rawCount)) flags.push("SKIPS_LANDED_COST");
            } else if (!promo.endsWith(TAX_PROMO) && promo !== "") {
                flags.push("NON_FEE_LINE");
            }
            lines.push({
                amount: Number(a.amount || 0),
                description: desc,
                promo: promo.split("/").pop() || promo,
                enumId,
                allocLength: alloc ? alloc.length : null,
                flags,
            });
            if (flags.length) violations.push(`$${Number(a.amount || 0).toFixed(2)} "${desc}" -> ${flags.join(", ")}`);
        }

        if (violations.length) violationCount++;
        findings.push({
            po,
            status: doc.statusId,
            itemCount: rawCount,
            goods: Math.round(goods * 100) / 100,
            lines,
            violations,
        });

        const freight = lines.filter((l) => l.promo === "10007");
        const freightTotal = freight.reduce((s, l) => s + l.amount, 0);
        console.log(
            `${po} ${String(doc.statusId).replace("ORDER_", "").padEnd(9)} items=${String(rawCount).padEnd(3)} ` +
                `goods=${goods.toFixed(2).padStart(9)} freight=${freightTotal.toFixed(2).padStart(9)} lines=${freight.length} ` +
                `${violations.length ? `VIOLATIONS ${violations.length}` : "clean"}`,
        );
        for (const l of lines) {
            const mark = l.flags.length ? "  <== " + l.flags.join(", ") : "";
            console.log(
                `      ${l.promo.padEnd(5)} $${l.amount.toFixed(2).padStart(9)} "${l.description}" enum=${l.enumId || "-"} alloc=${l.allocLength ?? "none"}${mark}`,
            );
        }
        await new Promise((r) => setTimeout(r, GAP_MS));
    }

    console.log(
        `\n${findings.length} POs audited | ${violationCount} with violations | ` +
            `${findings.reduce((s, f) => s + f.violations.length, 0)} violation(s)`,
    );
    if (JSON_OUT) {
        fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
        fs.writeFileSync(JSON_OUT, JSON.stringify(findings, null, 1));
        console.log(`findings -> ${JSON_OUT}`);
    }
    if (violationCount) process.exitCode = 1;
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
