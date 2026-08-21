/**
 * @file    src/cli/backfill-confirmed-po-matches.ts
 * @purpose Backfill the human-confirmed vendor→PO mapping table from historical
 *          overlap. confirmed_po_matches was empty (0 rows) even though the
 *          matcher had already assigned 291 distinct POs and 54 reconciliations
 *          auto-applied — the fine-tuning loop (95-point boost) had nothing to
 *          learn from. This script seeds it from three defensible sources:
 *
 *            1. vendor_invoices rows with a po_number whose PO exists in
 *               purchase_orders (already-matched invoices = confirmed pairs).
 *            2. reconciliation_outcomes where outcome='auto_applied'
 *               (vendor_name + po_id — a match the reconciler accepted).
 *            3. invoice_number values present in BOTH vendor_invoices and the
 *               legacy `invoices` table (the "in both tables" overlap).
 *
 *          SAFETY: dry-run by default — ZERO writes unless --apply is passed.
 *          The confirmed_po_matches UNIQUE(vendor_name, po_number) constraint
 *          makes every write idempotent.
 *
 * @author  aria-coder
 * @created 2026-08-12
 * @deps    @/lib/db, dotenv
 *
 * Usage:
 *   node --import tsx --env-file=.env.local src/cli/backfill-confirmed-po-matches.ts            # dry-run
 *   node --import tsx --env-file=.env.local src/cli/backfill-confirmed-po-matches.ts --apply    # write
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { createClient } from "@/lib/db";
import { isGarbageVendorName } from "@/lib/purchasing/three-way-match-runner";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT_INDEX = args.indexOf("--limit");
const LIMIT = LIMIT_INDEX >= 0 ? parseInt(args[LIMIT_INDEX + 1], 10) : Infinity;

interface Candidate {
    vendor_name: string;
    po_number: string;
    invoice_id: string | null;
    invoice_number: string | null;
    source: string;
}

function keyOf(vendor: string, po: string): string {
    return `${String(vendor ?? "").toLowerCase().trim()}::${String(po ?? "").trim()}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const db = createClient();
    if (!db) {
        console.error("[backfill-confirmed] no DB client");
        process.exit(1);
    }

    // Existing confirmed pairs (idempotency guard).
    const existingRes = await db.from("confirmed_po_matches").select("vendor_name, po_number");
    const existing = new Set<string>();
    for (const r of (existingRes.data ?? []) as any[]) {
        existing.add(keyOf(r.vendor_name, r.po_number));
    }

    // Local PO mirror — a pair is only "confirmed" if the PO actually exists.
    const poRes = await db.from("purchase_orders").select("po_number");
    const poSet = new Set<string>(
        ((poRes.data ?? []) as any[]).map((r: any) => String(r.po_number).trim()),
    );

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (c: Candidate) => {
        if (!c.vendor_name || !c.po_number) return;
        if (isGarbageVendorName(c.vendor_name)) return;
        const k = keyOf(c.vendor_name, c.po_number);
        if (seen.has(k)) return;
        seen.add(k);
        candidates.push(c);
    };

    // ── Source A: matched vendor_invoices (po_number set + PO exists locally) ─
    const viRes = await db
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, po_number")
        .not("po_number", "is", null)
        .limit(5000);
    const viRows = (viRes.data ?? []) as any[];
    for (const r of viRows) {
        const po = String(r.po_number).trim();
        if (!poSet.has(po)) continue;
        addCandidate({
            vendor_name: r.vendor_name,
            po_number: po,
            invoice_id: r.id ?? null,
            invoice_number: r.invoice_number ?? null,
            source: "vendor_invoices_match",
        });
    }

    // ── Source B: auto_applied reconciliation outcomes ────────────────────────
    const roRes = await db
        .from("reconciliation_outcomes")
        .select("vendor_name, po_id")
        .eq("outcome", "auto_applied")
        .limit(2000);
    for (const r of (roRes.data ?? []) as any[]) {
        if (!r.po_id || !r.vendor_name) continue;
        addCandidate({
            vendor_name: r.vendor_name,
            po_number: String(r.po_id).trim(),
            invoice_id: null,
            invoice_number: null,
            source: "auto_applied_outcome",
        });
    }

    // ── Source C: invoice_number present in BOTH tables ───────────────────────
    const legacyRes = await db.from("invoices").select("invoice_number, po_number, vendor_name").limit(5000);
    const legacyByInvoice = new Map<string, { po_number: string; vendor_name: string }>();
    for (const r of (legacyRes.data ?? []) as any[]) {
        const inv = String(r.invoice_number ?? "").trim();
        if (!inv) continue;
        if (!legacyByInvoice.has(inv)) {
            legacyByInvoice.set(inv, {
                po_number: String(r.po_number ?? "").trim(),
                vendor_name: r.vendor_name ?? "",
            });
        }
    }
    let overlapCount = 0;
    for (const r of viRows) {
        const inv = String(r.invoice_number ?? "").trim();
        if (!inv) continue;
        const legacy = legacyByInvoice.get(inv);
        if (!legacy) continue;
        overlapCount++;
        const po = legacy.po_number || String(r.po_number).trim();
        if (po && poSet.has(po)) {
            addCandidate({
                vendor_name: r.vendor_name || legacy.vendor_name,
                po_number: po,
                invoice_id: r.id ?? null,
                invoice_number: inv,
                source: "invoice_number_overlap",
            });
        }
    }

    const newCandidates = candidates.filter(
        (c) => !existing.has(keyOf(c.vendor_name, c.po_number)),
    );

    console.log(`[backfill-confirmed] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(
        `[backfill-confirmed] candidates=${candidates.length} already-confirmed=${existing.size} ` +
        `new=${newCandidates.length} invoice_number_overlap=${overlapCount}`,
    );

    if (!APPLY) {
        console.log("[backfill-confirmed] sample of new writes:");
        for (const c of newCandidates.slice(0, LIMIT === Infinity ? 40 : LIMIT)) {
            console.log(`  ${c.vendor_name.padEnd(28)} -> ${c.po_number.padEnd(12)} [${c.source}]`);
        }
        console.log("\n[backfill-confirmed] re-run with --apply to write. --limit N to cap writes.");
        return;
    }

    let written = 0;
    let writeErrors = 0;
    for (const c of newCandidates.slice(0, LIMIT)) {
        const { error } = await db.from("confirmed_po_matches").upsert(
            {
                vendor_name: c.vendor_name,
                po_number: c.po_number,
                invoice_id: c.invoice_id,
                invoice_number: c.invoice_number,
                confirmed_by: "backfill",
            },
            { onConflict: "vendor_name,po_number" },
        );
        if (error && !/duplicate|unique/i.test(error.message ?? "")) {
            writeErrors++;
            console.warn(`  WRITE ERROR ${c.po_number}: ${error.message}`);
        } else {
            written++;
        }
    }
    console.log(`[backfill-confirmed] WROTE ${written} confirmed matches (${writeErrors} errors).`);
}

main().catch((e) => {
    console.error("[backfill-confirmed] fatal:", e);
    process.exit(1);
});
