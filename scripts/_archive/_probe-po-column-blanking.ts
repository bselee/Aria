// Does a normal evidence write blank a PO's tracking_numbers column? Re-write one
// row with the same values it already has, then read the PO column back.
import { Client } from "pg";
import { readFileSync } from "fs";
import { upsertShipmentEvidence } from "../src/lib/tracking/shipment-intelligence";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const read = async (po: string) =>
        (await c.query("select tracking_numbers from purchase_orders where po_number = $1", [po])).rows[0];

    console.log("before:", JSON.stringify(await read("23550677-DropshipPO")));
    await upsertShipmentEvidence({
        trackingNumber: "FedEx:::520484904168",
        source: "carrier_poll",
        confidence: 0.95,
        statusCategory: "delivered" as any,
        statusDisplay: "Delivered Sep 23",
        deliveredAt: "2026-09-23T21:43:00.000Z",
        poNumber: "23550677-DropshipPO",
    });
    console.log("after :", JSON.stringify(await read("23550677-DropshipPO")));
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
