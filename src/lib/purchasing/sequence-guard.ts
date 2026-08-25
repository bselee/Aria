/**
 * @file    sequence-guard.ts
 * @purpose DB reliability guard #1: detect serial-sequence desync across the
 *          public schema (sequence last_value < max(id)) and AUTO-HEAL via
 *          setval. Heal-first, not alert-only — a desynced sequence is
 *          corrected in the same run that finds it, so the next INSERT does
 *          not hit a silent 23505 duplicate-key error.
 *
 *          Past incident (2026-08-24): qty_recommendations (49,689 vs 14,986),
 *          invoices_legacy, qty_reservations, po_sends, paid_invoices_legacy.
 *          The identification query below is generic — it scans every serial
 *          column in the public schema, not a hardcoded table list.
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
    /** Desynced sequences found by the scan (rows returned by the HAVING query). */
    checked: number;
    /** Sequences actually corrected via setval this run. */
    healed: Array<SequenceHeal>;
}

/**
 * Identification query: every serial column in the public schema whose
 * sequence last_value has fallen behind MAX(id). Zero rows = healthy.
 */
const IDENTIFY_DESYNC_SQL = `
SELECT c.relname AS table_name, a.attname AS column_name, pg_get_serial_sequence(c.relname, a.attname) AS seq_name, (SELECT last_value FROM pg_get_serial_sequence(c.relname, a.attname)) AS seq_last, COALESCE(MAX(t.id), 0) AS max_id
FROM pg_class c
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_class t ON t.oid = c.oid
WHERE c.relkind = 'r' AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') AND pg_get_serial_sequence(c.relname, a.attname) IS NOT NULL
GROUP BY c.relname, a.attname, pg_get_serial_sequence(c.relname, a.attname)
HAVING COALESCE(MAX(t.id), 0) > (SELECT last_value FROM pg_get_serial_sequence(c.relname, a.attname));
`;

/**
 * Scan the public schema for desynced serial sequences and heal any found.
 *
 * For every row where the sequence's last_value has fallen behind max(id),
 * immediately runs `SELECT setval($1, $2, true)` with (seq_name, max_id) so
 * the next nextval() returns max_id + 1. Each heal is logged loudly with
 * console.warn (table, seq, old last_value, new max). A failed setval on one
 * row is logged and skipped so the remaining sequences still get healed.
 *
 * Never throws: connection/query failures log and return
 * { checked: 0, healed: [] } so the cron tick survives a DB outage.
 *
 * @returns checked = desynced sequences found; healed = those corrected.
 */
export async function checkSequences(): Promise<SequenceCheckResult> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const healed: Array<SequenceHeal> = [];
    try {
        await client.connect();
        const res = await client.query(IDENTIFY_DESYNC_SQL);
        for (const row of res.rows) {
            const { table_name, column_name, seq_name, seq_last, max_id } = row;
            try {
                await client.query("SELECT setval($1, $2, true)", [seq_name, max_id]);
            } catch (err: any) {
                console.error(
                    `[sequence-guard] setval FAILED for ${table_name}.${column_name} ` +
                        `seq=${seq_name}: ${err?.message ?? err}`
                );
                continue;
            }
            healed.push({
                table: table_name,
                column: column_name,
                seq: seq_name,
                oldLast: Number(seq_last),
                maxId: Number(max_id),
            });
            console.warn(
                `[sequence-guard] HEALED desynced sequence: ${table_name}.${column_name} ` +
                    `seq=${seq_name} last_value=${seq_last} -> max(id)=${max_id}`
            );
        }
        return { checked: healed.length, healed };
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
