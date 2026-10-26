/**
 * @file    src/cli/complete-received-pos.ts
 * @purpose Close the gap Bill keeps seeing: POs that are fully received and carry their
 *          freight, but still sit at Committed long after the goods landed.
 *
 *          A PO is only completed when every gate is satisfied, so "confidence is high"
 *          is enforced rather than assumed:
 *            1. Finale status is ORDER_LOCKED (Committed), read from the order document
 *               because GraphQL `status` lags a REST write.
 *            2. Every line is fully received (remaining 0) and something was received.
 *            3. Freight is finished: for a COLLECT vendor (Uline) that means the 1.50
 *               house charge AND the carrier amount, or a single vendor-billed freight;
 *               a house charge alone is held because the carrier bill is missing.
 *            4. Every freight line is bare `Freight` with ADJ_BY_WEIGHT and an
 *               allocation list sized to the raw line count, or it never reached
 *               landed cost.
 *          Anything that fails a gate is reported with the reason and left alone.
 *
 * Usage:
 *   tsx src/cli/complete-received-pos.ts                 # report only
 *   tsx src/cli/complete-received-pos.ts --live
 *   --days <n>     order-date window (default 270)
 *   --po <id>      one PO
 *   --gap <ms>     pause between Finale calls (default 900)
 *
 * @author  Hermia
 * @created 2026-10-26
 * @deps    finale/client, finale/freight-adjustment, purchasing/vendor-freight-pattern
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { houseFreightChargeFor, VENDOR_PATTERN_OVERRIDES } from "../lib/purchasing/vendor-freight-pattern";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const DAYS = Number(argVal("--days") || 270);
const BEGIN = argVal("--begin");
const END = argVal("--end");
const ONLY_PO = argVal("--po");
const GAP = Number(argVal("--gap") || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FREIGHT_PROMO = "/10007";
const money = (n: number) => `$${Number(n).toFixed(2)}`;
const num = (v: unknown) => {
    const n = Number(String(v ?? "0").replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
};

interface Candidate {
    orderId: string;
    vendor: string;
    orderDate: string;
    status: string;
    ordered: number;
    received: number;
    remaining: number;
    freight: number[];
    allocOk: boolean;
    verdict: string;
}

async function main(): Promise<void> {
    const client: any = new FinaleClient();
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const auth = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString("base64")}`;

    const begin = new Date();
    begin.setDate(begin.getDate() - DAYS);
    const beginStr = BEGIN || begin.toISOString().slice(0, 10);
    const endStr = END || new Date().toISOString().slice(0, 10);
    const query = `{ orderViewConnection(first: 900, type: ["PURCHASE_ORDER"], orderDate: {begin: "${beginStr}", end: "${endStr}"}, sort: [{field: "orderDate", mode: "desc"}]) { edges { node {
        orderId status orderDate supplier { name } itemList(first: 100) { edges { node {
            productUnitsOrdered productUnitsReceived productUnitsRemainingToBeShipped } } } } } } }`;
    const res = await fetch(`${base}/${accountPath}/api/graphql`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    const json: any = await res.json();
    if (json.errors) {
        console.error("graphql:", JSON.stringify(json.errors).slice(0, 300));
        process.exit(1);
    }
    const nodes = (json.data?.orderViewConnection?.edges || []).map((e: any) => e.node);
    console.log(`scanned ${nodes.length} POs ${beginStr}..${endStr} | mode=${LIVE ? "LIVE" : "report only"}\n`);

    const candidates: Candidate[] = [];
    for (const n of nodes) {
        if (ONLY_PO && n.orderId !== ONLY_PO) continue;
        const lines = (n.itemList?.edges || []).map((e: any) => e.node);
        const ordered = lines.reduce((s: number, l: any) => s + num(l.productUnitsOrdered), 0);
        const received = lines.reduce((s: number, l: any) => s + num(l.productUnitsReceived), 0);
        const remaining = lines.reduce((s: number, l: any) => s + num(l.productUnitsRemainingToBeShipped), 0);
        // Only POs that look open AND fully received are worth a REST read.
        const looksOpen = /Committed|Draft/i.test(String(n.status));
        if (!looksOpen || remaining > 0 || received <= 0) continue;

        const doc: any = await client.getOrderDetails(n.orderId).catch(() => null);
        await sleep(GAP);
        if (!doc) continue;
        const items = (doc.orderItemList || []).length;
        const adj: any[] = doc.orderAdjustmentList || [];
        const freightLines = adj.filter((a) => String(a.productPromoUrl || "").includes(FREIGHT_PROMO));
        const amounts = freightLines.map((a) => Number(a.amount));
        const vendor = String(n.supplier?.name || "");
        const house = houseFreightChargeFor(vendor);
        const override = VENDOR_PATTERN_OVERRIDES.find((o) => vendor.toLowerCase().includes(o.match)) ?? null;
        const allocOk =
            freightLines.length > 0 &&
            freightLines.every(
                (a) =>
                    a.description === "Freight" &&
                    a.adjustmentAllocationEnumId === "ADJ_BY_WEIGHT" &&
                    Array.isArray(a.orderAdjustmentAllocationList) &&
                    a.orderAdjustmentAllocationList.length === items,
            );

        const hasHouse = house > 0 && amounts.some((a) => Math.abs(a - house) < 0.01);
        const beyondHouse = amounts.filter((a) => Math.abs(a - house) >= 0.01);
        let verdict: string;
        if (doc.statusId !== "ORDER_LOCKED") verdict = `status=${doc.statusId}`;
        else if (!freightLines.length) {
            verdict = override?.pattern === "no_freight" ? "ready (vendor needs no freight)" : "HOLD: no freight on PO";
        } else if (house > 0 && hasHouse && !beyondHouse.length) {
            verdict = "HOLD: house charge only, carrier bill missing";
        } else if (!allocOk) {
            verdict = "HOLD: freight line not allocated to landed cost";
        } else verdict = "ready";

        candidates.push({
            orderId: n.orderId,
            vendor: vendor || "(unknown)",
            orderDate: String(n.orderDate).slice(0, 10),
            status: doc.statusId,
            ordered,
            received,
            remaining,
            freight: amounts,
            allocOk,
            verdict,
        });
    }

    // "ready (vendor needs no freight)" is still ready - match the prefix, not equality.
    const ready = candidates.filter((c) => c.verdict.startsWith("ready"));
    const fs = await import("fs");
    fs.writeFileSync(`.tmp/complete-received-${beginStr}_${endStr}.json`, JSON.stringify(candidates, null, 1));
    console.log("order    date        vendor                    received/ordered  freight                 verdict");
    for (const c of candidates) {
        console.log(
            `${c.orderId.padEnd(9)}${c.orderDate}  ${c.vendor.slice(0, 24).padEnd(26)}${String(c.received).padStart(7)}/${String(c.ordered).padEnd(8)} ${(c.freight.map(money).join(" + ") || "-").padEnd(23)} ${c.verdict}`,
        );
    }
    console.log(`\n${candidates.length} committed + fully received | ${ready.length} ready to complete | ${candidates.length - ready.length} held`);

    if (!LIVE || !ready.length) {
        if (ready.length) console.log("re-run with --live to complete the ready ones.");
        return;
    }
    for (const c of ready) {
        try {
            await client.completeOrder(c.orderId);
            await sleep(GAP);
            const after: any = await client.getOrderDetails(c.orderId);
            console.log(`  ${c.orderId} -> ${after.statusId}`);
        } catch (e: any) {
            console.log(`  ${c.orderId} FAILED: ${String(e.message).slice(0, 90)}`);
        }
        await sleep(GAP);
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
