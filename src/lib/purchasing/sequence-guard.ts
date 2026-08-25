/**
 * @file    sequence-guard.ts
 * @purpose DB reliability guard #1: detect serial-sequence desync across the
 *          public schema (sequence last_value < max(id)) and AUTO-HEAL via
 *          setval. Heal-first, not alert-only — a desynced sequence is
 *          corrected in the same run that finds it, so the next INSERT does
 *          not hit a silent 23505 duplicate-key error.
 *
 *          NOTE: this is a per-table loop, NOT a single SQL statement. The
 *          classic one-statement detection query (last_value via
 *          `FROM pg_get_serial_sequence(...)` and `MAX(t.id)` over a pg_class
 *          join) does NOT work: pg_get_serial_sequence returns text (not a
 *          relation you can SELECT last_value FROM) and pg_class has no id
 *          column. Verified against live PG16 2026-08-25.
 *
 *          Past incident (2026-08-24): qty_recommendations, invoices_legacy,
 *          qty_reservations, po_sends, paid_invoices_legacy.
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    pg (direct Client — setval needs a live connection, no PostgREST)
 * @env     DATABASE_URL (native Postgres 16 on :5432)
 */

import { Client } from "pg";

export interface SequenceHeal {
    table: string;
    column: string;
    seq: string;
    oldLast: number;
    maxId: number;
}

export interface SequenceCheckResult {
    /** Serial columns scanned this run. */
    checked: number;
    /** Sequences actually corrected via setval this run. */
    healed: Array<SequenceHeal>;
}

/**
 * Every serial/bigserial column in the public schema, with its sequence.
 * Only the column/table/sequence names — MAX(id) and last_value are fetched
 * per table afterwards because MAX(id) needs dynamic SQL against the real
 * table (not the catalog).
 */
const SERIAL_COLUMNS_SQL = `
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attname AS column_name,
       pg_get_serial_sequence(n.nspname || '.' || c.relname, a.attname) AS seq_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND pg_get_serial_sequence(n.nspname || '.' || c.relname, a.attname) IS NOT NULL
`;

/**
 * Quote a catalog identifier defensively. Names come from pg_catalog (trusted,
 * no double-quotes), but the guard is belt-and-suspenders.
 */
function qid(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Scan the public schema for desynced serial sequences and heal any found.
 *
 * For each serial column: read the sequence's last_value from pg_sequences,
 * read MAX(column) from the actual table, and if the table's max has outpaced
 * the sequence, run `SELECT setval($1, $2, true)` so the next nextval() is
 * max_id + 1. Each heal is logged loudly. A failed setval on one row is logged
 * and skipped so remaining sequences still get healed.
 *
 * Never throws: connection/query failures log and return
 * { checked: 0, healed: [] } so the cron tick survives a DB outage.
 */
export async function checkSequences(): Promise<SequenceCheckResult> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const healed: Array<SequenceHeal> = [];
    try {
        await client.connect();

        const serials = await client.query(SERIAL_COLUMNS_SQL);
        let scanned = 0;
        for (const row of serials.rows) {
            scanned++;
            const schemaName: string = row.schema_name;
            const tableName: string = row.table_name;
            const columnName: string = row.column_name;
            const seqName: string = row.seq_name;
            try {
                const lvRes = await client.query(
                    "SELECT last_value FROM pg_sequences WHERE schemaname || '.' || sequencename = $1",
                    [seqName],
                );
                const lastValue: number | null = lvRes.rows[0]?.last_value ?? null;

                const maxRes = await client.query(
                    `SELECT COALESCE(MAX(${qid(columnName)}), 0)::bigint AS max_id FROM ${qid(schemaName)}.${qid(tableName)}`,
                );
                const maxId = Number(maxRes.rows[0]?.max_id ?? 0);

                if (maxId <= 0) continue;
                if (lastValue != null && maxId <= Number(lastValue)) continue;

                try {
                    await client.query("SELECT setval($1, $2, true)", [seqName, maxId]);
                } catch (err: any) {
                    console.error(
                        `[sequence-guard] setval FAILED for ${tableName}.${columnName} ` +
                            `seq=${seqName}: ${err?.message ?? err}`,
                    );
                    continue;
                }
                healed.push({
                    table: tableName,
                    column: columnName,
                    seq: seqName,
                    oldLast: lastValue ?? 0,
                    maxId,
                });
                console.warn(
                    `[sequence-guard] HEALED desynced sequence: ${tableName}.${columnName} ` +
                        `seq=${seqName} last_value=${lastValue} -> max(id)=${maxId}`,
                );
            } catch (err: any) {
                console.error(
                    `[sequence-guard] check failed for ${tableName}.${columnName}: ${err?.message ?? err}`,
                );
            }
        }
        return { checked: scanned, healed };
    } catch (err: any) {
        console.error(`[sequence-guard] scan failed: ${err?.message ?? err}`);
        return { checked: 0, healed: [] };
    } finally {
        try {
            await client.end();
        } catch {
            // Best-effort close — nothing to recover here.
        }
    }
}
