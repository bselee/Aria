/**
 * @file    src/lib/tracking/populate-po-tracking.ts
 * @purpose Step 3 of the tracking ingest pipeline, referenced by the
 *          "Tracking Validation Autopilot" cron prompt
 *          (docs/operational-guides/hermes-cron-jobs.canonical.json).
 *
 *          THAT FILE DID NOT EXIST until now, so this stage never ran: the cron
 *          called a nonexistent path every 30 minutes and the PO tracking
 *          columns were only ever updated opportunistically, by
 *          upsertShipment's per-shipment hook when a shipment was freshly
 *          upserted with CONFIRMED evidence. Any PO whose shipments arrived
 *          before that hook existed — or whose evidence was never classified
 *          confirmed — kept an empty tracking_numbers column forever.
 *
 * WHAT IT DOES
 *   For every PO that has linked shipments, recompute purchase_orders
 *   .tracking_numbers from the shipments table via
 *   syncLegacyPurchaseOrderTracking(). That function owns all the safety rules
 *   (UPDATE-only, never inserts a phantom PO, skips null-vendor/closed POs,
 *   fail-closed on a failed shipments read), so this script is deliberately a
 *   thin driver and adds no write logic of its own.
 *
 * USAGE
 *   npx tsx --env-file=.env.local src/lib/tracking/populate-po-tracking.ts
 *   ... --apply     actually write (default is a dry run)
 *   ... --quiet     only print the summary
 *
 * SAFETY
 *   - Dry run by default.
 *   - Never creates purchase_orders rows.
 *   - Only considers POs that already appear in shipments.po_numbers, so it
 *     cannot resurrect the carrier-footer junk that was unlinked.
 *
 * @created 2026-10-30
 */
import { createClient } from "@/lib/db";
import { syncLegacyPurchaseOrderTracking } from "@/lib/tracking/shipment-intelligence";

const APPLY = process.argv.includes("--apply");
const QUIET = process.argv.includes("--quiet");

interface PoTrackingState {
    po_number: string;
    tracking_numbers: unknown;
    vendor_name: string | null;
    status: string | null;
}

async function main() {
    const db = createClient();
    if (!db) {
        console.error("[populate-po-tracking] no database client — aborting");
        process.exitCode = 1;
        return;
    }

    // 1. Every PO currently cited by at least one shipment.
    const linkedPos = new Set<string>();
    for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db
            .from("shipments")
            .select("po_numbers")
            .limit(1000)
            .offset(offset);
        if (error) {
            // Fail closed: a failed read is not evidence that nothing is linked.
            console.error(`[populate-po-tracking] shipments read failed: ${error.message}`);
            process.exitCode = 1;
            return;
        }
        if (!data?.length) break;
        for (const row of data as Array<{ po_numbers: unknown }>) {
            const pos = Array.isArray(row.po_numbers) ? row.po_numbers : [];
            for (const p of pos) if (p) linkedPos.add(String(p));
        }
        if (data.length < 1000) break;
    }
    console.log(`[populate-po-tracking] POs cited by shipments: ${linkedPos.size}`);

    // 2. Which of those have an empty tracking_numbers column?
    const candidates: string[] = [];
    const list = [...linkedPos];
    for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        const { data, error } = await db
            .from("purchase_orders")
            .select("po_number, tracking_numbers, vendor_name, status")
            .in("po_number", batch);
        if (error) {
            console.error(`[populate-po-tracking] purchase_orders read failed: ${error.message}`);
            process.exitCode = 1;
            return;
        }
        for (const po of (data ?? []) as PoTrackingState[]) {
            const t = Array.isArray(po.tracking_numbers) ? po.tracking_numbers : [];
            if (t.length === 0) candidates.push(po.po_number);
            else if (!QUIET) console.log(`  ok   ${po.po_number} — already has ${t.length}`);
        }
    }

    console.log(`[populate-po-tracking] POs with linked shipments but EMPTY tracking_numbers: ${candidates.length}`);
    if (!candidates.length) {
        console.log("[populate-po-tracking] nothing to do");
        return;
    }

    if (!APPLY) {
        console.log(`\nDRY RUN — would sync ${candidates.length} PO(s): ${candidates.slice(0, 20).join(", ")}${candidates.length > 20 ? " …" : ""}`);
        console.log("re-run with --apply to write");
        return;
    }

    // 3. Delegate every write to the guarded function.
    let synced = 0;
    for (const po of candidates) {
        try {
            await syncLegacyPurchaseOrderTracking(po);
            synced++;
            if (!QUIET) console.log(`  sync ${po}`);
        } catch (err: any) {
            console.warn(`  sync ${po} failed: ${err?.message || err}`);
        }
    }

    // 4. Report what actually changed.
    let stillEmpty = 0;
    let filled = 0;
    for (let i = 0; i < candidates.length; i += 100) {
        const batch = candidates.slice(i, i + 100);
        const { data } = await db
            .from("purchase_orders")
            .select("po_number, tracking_numbers")
            .in("po_number", batch);
        for (const po of (data ?? []) as PoTrackingState[]) {
            const t = Array.isArray(po.tracking_numbers) ? po.tracking_numbers : [];
            if (t.length) filled++;
            else stillEmpty++;
        }
    }
    console.log(`\n[populate-po-tracking] synced ${synced}/${candidates.length}`);
    console.log(`[populate-po-tracking] now populated: ${filled} | still empty: ${stillEmpty}`);
    if (stillEmpty) {
        console.log("[populate-po-tracking] still-empty POs are guarded-out by syncLegacyPurchaseOrderTracking (closed/status, null vendor, or no ACTIVE shipments) — that is intended, not a failure.");
    }
}

main().catch((err) => {
    console.error("[populate-po-tracking] fatal:", err?.message || err);
    process.exitCode = 1;
});
