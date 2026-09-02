/**
 * @file    src/cli/backfill-po-tracking.ts
 * @purpose Backfill purchase_orders.tracking_numbers + push tracking to Finale
 *          custom fields for every PO that already has active shipment evidence
 *          but whose tracking_numbers never landed (the 2026-08-20 `.contains()`
 *          array-literal bug wrote empty arrays for ~56 POs before the fix).
 *
 *          Dry-run by default. Pass `--apply` to write purchase_orders AND push
 *          to Finale. Excludes inferred-PO evidence (magnet class, e.g. PO
 *          125178 / 567 inferred FedEx numbers).
 *
 * @author  Hermia
 * @created 2026-08-25
 * @env     PGRST_URL, Finale credentials (for --apply push)
 */
import { createClient } from "@/lib/db";
import {
    canonicalizeTrackingNumbers,
    syncLegacyPurchaseOrderTracking,
} from "@/lib/tracking/shipment-intelligence";

const APPLY = process.argv.includes("--apply");

const INFERRED_PO_SOURCES = new Set([
    "email_ingest_inferred",
    "email_tracking_inferred_po",
    "email_tracking_llm_po",
]);

interface Candidate {
    po: string;
    explicit: string[];
    inferred: number;
    current: string[] | null;
}

async function main() {
    const db = createClient();
    if (!db) { console.error("no db"); return; }

    // Valid PO set = rows that actually exist in the Finale mirror. Garbage that
    // leaked into shipments.po_numbers ("000000", "3244587-00", "9125195") is not
    // a real PO and must never be pushed to Finale.
    const { data: pos, error: posErr } = await db
        .from("purchase_orders")
        .select("po_number, tracking_numbers, lifecycle_state")
        .limit(5000);
    if (posErr) { console.error("purchase_orders err", posErr.message); return; }

    const poRows = new Map<string, { tracking: string[] | null; lifecycle: string | null }>();
    for (const p of pos || []) {
        poRows.set((p as any).po_number, {
            tracking: (p as any).tracking_numbers ?? null,
            lifecycle: (p as any).lifecycle_state ?? null,
        });
    }
    console.log(`purchase_orders mirror rows: ${poRows.size}`);

    const TERMINAL_STATES = new Set(["received", "completed"]);

    // Enumerate every PO that has at least one active shipment.
    const { data: ships, error: shipErr } = await db
        .from("shipments")
        .select("po_numbers, tracking_number, last_source, active")
        .limit(5000);
    if (shipErr) { console.error("shipments err", shipErr.message); return; }

    const poMap = new Map<string, { explicit: string[]; inferred: number }>();
    for (const s of ships || []) {
        if ((s as any).active !== true) continue;
        const isInferred = INFERRED_PO_SOURCES.has((s as any).last_source);
        for (const po of (s as any).po_numbers || []) {
            if (!po) continue;
            const cur = poMap.get(po) || { explicit: [], inferred: 0 };
            if (isInferred) cur.inferred++;
            else cur.explicit.push((s as any).tracking_number);
            poMap.set(po, cur);
        }
    }

    const candidates: Candidate[] = [];
    const skippedJunk: string[] = [];
    const skippedTerminal: string[] = [];
    for (const [po, v] of poMap) {
        const row = poRows.get(po);
        if (!row) { if (v.explicit.length) skippedJunk.push(po); continue; }
        if (TERMINAL_STATES.has(String(row.lifecycle || "").toLowerCase())) {
            if (v.explicit.length) skippedTerminal.push(po);
            continue;
        }
        if (v.explicit.length === 0) continue; // inferred-only → skip (magnet guard)

        const canonical = canonicalizeTrackingNumbers(v.explicit);
        const currentCanonical = row.tracking ? canonicalizeTrackingNumbers(row.tracking) : [];
        const same =
            currentCanonical.length === canonical.length &&
            canonical.every((t) => currentCanonical.includes(t));
        if (same) continue; // already correct
        candidates.push({ po, explicit: canonical, inferred: v.inferred, current: currentCanonical });
    }

    candidates.sort((a, b) => Number(a.po) - Number(b.po));

    console.log(`Candidates needing tracking sync: ${candidates.length}`);
    console.log(`Skipped (junk PO, not in mirror): ${skippedJunk.length}`);
    console.log(`Skipped (terminal lifecycle): ${skippedTerminal.length}`);
    console.log(`Mode: ${APPLY ? "APPLY (write purchase_orders + push Finale)" : "DRY-RUN (no writes)"}\n`);

    let applied = 0;
    for (const c of candidates) {
        const was = c.current && c.current.length ? c.current.join(", ") : "(empty)";
        const now = c.explicit.join(", ");
        console.log(`PO ${c.po}`);
        console.log(`   was: ${was}`);
        console.log(`   now: ${now}${c.inferred ? `  (+${c.inferred} inferred excluded)` : ""}`);

        if (APPLY) {
            try {
                await syncLegacyPurchaseOrderTracking(c.po);
                applied++;
                console.log(`   ✅ synced (purchase_orders + Finale)`);
            } catch (e: any) {
                console.log(`   ❌ ${e.message}`);
            }
        }
    }

    if (APPLY) {
        console.log(`\nApplied ${applied}/${candidates.length} syncs.`);
    } else {
        console.log(`\nRe-run with --apply to write purchase_orders + push to Finale.`);
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
