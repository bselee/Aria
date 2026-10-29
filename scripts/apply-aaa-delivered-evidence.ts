// Apply AAA Cooper delivery evidence captured from the carrier PRO track page.
//
// The page was reachable for the first ~15 PROs of the sweep and then the site
// began returning its bare chrome page (~82 KB, no "Tracing Information"
// block) for every request — a throttle, not a change in shipment state. Those
// 15 delivery blocks were read directly off the carrier's own page and are
// recorded here verbatim so the repair does not depend on re-fetching:
//
//   Delivery Date Time : <M/D/YYYY HH:MM>   Status : Delivered   Signed For : <name>
//   <date>  Delivered To Consignee In <CITY>, <ST>
//
// Wall time is destination-local; the UTC value was computed with the state's
// IANA zone (see scripts/fix-ltl-delivered-from-page.ts, which produced these).
//
// Rows NOT in this table are unknown, not in-transit: the throttle means the
// carrier never answered for them.
//
// Usage: node --import tsx --env-file=.env.local scripts/apply-aaa-delivered-evidence.ts [--apply]
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");

type Ev = { pro: string; utc: string; display: string; evidence: string };
const EVIDENCE: Ev[] = [
    { pro: "64058443", utc: "2026-08-24T14:27:00.000Z", display: "Delivered 8/24", evidence: "2026-08-24 10:27 Toledo OH, signed Craig" },
    { pro: "64058902", utc: "2026-08-25T21:40:00.000Z", display: "Delivered 8/25", evidence: "2026-08-25 14:40 Tucson AZ, signed Tyler" },
    { pro: "64058444", utc: "2026-08-27T17:50:00.000Z", display: "Delivered 8/27", evidence: "2026-08-27 12:50 West Plains MO, signed Trey" },
    { pro: "64058901", utc: "2026-08-26T15:25:00.000Z", display: "Delivered 8/26", evidence: "2026-08-26 11:25 Salisbury NC, signed Robert Craver" },
    { pro: "64058903", utc: "2026-08-26T16:33:00.000Z", display: "Delivered 8/26", evidence: "2026-08-26 10:33 Commerce City CO, signed Derek K" },
    { pro: "64058445", utc: "2026-08-26T13:56:00.000Z", display: "Delivered 8/26", evidence: "2026-08-26 09:56 Grayson GA, signed Vlad" },
    { pro: "64058447", utc: "2026-08-31T15:10:00.000Z", display: "Delivered 8/31", evidence: "2026-08-31 10:10 Hazelwood MO, signed Corki Schuhwerk" },
    { pro: "64058446", utc: "2026-08-31T18:10:00.000Z", display: "Delivered 8/31", evidence: "2026-08-31 11:10 Santa Barbara CA, signed Driveway" },
    { pro: "64058448", utc: "2026-09-02T17:21:00.000Z", display: "Delivered 9/2", evidence: "2026-09-02 12:21 Ham Lake MN, signed Mike T" },
    { pro: "64058904", utc: "2026-09-04T17:51:00.000Z", display: "Delivered 9/4", evidence: "2026-09-04 12:51 Richfield MN, signed Ian" },
    { pro: "64058905", utc: "2026-09-08T18:09:00.000Z", display: "Delivered 9/8", evidence: "2026-09-08 13:09 Saint Robert MO, signed John Parker" },
    { pro: "71621328-5", utc: "2026-09-21T19:09:00.000Z", display: "Delivered 9/21", evidence: "2026-09-21 13:09 Montrose CO, signed Zach" },
    { pro: "64058907", utc: "2026-09-11T18:02:00.000Z", display: "Delivered 9/11", evidence: "2026-09-11 13:02 Saint Paul MN, signed M" },
    { pro: "64058909", utc: "2026-09-15T17:02:00.000Z", display: "Delivered 9/15", evidence: "2026-09-15 11:02 Fort Collins CO, signed Ryan" },
    { pro: "64058913", utc: "2026-09-17T18:20:00.000Z", display: "Delivered 9/17", evidence: "2026-09-17 12:20 Missoula MT, signed Steve" },
];

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const db = new Database("aria-local.db");
    let touched = 0;

    for (const e of EVIDENCE) {
        const cur = await pg.query(
            "select tracking_number, status_category, status_display, delivered_at::text d from shipments where normalized_tracking_number = $1",
            [e.pro],
        );
        if (!cur.rowCount) {
            console.log(`${e.pro}: no PG row — skipped`);
            continue;
        }
        const row = cur.rows[0];
        const already = row.d ? new Date(row.d).toISOString() === e.utc : false;
        if (already && row.status_category === "delivered") {
            console.log(`${e.pro}: already ${e.utc} — no change`);
            continue;
        }
        const annotated = /outbound|customer freight/i.test(String(row.status_display || ""));
        const display = annotated ? `${e.display} — ${row.status_display}` : e.display;
        const line = `${e.pro}: ${row.status_category}/${row.d ?? "null"} -> ${display} (${e.evidence})`;
        if (!APPLY) {
            console.log("would: " + line);
            continue;
        }
        const r = await pg.query(
            `update shipments set status_category = 'delivered', status_display = $2, delivered_at = $3, last_checked_at = now()
              where normalized_tracking_number = $1`,
            [e.pro, display, e.utc],
        );
        db.prepare(
            "update shipments_cache set status_category = 'delivered', status_display = ?, delivered_at = ?, updated_at = ? where tracking_number = ?",
        ).run(display, e.utc, new Date().toISOString(), row.tracking_number);
        touched += r.rowCount ?? 0;
        console.log("set: " + line);
    }

    db.close();
    await pg.end();
    console.log(`\n${APPLY ? "applied" : "dry run"} — ${touched || EVIDENCE.length} row(s) in scope`);
})().catch((e) => console.error("ERR", e?.message || e));
