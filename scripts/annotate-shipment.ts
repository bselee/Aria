/**
 * @file    scripts/annotate-shipment.ts
 * @purpose Record document truth on ONE shipment row without inventing a PO: set the display string
 *          the dashboard shows, append a provenance entry to source_refs, and mirror the display into
 *          the SQLite cache. This is the tool for outbound customer freight (we are the shipper, so no
 *          purchase order exists) and for deliberately unlinked vendor shipments.
 *
 *          Guards:
 *            - the row must exist and be found by one unambiguous tracking match
 *            - refuses a row that cites a PO when the new note would hide it, unless --allow-linked
 *              (an annotated display must not become the reason a live link is forgotten)
 *            - never writes po_numbers; linking is link-tracking-to-po.ts's job
 *
 * @usage   node --import tsx --env-file=.env.local scripts/annotate-shipment.ts <tracking> --note "text" [--trace "ORDER 4798"]... [--active|--inactive] [--apply]
 */
import { readFileSync } from "fs";
import { Client } from "pg";
import Database from "better-sqlite3";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALLOW_LINKED = args.includes("--allow-linked");
const setActive = args.includes("--active") ? true : args.includes("--inactive") ? false : null;
const noteIdx = args.indexOf("--note");
const NOTE = noteIdx >= 0 ? args[noteIdx + 1] : "";
const traces: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--trace") traces.push(args[i + 1]);
const TRACKING = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--note" && args[i - 1] !== "--trace");

(async () => {
  if (!TRACKING || !NOTE) {
    console.error('usage: annotate-shipment.ts <tracking> --note "text" [--trace "ref"]... [--active|--inactive] [--apply]');
    process.exit(1);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const bare = TRACKING.replace(/^.*:::/, "");
  const rows = (
    await c.query(
      `select id, tracking_number, tracking_key, po_numbers, active, status_display
         from shipments
        where upper(tracking_number) = upper($1) or upper(tracking_number) like $2`,
      [TRACKING, `%:::${bare.toUpperCase()}`],
    )
  ).rows;
  if (rows.length !== 1) {
    console.error(`REFUSING: ${rows.length} rows match ${TRACKING} - resolve ambiguity first`);
    if (rows.length) for (const r of rows) console.log(JSON.stringify(r));
    await c.end();
    process.exit(2);
  }
  const row = rows[0];
  const pos: string[] = row.po_numbers ?? [];
  if (pos.length && !ALLOW_LINKED) {
    console.error(`REFUSING: ${row.tracking_number} cites PO(s) ${JSON.stringify(pos)}; pass --allow-linked if the note does not hide that link`);
    await c.end();
    process.exit(2);
  }
  console.log(`row: ${row.tracking_number} pos=${JSON.stringify(pos)} active=${row.active}`);
  console.log(`note: ${NOTE}`);
  if (traces.length) console.log(`traces: ${JSON.stringify(traces)}`);

  if (APPLY) {
    const refs = JSON.stringify([
      {
        source: "manual_annotation",
        sourceRef: "annotate-shipment",
        seenAt: new Date().toISOString(),
        documentRefs: traces,
        note: NOTE,
      },
    ]);
    await c.query(
      `update shipments
          set status_display = $2,
              active = coalesce($3, active),
              source_refs = coalesce(source_refs, '[]'::jsonb) || $4::jsonb,
              updated_at = now()
        where id = $1`,
      [row.id, NOTE, setActive, refs],
    );

    const db = new Database("aria-local.db", { timeout: 8000 });
    const existing = db
      .prepare(`select tracking_number from shipments_cache where upper(tracking_number) = upper(?)`)
      .get(row.tracking_number) as { tracking_number: string } | undefined;
    if (existing) {
      db.prepare(`update shipments_cache set status_display = ?, updated_at = datetime('now') where upper(tracking_number) = upper(?)`).run(
        NOTE,
        existing.tracking_number,
      );
      console.log(`cache updated: ${existing.tracking_number}`);
    } else {
      console.log("cache: no row (nothing to mirror)");
    }
    db.close();
    console.log("applied");
  } else {
    console.log("dry run - pass --apply");
  }
  await c.end();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
