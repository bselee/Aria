// Repair LTL rows whose carrier page shows a delivery the ledger never recorded.
//
// The AAA Cooper track page prints the truth in a fixed shape:
//   Pickup Date : 10/15/2026   Delivery Date Time : 10/21/2026 14:53
//   Status : Delivered         Signed For : Ben
//   2026-10-21 14:53  Delivered To Consignee In SAN DIEGO, CA
//
// tracking-service.ts does not read it: its delivered branch wants
// /delivered\s+(?:on\s+)?<date>/i, so the real date (which precedes the word
// "Delivered") is never captured, and the bare /\bdelivered\b/i fallback returns
// category=delivered with NO delivered_at. So the ledger keeps in_transit while
// the carrier says delivered, and any writer that fills the gap with now()
// invents a date. This script writes the carrier's own date instead.
//
// The wall time is in the destination's local zone, so the zone is required:
// an unknown state is refused rather than guessed.
//
// Usage: node --import tsx --env-file=.env.local scripts/fix-ltl-delivered-from-page.ts <PRO> [...] [--apply]
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");
const pros = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// Destination states we can resolve. Anything else is refused: a wrong offset
// is worse than a null timestamp.
const STATE_TZ: Record<string, string> = {
    KY: "America/Kentucky/Louisville",
    CA: "America/Los_Angeles",
    CO: "America/Denver",
    TX: "America/Chicago",
    FL: "America/New_York",
    OR: "America/Los_Angeles",
    WA: "America/Los_Angeles",
    NV: "America/Los_Angeles",
    AZ: "America/Phoenix",
    NY: "America/New_York",
    PA: "America/New_York",
    IL: "America/Chicago",
    OH: "America/New_York",
    MI: "America/Detroit",
    GA: "America/New_York",
    NC: "America/New_York",
    TN: "America/Chicago",
    MO: "America/Chicago",
    MN: "America/Chicago",
    UT: "America/Denver",
    ID: "America/Denver",
    MT: "America/Denver",
    NM: "America/Denver",
    NM_: "America/Denver",
    VA: "America/New_York",
    MD: "America/New_York",
    MA: "America/New_York",
    NJ: "America/New_York",
    WI: "America/Chicago",
    IN: "America/Indiana/Indianapolis",
};

/** Local wall clock in `zone` -> UTC ISO string. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): string {
    let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    for (let i = 0; i < 3; i++) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false,
        }).formatToParts(new Date(guess));
        const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
        const asIfUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), 0);
        const want = Date.UTC(y, mo - 1, d, h, mi, 0);
        const delta = want - asIfUtc;
        if (delta === 0) break;
        guess += delta;
    }
    return new Date(guess).toISOString();
}

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const db = new Database("aria-local.db");

    for (const pro of pros) {
        const url = `https://www.aaacooper.com/pwb/Transit/ProTrackResults.aspx?ProNum=${pro}&AllAccounts=true`;
        const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
        const text = (await res.text())
            .replace(/<script[\s\S]*?<\/script/gi, " ")
            .replace(/<style[\s\S]*?<\/style/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ");

        const m = text.match(
            /Delivery Date Time\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*Status\s*:\s*(\w[\w ]*?)\s*Signed For\s*:\s*([A-Za-z .'-]+?)\s+For real-time/i,
        );
        const dest = text.match(/Delivered To Consignee In\s+([A-Za-z .'-]+),\s*([A-Z]{2})\b/);
        if (!m || !dest) {
            console.log(`${pro}: page did not expose the delivery block — skipped (http ${res.status})`);
            continue;
        }
        const [, mo, d, y, h, mi, status, signed] = m;
        const [, city, state] = dest;
        const zone = STATE_TZ[state];
        const local = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ${h.padStart(2, "0")}:${mi} ${city}, ${state}`;
        if (!zone) {
            console.log(`${pro}: delivered ${local} per page, but state ${state} has no zone mapping — refused`);
            continue;
        }
        const utc = zonedToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), zone);
        console.log(`${pro}: page says ${status} / ${local} (${zone}) / signed ${signed.trim()} -> ${utc}`);

        const cur = await pg.query(
            "select tracking_number, status_category, status_display, delivered_at::text d, po_numbers from shipments where normalized_tracking_number = $1",
            [pro],
        );
        if (!cur.rowCount) {
            console.log(`  no PG row — skipped`);
            continue;
        }
        const row = cur.rows[0];
        // Compare instants, not strings: pg renders timestamp with tz as
        // "2026-10-26 07:25:00-06", never as the ISO Z form we wrote. String
        // comparison made this tool re-fire on every run and re-prefix the
        // annotation each time.
        const sameInstant = row.d ? new Date(row.d).toISOString() === utc : false;
        if (sameInstant && row.status_category === "delivered") {
            console.log(`  already delivered at ${utc} — no change`);
            continue;
        }
        if (!APPLY) {
            console.log(`  would set ${row.status_category}/${row.status_display} (${row.d}) -> delivered / Delivered ${mo}/${d} / ${utc}`);
            continue;
        }
        // Rows already annotated as outbound freight carry the evidence of why
        // they have no PO. Do not throw that away to show a date: prefix it.
        const annotated = /outbound|customer freight/i.test(String(row.status_display || ""));
        const display = annotated
            ? `Delivered ${Number(mo)}/${Number(d)} — ${row.status_display}`
            : `Delivered ${Number(mo)}/${Number(d)}`;
        const r = await pg.query(
            `update shipments set status_category = 'delivered', status_display = $2, delivered_at = $3, last_checked_at = now()
              where normalized_tracking_number = $1`,
            [pro, display, utc],
        );
        db.prepare(
            `update shipments_cache set status_category = 'delivered', status_display = ?, delivered_at = ?, updated_at = ? where tracking_number = ?`,
        ).run(display, utc, new Date().toISOString(), row.tracking_number);
        console.log(`  pg ${r.rowCount} row(s), cache updated`);
    }

    db.close();
    await pg.end();
    if (!APPLY) console.log("\ndry run — re-run with --apply");
})().catch((e) => console.error("ERR", e?.message || e));
