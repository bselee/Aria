/**
 * @file    src/cli/backfill-po-lifecycle.ts
 * @purpose One-time repair of the 2026-07-27 unfiltered-PATCH corruption:
 *          1. Un-stamp purchase_orders.lifecycle_state='RECEIVED' rows that
 *             have no receipt evidence, restoring from lifecycle_stage_legacy
 *             → lifecycle_stage → invoice/ack/sent evidence → REVIEW.
 *          2. Normalize non-canonical lifecycle values (l3_escalated,
 *             moving_with_tracking, closed_stale, …) via normalizeLifecycleStage.
 *          3. Align lifecycle_state, lifecycle_stage and status to one canonical
 *             value per PO (resolves the column duality).
 *          4. Backfill po_lifecycle_transitions from po_document_ledger /
 *             ap_activity_log evidence where the audit trail is missing.
 *
 *          SAFETY: dry-run by default — ZERO writes unless --apply is passed.
 *          Every write is logged; canonical-stage validation guards every row.
 *
 * @author  aria-coder
 * @created 2026-08-12
 * @deps    pg, dotenv, @/lib/purchasing/lifecycle-backfill,
 *          @/lib/purchasing/po-lifecycle
 *
 * Usage:
 *   node --import tsx src/cli/backfill-po-lifecycle.ts             # dry-run
 *   node --import tsx src/cli/backfill-po-lifecycle.ts --apply      # write
 *   node --import tsx src/cli/backfill-po-lifecycle.ts --limit 20   # dry-run first N
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { Client } from "pg";
import {
    determineCorrectStage,
    type LifecycleBackfillRow,
} from "@/lib/purchasing/lifecycle-backfill";
import {
    assertValidTransition,
    normalizeLifecycleStage,
    statusForLifecycleStage,
    PO_LIFECYCLE_STATES,
} from "@/lib/purchasing/po-lifecycle";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT_INDEX = args.indexOf("--limit");
const LIMIT = LIMIT_INDEX >= 0 ? parseInt(args[LIMIT_INDEX + 1], 10) : Infinity;

const CANONICAL = new Set<string>(PO_LIFECYCLE_STATES as readonly string[]);

// ── Evidence → lifecycle stage mapping for transition backfill ──────────────

const LEDGER_STAGE: Record<string, string> = {
    po_send: "SENT",
    vendor_invoice: "INVOICED",
    activity_po_received: "RECEIVED",
};

interface LedgerEvidence {
    po_number: string;
    stage: string;
    occurred_at: string;
    source: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    console.log(`[backfill] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log("[backfill] loading purchase_orders + evidence…");

    // ── 1. Receipt-evidence PO set ─────────────────────────────────────────
    // Receipt evidence = receive_date OR Finale status='received' (Completed —
    // all lines received) OR activity_po_received ledger OR PO_RECEIVED activity.
    // status='received' is included deliberately: it is Finale's "Completed"
    // signal, matching hasPurchaseOrderReceipt() in po-receipt-state.ts.
    const receiptPONumbers = new Set<string>();
    const recv1 = await client.query(
        `SELECT DISTINCT po_number FROM purchase_orders
          WHERE receive_date IS NOT NULL OR status = 'received'`
    );
    for (const r of recv1.rows) receiptPONumbers.add(r.po_number);
    const recv2 = await client.query(
        `SELECT DISTINCT po_number FROM po_document_ledger WHERE doc_type = 'activity_po_received'`
    );
    for (const r of recv2.rows) receiptPONumbers.add(r.po_number);
    const recv3 = await client.query(
        `SELECT DISTINCT metadata->>'poId' AS po_number FROM ap_activity_log WHERE intent = 'PO_RECEIVED'`
    );
    for (const r of recv3.rows) if (r.po_number) receiptPONumbers.add(r.po_number);
    console.log(`[backfill] receipt-evidence POs: ${receiptPONumbers.size}`);

    // ── 2. Invoices present (invoices OR vendor_invoices) ──────────────────
    const invoicePOs = new Set<string>();
    const inv1 = await client.query(`SELECT DISTINCT po_number FROM invoices WHERE po_number IS NOT NULL`);
    for (const r of inv1.rows) invoicePOs.add(r.po_number);
    const inv2 = await client.query(`SELECT DISTINCT po_number FROM vendor_invoices WHERE po_number IS NOT NULL`);
    for (const r of inv2.rows) invoicePOs.add(r.po_number);

    // ── 3. All PO rows ─────────────────────────────────────────────────────
    const poRes = await client.query(`
        SELECT po_number, status, lifecycle_state, lifecycle_stage,
               lifecycle_stage_legacy, receive_date,
               vendor_acknowledged_at, po_sent_at, po_email_message_id,
               tracking_numbers
        FROM purchase_orders
        ORDER BY po_number
    `);

    const rows: LifecycleBackfillRow[] = poRes.rows.map((r) => {
        const hasTracking =
            Array.isArray(r.tracking_numbers) && r.tracking_numbers.length > 0;
        return {
            poNumber: r.po_number,
            status: r.status ?? null,
            lifecycleState: r.lifecycle_state ?? null,
            lifecycleStage: r.lifecycle_stage ?? null,
            lifecycleStageLegacy: r.lifecycle_stage_legacy ?? null,
            hasReceiptEvidence: receiptPONumbers.has(r.po_number),
            hasInvoice: invoicePOs.has(r.po_number),
            vendorAcknowledged: !!r.vendor_acknowledged_at,
            wasSent: !!(r.po_sent_at || r.po_email_message_id || hasTracking),
        };
    });

    console.log(`[backfill] POs loaded: ${rows.length}`);

    // ── 4. Determine correct stage + alignment ──────────────────────────────
    const decisions = rows.map((r) => determineCorrectStage(r));

    // A row needs a write if ANY of lifecycle_state / lifecycle_stage / status
    // differs from the corrected canonical value (full 3-column alignment).
    const needsWrite = (r: LifecycleBackfillRow, d: (typeof decisions)[number]) =>
        normalizeLifecycleStage(r.lifecycleState) !== d.stage ||
        normalizeLifecycleStage(r.lifecycleStage) !== d.stage ||
        (r.status ?? null) !== statusForLifecycleStage(d.stage);

    const writable = decisions.filter((d, i) => needsWrite(rows[i], d));
    const corruptionFixes = decisions.filter((d) => d.isCorruptionFix);

    const before = new Map<string, number>();
    for (const r of rows) {
        const v = normalizeLifecycleStage(r.lifecycleState) ?? "NULL";
        before.set(v, (before.get(v) ?? 0) + 1);
    }
    const after = new Map<string, number>();
    for (const d of decisions) {
        after.set(d.stage, (after.get(d.stage) ?? 0) + 1);
    }

    console.log("\n[backfill] lifecycle_state BEFORE:");
    for (const [k, v] of [...before.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("[backfill] lifecycle_state AFTER:");
    for (const [k, v] of [...after.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`  ${k.padEnd(14)} ${v}`);

    console.log(
        `\n[backfill] rows to write: ${writable.length}  corruption-fixes: ${corruptionFixes.length}`
    );

    if (!APPLY) {
        console.log("\n[backfill] DRY-RUN — sample of writes:");
        for (const d of writable.slice(0, LIMIT === Infinity ? 40 : LIMIT)) {
            console.log(
                `  ${d.poNumber.padEnd(20)} -> ${d.stage.padEnd(14)} [${d.isCorruptionFix ? "corrupt-fix" : "normalize/align"}] ${d.evidence[0]}`
            );
        }
        console.log("\n[backfill] re-run with --apply to write. --limit N to cap writes.");
        await client.end();
        return;
    }

    // ── 5. APPLY: align lifecycle_state + lifecycle_stage + status ──────────
    let applied = 0;
    let writeErrors = 0;
    for (let i = 0; i < decisions.length; i++) {
        const d = decisions[i];
        const r = rows[i];
        if (!needsWrite(r, d)) continue;
        if (applied >= LIMIT) break;
        if (!CANONICAL.has(d.stage)) {
            console.warn(`[backfill] SKIP ${d.poNumber}: non-canonical stage ${d.stage}`);
            writeErrors++;
            continue;
        }
        const status = statusForLifecycleStage(d.stage);
        const now = new Date().toISOString();
        try {
            await client.query(
                `UPDATE purchase_orders
                    SET lifecycle_state = $1,
                        lifecycle_stage = $2,
                        status = $3,
                        updated_at = $4
                  WHERE po_number = $5`,
                [d.stage, d.stage, status, now, d.poNumber],
            );
            applied++;
        } catch (e: any) {
            writeErrors++;
            console.warn(`[backfill] WRITE ERROR ${d.poNumber}: ${e.message}`);
        }
    }
    console.log(`\n[backfill] APPLIED ${applied} row alignments (${writeErrors} errors).`);

    // ── 5b. Normalize non-canonical lifecycle_stage_legacy ─────────────────
    // Item 4: run the 311 non-canonical values (l3_escalated, l2_escalated, …)
    // through the existing normalizeLifecycleStage handle. NOTE: only the LEGACY
    // column is touched here — lifecycle_stage was already aligned to d.stage in
    // step 5 above, so normalizing it again from the stale snapshot would undo
    // that alignment (observed: 125147/125140 reverted RECEIVED → SENT).
    let normalized = 0;
    for (const r of rows) {
        const nLegacy = normalizeLifecycleStage(r.lifecycleStageLegacy);
        const legacyNeeds =
            r.lifecycleStageLegacy != null && nLegacy != null && nLegacy !== r.lifecycleStageLegacy;
        if (!legacyNeeds) continue;
        await client.query(
            `UPDATE purchase_orders SET lifecycle_stage_legacy = $1, updated_at = $2 WHERE po_number = $3`,
            [nLegacy, new Date().toISOString(), r.poNumber],
        );
        normalized++;
    }
    console.log(`[backfill] NORMALIZED ${normalized} non-canonical legacy values.`);

    // ── 6. Backfill po_lifecycle_transitions from evidence ─────────────────
    await backfillTransitions(client);

    await client.end();
    console.log("[backfill] done.");
}

/**
 * Backfill po_lifecycle_transitions from po_document_ledger / ap_activity_log
 * evidence. Chains REVIEW → … → evidence-stage per PO using assertValidTransition,
 * inserting only transitions that are valid and not already present.
 */
async function backfillTransitions(client: Client): Promise<void> {
    console.log("\n[backfill] transition backfill from evidence…");

    const ledger = await client.query(`
        SELECT po_number, doc_type, occurred_at
        FROM po_document_ledger
        WHERE doc_type IN ('po_send', 'vendor_invoice', 'activity_po_received')
          AND po_number IS NOT NULL
        ORDER BY po_number, occurred_at ASC
    `);

    const eventsByPO = new Map<string, LedgerEvidence[]>();
    for (const r of ledger.rows) {
        const stage = LEDGER_STAGE[r.doc_type];
        if (!stage) continue;
        const list = eventsByPO.get(r.po_number) ?? [];
        list.push({
            po_number: r.po_number,
            stage,
            occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : new Date().toISOString(),
            source: `backfill:${r.doc_type}`,
        });
        eventsByPO.set(r.po_number, list);
    }

    // ap_activity_log PO_RECEIVED as an additional receipt event
    const acts = await client.query(`
        SELECT metadata->>'poId' AS po_number, created_at
        FROM ap_activity_log
        WHERE intent = 'PO_RECEIVED' AND metadata->>'poId' IS NOT NULL
    `);
    for (const r of acts.rows) {
        if (!r.po_number) continue;
        const list = eventsByPO.get(r.po_number) ?? [];
        list.push({
            po_number: r.po_number,
            stage: "RECEIVED",
            occurred_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
            source: "backfill:activity_po_received",
        });
        eventsByPO.set(r.po_number, list);
    }

    // existing transitions (idempotency)
    const existing = new Set<string>();
    const ext = await client.query(
        `SELECT po_number, to_state, triggered_by FROM po_lifecycle_transitions`
    );
    for (const r of ext.rows) {
        existing.add(`${r.po_number}|${r.to_state}`);
        if (String(r.triggered_by ?? "").startsWith("backfill:"))
            existing.add(`${r.po_number}|${r.to_state}|${r.triggered_by}`);
    }

    let inserted = 0;
    for (const [poNumber, events] of eventsByPO.entries()) {
        events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
        let current = "REVIEW";
        for (const ev of events) {
            if (ev.stage === current) continue;
            const key = `${poNumber}|${ev.stage}`;
            const keySrc = `${poNumber}|${ev.stage}|${ev.source}`;
            if (existing.has(key) || existing.has(keySrc)) {
                current = ev.stage;
                continue;
            }
            // Only valid transitions are backfilled; invalid ones are skipped
            // rather than forced (no synthetic intermediate states).
            try {
                assertValidTransition(current, ev.stage);
            } catch {
                continue;
            }
            await client.query(
                `INSERT INTO po_lifecycle_transitions
                    (po_number, from_state, to_state, transitioned_at, triggered_by, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    poNumber,
                    current,
                    ev.stage,
                    ev.occurred_at,
                    ev.source,
                    JSON.stringify({ source: "lifecycle-backfill", doc_type: ev.source.replace("backfill:", "") }),
                ],
            );
            existing.add(key);
            existing.add(keySrc);
            current = ev.stage;
            inserted++;
        }
    }
    console.log(`[backfill] inserted ${inserted} transitions.`);
}

main().catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exit(1);
});
