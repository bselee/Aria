/**
 * @file    src/cli/audit-phantom-cover.ts
 * @purpose Cursory sweep for the BASLCE102 failure class: open POs whose lines
 *          are already fully (or partly) received in Finale but whose ordered
 *          qty is still credited as on-order cover in the cached purchasing
 *          scans. Finale productUnitsRemainingToBeShipped is the arbiter:
 *          a snapshot crediting more than that per line is phantom cover that
 *          can hold a SKU off the ordering board.
 *
 *          Read-only. One GraphQL call + local snapshot reads. No Finale writes.
 *
 * Usage:
 *   tsx src/cli/audit-phantom-cover.ts            # 365d window
 *   tsx src/cli/audit-phantom-cover.ts --days=270
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    none beyond node fetch
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFileSync } from "fs";
import { join } from "path";

const num = (v: unknown): number | null => {
    const n = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
};

const args = process.argv.slice(2);
const DAYS = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] || 365);

interface FinaleLine {
    po: string;
    status: string;
    orderDate: string;
    vendor: string;
    sku: string;
    ordered: number;
    received: number;
    remaining: number | null;
}

interface SnapshotCredit {
    sku: string;
    po: string;
    creditedQty: number;
}

async function fetchOpenPOLines(): Promise<FinaleLine[]> {
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";
    const auth = `Basic ${Buffer.from(
        `${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`
    ).toString("base64")}`;

    const begin = new Date();
    begin.setDate(begin.getDate() - DAYS);
    const beginStr = begin.toISOString().slice(0, 10);
    const endStr = new Date().toISOString().slice(0, 10);

    const query = `{ orderViewConnection(first: 900, type: ["PURCHASE_ORDER"], orderDate: {begin: "${beginStr}", end: "${endStr}"}, sort: [{field: "orderDate", mode: "desc"}]) { edges { node {
        orderId status orderDate supplier { name } itemList(first: 100) { edges { node {
            productUnitsOrdered productUnitsReceived productUnitsRemainingToBeShipped product { productId } } } } } } } }`;

    const res = await fetch(`${base}/${accountPath}/api/graphql`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    const json: any = await res.json();
    if (json.errors) {
        console.error("graphql:", JSON.stringify(json.errors).slice(0, 400));
        process.exit(1);
    }

    const lines: FinaleLine[] = [];
    for (const e of json.data?.orderViewConnection?.edges || []) {
        const po = e.node;
        const isOpen = /Committed|Locked/.test(String(po.status ?? ""));
        for (const ie of po.itemList?.edges || []) {
            const l = ie.node;
            const sku = l.product?.productId;
            if (!sku) continue;
            lines.push({
                po: String(po.orderId),
                status: String(po.status ?? ""),
                orderDate: po.orderDate || "",
                vendor: String(po.supplier?.name || ""),
                sku,
                ordered: num(l.productUnitsOrdered) ?? 0,
                received: num(l.productUnitsReceived) ?? 0,
                remaining: num(l.productUnitsRemainingToBeShipped),
            });
        }
    }
    // Only open POs matter: a completed PO is excluded from committedPOs by the scan.
    return lines.filter((l) => /Committed|Locked/.test(l.status));
}

/** Recursively collect { sku, po, creditedQty } from the snapshot's openPOs. */
function readSnapshotCredits(file: string): SnapshotCredit[] {
    const raw = readFileSync(join(process.cwd(), ".aria-cache", "purchasing", file), "utf-8");
    const data = JSON.parse(raw);
    const out: SnapshotCredit[] = [];
    const walk = (o: any): void => {
        if (Array.isArray(o)) {
            for (const v of o) walk(v);
            return;
        }
        if (o && typeof o === "object") {
            if (typeof o.productId === "string" && Array.isArray(o.openPOs)) {
                for (const po of o.openPOs) {
                    if (po && po.orderId != null) {
                        out.push({
                            sku: o.productId,
                            po: String(po.orderId),
                            creditedQty: num(po.quantity) ?? 0,
                        });
                    }
                }
            }
            for (const v of Object.values(o)) walk(v);
        }
    };
    walk(data);
    return out;
}

async function main(): Promise<void> {
    const finaleLines = await fetchOpenPOLines();
    console.log(`finale: ${finaleLines.length} open-PO lines in last ${DAYS}d\n`);

    // Index Finale truth: per PO per SKU → remaining.
    const truth = new Map<string, FinaleLine>();
    for (const l of finaleLines) {
        truth.set(`${l.po}|${l.sku}`, l);
    }

    const credits = [
        ...readSnapshotCredits("purchasing-resale.json"),
        ...readSnapshotCredits("purchasing-bom.json"),
    ];

    const flags: Array<{ po: string; sku: string; vendor: string; orderDate: string; credited: number; remaining: number | null; received: number; ordered: number }> = [];
    const seen = new Set<string>();
    for (const c of credits) {
        const t = truth.get(`${c.po}|${c.sku}`);
        if (!t) continue; // PO not open in Finale (completed/dropped) — scan just stale; next scan clears it
        const remaining = t.remaining ?? t.ordered; // field absent → fail open, not a flag
        if (c.creditedQty > remaining) {
            const key = `${c.po}|${c.sku}`;
            if (seen.has(key)) continue;
            seen.add(key);
            flags.push({
                po: c.po,
                sku: c.sku,
                vendor: t.vendor,
                orderDate: t.orderDate,
                credited: c.creditedQty,
                remaining,
                received: t.received,
                ordered: t.ordered,
            });
        }
    }

    // Also: open-PO lines fully received that the snapshot does NOT credit at all
    // are already clean; skip. Report only confirmed snags.
    if (flags.length === 0) {
        console.log("clean: no snapshot credit exceeds Finale remaining-to-ship\n");
        // Still surface fully-received open lines for hygiene (POs to complete).
        const completeCandidates = finaleLines
            .filter((l) => l.remaining !== null && l.remaining <= 0 && l.received > 0)
            .reduce((m, l) => {
                const k = `${l.po}|${l.vendor}`;
                if (!m.has(k)) m.set(k, []);
                m.get(k)!.push(l);
                return m;
            }, new Map<string, FinaleLine[]>());
        if (completeCandidates.size > 0) {
            console.log(`hygiene: ${completeCandidates.size} open PO(s) with fully-received lines (complete-pos candidates):`);
            for (const [k, ls] of completeCandidates) {
                const skus = ls.map((l) => `${l.sku} ${l.received}/${l.ordered}`).join(", ");
                console.log(`  ${k}: ${skus}`);
            }
        }
        return;
    }

    console.log(`PHANTOM COVER: ${flags.length} line(s) where snapshot credit > Finale remaining\n`);
    console.log("po        date        vendor                 sku              credited  remaining  received/ordered");
    for (const f of flags) {
        console.log(
            `${f.po.padEnd(10)}${f.orderDate.padEnd(12)}${f.vendor.slice(0, 22).padEnd(22)}${f.sku.padEnd(16)}${String(f.credited).padStart(8)}  ${String(f.remaining).padStart(8)}  ${f.received}/${f.ordered}`
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
