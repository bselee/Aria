/**
 * @file    cleanup-vendor-invoices.ts
 * @purpose Multi-phase data quality cleanup for vendor_invoices table.
 *          Fixes misidentified vendor names, normalises name variants,
 *          deduplicates records, and re-parses invoices with $0 totals.
 *
 *          ACCOUNTING DATA — every mutation is logged, auditable, and reversible.
 *
 * @author  Will / Antigravity
 * @created 2026-03-18
 * @updated 2026-03-18
 * @deps    supabase/client
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * @usage
 *   # Dry-run (default) — shows what would change, writes nothing
 *   node --import tsx src/cli/cleanup-vendor-invoices.ts
 *
 *   # Apply Phase 1 only (fix vendor names from filenames)
 *   node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=1
 *
 *   # Apply Phase 2 only (normalise via aliases)
 *   node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=2
 *
 *   # Apply Phase 3 only (deduplicate)
 *   node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=3
 *
 *   # Apply all phases sequentially
 *   node --import tsx src/cli/cleanup-vendor-invoices.ts --apply
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "../lib/supabase";

// ── CLI Args ─────────────────────────────────────────────────────────────────
const APPLY = process.argv.includes("--apply");
const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
const PHASE_FILTER = phaseArg ? parseInt(phaseArg.split("=")[1], 10) : null;
const VERBOSE = process.argv.includes("--verbose");

function shouldRun(phase: number): boolean {
    return PHASE_FILTER === null || PHASE_FILTER === phase;
}

function log(msg: string) {
    console.log(msg);
}

// ── Phase 1: Fix "Accounts Payable" and misidentified vendor names ──────────

/**
 * Extracts the real vendor name from the filename embedded in the notes field.
 *
 * Patterns supported:
 *   "Invoice_APUS243722_from_AutoPot_Watering_Systems_USA.pdf"  → "AutoPot Watering Systems USA"
 *   "Invoice_131401_from_LOGAN_LABS_LLC.pdf"                     → "LOGAN LABS LLC"
 *   "Inv_FC_1955_from_PULSE_USA_INC._42016.pdf"                 → "PULSE USA INC."
 *   "Uline_Invoice_202057232_114477147_1.pdf"                    → "Uline"
 *   "BAS 124667_2026-03-13.pdf"                                  → null (can't extract)
 */
function extractVendorFromFilename(notes: string | null): string | null {
    if (!notes) return null;

    // Pattern 1: "_from_VENDOR_NAME.pdf" or "_from_VENDOR_NAME_NNNNN.pdf"
    const fromMatch = notes.match(/_from_([A-Za-z][A-Za-z0-9_.'& -]+?)(?:_\d{3,})?\.pdf/i);
    if (fromMatch) {
        // Replace underscores with spaces, clean up
        let vendor = fromMatch[1].replace(/_/g, " ").trim();
        // Remove trailing period artifacts
        vendor = vendor.replace(/\.\s*$/, "").trim();
        // Remove trailing number-only segments (like "_42016")
        vendor = vendor.replace(/\s+\d+$/, "").trim();
        if (vendor.length >= 3) return vendor;
    }

    // Pattern 2: "Uline_Invoice_*" → "Uline"
    const prefixMatch = notes.match(/— ([A-Za-z]+)_Invoice_/);
    if (prefixMatch) {
        return prefixMatch[1];
    }

    // Pattern 3: Known filename prefixes → vendor
    const FILENAME_VENDOR_MAP: Array<[RegExp, string]> = [
        [/AAA_Cooper_Invoice/i, "AAA Cooper Transportation"],
        [/S[0-9][A-Z][0-9]{3}\.PDF/i, "Arnold Machinery"],        // S4O548.PDF, S6A898.PDF
        [/IN\d{3}AAA\.pdf/i, "ABEL'S ACE HARDWARE"],               // IN049AAA.pdf, IN040AAA.pdf
        [/toyotacf_/i, "Toyota Commercial Finance"],
        [/pyebarkerfire_/i, "Peak Alarm"],                         // pyebarkerfire_MA-P-*
        [/BAS\s+PO\d+/i, "BuildASoil LLC"],                       // BAS PO124241-3-PDF.pdf
        [/PO\d{5,}-\d+-PDF\.pdf/i, "BuildASoil LLC"],             // PO124065-3-PDF.pdf
        [/Culligan/i, "Culligan Water"],
    ];

    for (const [pattern, vendor] of FILENAME_VENDOR_MAP) {
        if (pattern.test(notes)) {
            return vendor;
        }
    }

    return null;
}

/**
 * Extracts vendor name from the email subject line stored in raw_data.
 *
 * Patterns:
 *   "Invoice 145357 from Evergreen Growers Supply, LLC."
 *   "New payment request from AutoPot USA - Invoice APUS-243722"
 *   "Invoice 124424 due Mar 17, 2026 | Colorado Worm Company"
 */
function extractVendorFromSubject(subject: string | null): string | null {
    if (!subject) return null;

    // "from VENDOR" pattern
    const fromMatch = subject.match(/(?:from|payment to)\s+(.+?)(?:\s*[-|]|\s+due|\s+is\s|$)/i);
    if (fromMatch) {
        let vendor = fromMatch[1].replace(/[,.]$/, "").trim();
        if (vendor.length >= 3 && vendor !== "Accounts Payable") return vendor;
    }

    // "| VENDOR" pattern
    const pipeMatch = subject.match(/[|]\s*(.+?)\s*$/);
    if (pipeMatch) {
        const vendor = pipeMatch[1].trim();
        if (vendor.length >= 3) return vendor;
    }

    return null;
}

async function phase1_fixVendorNames() {
    log("\n══════════════════════════════════════════════════════════");
    log("  PHASE 1: Fix misidentified vendor names");
    log("══════════════════════════════════════════════════════════\n");

    const supabase = createClient();

    // Get all invoices with bad vendor names
    const badVendorNames = ["Accounts Payable", "Unknown Vendor"];
    const { data: badRecords } = await supabase
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, notes, raw_data, total")
        .in("vendor_name", badVendorNames);

    if (!badRecords || badRecords.length === 0) {
        log("✅ No misidentified vendor names found. Phase 1 complete.\n");
        return { fixed: 0, unfixable: 0 };
    }

    log(`Found ${badRecords.length} records with bad vendor names.\n`);

    let fixed = 0;
    let unfixable = 0;
    let deduped = 0;
    const unfixableList: Array<{ id: string; notes: string; total: number }> = [];

    for (const record of badRecords) {
        // Try filename first (most reliable)
        let newVendor = extractVendorFromFilename(record.notes);

        // Fall back to subject line
        if (!newVendor && record.raw_data?.subject) {
            newVendor = extractVendorFromSubject(record.raw_data.subject);
        }

        // Fall back to from address (strip email parts)
        if (!newVendor && record.raw_data?.from) {
            const from = (record.raw_data.from as string)
                .replace(/<[^>]+>/, "")
                .replace(/"/g, "")
                .trim();
            if (from.length >= 3 && !from.includes("@") && from !== "Accounts Payable") {
                newVendor = from;
            }
        }

        if (newVendor) {
            log(`  ${APPLY ? "✏️" : "🔍"} [${record.vendor_name}] → "${newVendor}" | inv#=${record.invoice_number ?? "?"} | $${record.total}`);
            if (APPLY) {
                const auditNote = `[vendor-fix ${new Date().toISOString().split("T")[0]}: "${record.vendor_name}" → "${newVendor}"]`;
                const { error } = await supabase
                    .from("vendor_invoices")
                    .update({
                        vendor_name: newVendor,
                        notes: record.notes ? `${record.notes} | ${auditNote}` : auditNote,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", record.id);
                if (error) {
                    // Unique constraint violation — a record with (newVendor, invoiceNumber) already exists.
                    // This means we have two records for the same invoice: one with the correct vendor name,
                    // and this one with the bad name. Compare them and keep the richer one.
                    if (error.message.includes("uq_vendor_invoices_vendor_inv") && record.invoice_number) {
                        const { data: existing } = await supabase
                            .from("vendor_invoices")
                            .select("id, total, subtotal, freight, tax, line_items, status")
                            .eq("vendor_name", newVendor)
                            .eq("invoice_number", record.invoice_number)
                            .single();

                        if (existing) {
                            // Score both: higher score = richer data
                            const scoreRecord = (r: any) => {
                                let s = 0;
                                if (Number(r.total) > 0) s += 10;
                                if (Number(r.subtotal) > 0) s += 5;
                                if (Number(r.freight) > 0) s += 3;
                                if (Number(r.tax) > 0) s += 2;
                                if (Array.isArray(r.line_items) && r.line_items.length > 0) s += 8;
                                if (r.status === "reconciled") s += 20;
                                if (r.status === "paid") s += 15;
                                return s;
                            };
                            const currentScore = scoreRecord(record);
                            const existingScore = scoreRecord(existing);

                            if (currentScore > existingScore) {
                                // Current (bad vendor) record is richer — delete existing, then rename current
                                log(`     🔄 Current record richer (${currentScore} vs ${existingScore}). Replacing existing.`);
                                await supabase.from("vendor_invoices").delete().eq("id", existing.id);
                                const { error: retryErr } = await supabase
                                    .from("vendor_invoices")
                                    .update({
                                        vendor_name: newVendor,
                                        notes: record.notes ? `${record.notes} | ${auditNote}` : auditNote,
                                        updated_at: new Date().toISOString(),
                                    })
                                    .eq("id", record.id);
                                if (retryErr) {
                                    log(`     ❌ Retry update failed: ${retryErr.message}`);
                                } else {
                                    fixed++;
                                    deduped++;
                                }
                            } else {
                                // Existing record is richer or equal — delete the current (bad vendor) record
                                log(`     🗑️ Existing record richer (${existingScore} vs ${currentScore}). Deleting bad copy.`);
                                await supabase.from("vendor_invoices").delete().eq("id", record.id);
                                fixed++;
                                deduped++;
                            }
                        } else {
                            log(`     ❌ Unique conflict but can't find existing record. Skipping.`);
                        }
                    } else {
                        log(`     ❌ Update failed: ${error.message}`);
                    }
                } else {
                    fixed++;
                }
            } else {
                fixed++;
            }
        } else {
            unfixable++;
            unfixableList.push({
                id: record.id,
                notes: record.notes?.substring(0, 80) ?? "(none)",
                total: record.total,
            });
            if (VERBOSE) {
                log(`  ⚠️  Cannot extract vendor | notes=${record.notes?.substring(0, 60) ?? "?"} | $${record.total}`);
            }
        }
    }

    log(`\n  Summary: ${fixed} fixable, ${unfixable} unfixable, ${deduped} cross-vendor dupes resolved`);
    if (unfixableList.length > 0 && unfixableList.length <= 20) {
        log(`\n  Unfixable records (need manual review):`);
        for (const r of unfixableList) {
            log(`    id=${r.id.substring(0, 8)}... | $${r.total} | ${r.notes}`);
        }
    }
    log("");

    return { fixed, unfixable, deduped };
}

// ── Phase 2: Normalise vendor names via aliases ─────────────────────────────

// Known vendor name variants → canonical Finale supplier name
// DECISION(2026-03-18): Hardcoded here for initial seeding.
// Future additions go through upsert to vendor_aliases table.
const CANONICAL_VENDOR_MAP: Record<string, string> = {
    // AutoPot
    "AutoPot Watering Systems USA": "AutoPot USA",
    "AutoPot Watering Systems USA.": "AutoPot USA",
    "Autopot Watering Systems USA": "AutoPot USA",
    "AutoPot USA": "AutoPot USA",
    "Autopot USA": "AutoPot USA",

    // Evergreen — all variants from filenames, subjects, and manual entry
    "Evergreen Growers Supply, LLC.": "Evergreen Growers Supply",
    "Evergreen Growers Supply, LLC": "Evergreen Growers Supply",
    "Evergreen Growers Supply LLC": "Evergreen Growers Supply",
    "Evergreen Growers Supply LLC.": "Evergreen Growers Supply",

    // Logan Labs
    "LOGAN LABS LLC": "Logan Labs LLC",
    "Logan Labs LLC": "Logan Labs LLC",
    "Logan Labs": "Logan Labs LLC",
    "LOGAN LABS": "Logan Labs LLC",
    "LOGAN LABS LLC.": "Logan Labs LLC",

    // Grassroots
    '"Grassroots Fabric Pots Inc."': "Grassroots Fabric Pots",
    "Grassroots Fabric Pots Inc.": "Grassroots Fabric Pots",
    "Grassroots Fabric Pots Inc": "Grassroots Fabric Pots",
    "Grassroots Fabric Pots": "Grassroots Fabric Pots",

    // ULINE
    "ULINE": "Uline",
    "Uline": "Uline",
    "accounts.receivable@uline.com": "Uline",

    // Arnold Machinery
    "ARNOLD MACHINERY CO": "Arnold Machinery",
    "Arnold Machinery Material Handling": "Arnold Machinery",
    "Arnold Machinery Co": "Arnold Machinery",
    "Arnold Machinery": "Arnold Machinery",

    // AAA Cooper
    "AAA Cooper Transportation": "AAA Cooper Transportation",

    // ABEL'S ACE HARDWARE
    "ABEL'S ACE HARDWARE": "Abel's Ace Hardware",
    "Abel's Ace Hardware": "Abel's Ace Hardware",

    // Toyota
    "Toyota Commercial Finance": "Toyota Commercial Finance",

    // Peak Alarm
    "Peak Alarm": "Peak Alarm",

    // Culligan
    "Culligan Water Colorado Online BillPay": "Culligan Water",
    "Culligan Water": "Culligan Water",

    // Jabb of the Carolinas
    "Jabb of the Carolinas Inc": "Jabb of the Carolinas",
    "Jabb of the Carolinas Inc.": "Jabb of the Carolinas",

    // Email addresses that should be vendor names
    "do-not-reply@wwex.com": "WWEX (Worldwide Express)",

    // Colorado Worm Company
    "Colorado Worm Company": "Colorado Worm Company",

    // BuildASoil internal
    "BuildASoil LLC": "BuildASoil LLC",

    // PULSE USA
    "PULSE USA, INC.": "Pulse USA",
    "PULSE USA INC.": "Pulse USA",
    "PULSE USA INC": "Pulse USA",
};

async function phase2_normaliseVendorNames() {
    log("\n══════════════════════════════════════════════════════════");
    log("  PHASE 2: Normalise vendor names via canonical mapping");
    log("══════════════════════════════════════════════════════════\n");

    const supabase = createClient();

    // Step 1: Seed vendor_aliases table
    log("  Step 2a: Seeding vendor_aliases table...\n");
    let aliasesSeeded = 0;

    for (const [alias, canonical] of Object.entries(CANONICAL_VENDOR_MAP)) {
        if (alias === canonical) continue; // Skip identity mappings

        if (APPLY) {
            const { error } = await supabase
                .from("vendor_aliases")
                .upsert(
                    { alias, finale_supplier_name: canonical },
                    { onConflict: "alias" }
                );
            if (error) {
                log(`    ❌ Alias upsert failed for "${alias}": ${error.message}`);
            } else {
                aliasesSeeded++;
            }
        } else {
            log(`    ${alias.padEnd(45)} → ${canonical}`);
            aliasesSeeded++;
        }
    }
    log(`\n  ${APPLY ? "Seeded" : "Would seed"} ${aliasesSeeded} aliases.\n`);

    // Step 2: Get all vendor_invoices and normalise using the map
    const { data: allInvoices } = await supabase
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, total, subtotal, freight, tax, line_items, status");

    if (!allInvoices) {
        log("  ❌ Failed to fetch invoices.\n");
        return { normalised: 0, deduped: 0 };
    }

    let normalised = 0;
    let deduped = 0;
    const normalisationChanges: Array<{ id: string; old: string; new: string; record: typeof allInvoices[0] }> = [];

    for (const inv of allInvoices) {
        const canonical = CANONICAL_VENDOR_MAP[inv.vendor_name];
        if (canonical && canonical !== inv.vendor_name) {
            normalisationChanges.push({ id: inv.id, old: inv.vendor_name, new: canonical, record: inv });
        }
    }

    // Group by change type for cleaner output
    const changeGroups: Record<string, { to: string; count: number; records: typeof normalisationChanges }> = {};
    for (const c of normalisationChanges) {
        const key = `${c.old} → ${c.new}`;
        if (!changeGroups[key]) changeGroups[key] = { to: c.new, count: 0, records: [] };
        changeGroups[key].count++;
        changeGroups[key].records.push(c);
    }

    log("  Step 2b: Normalising vendor names in vendor_invoices...\n");
    for (const [change, info] of Object.entries(changeGroups).sort((a, b) => b[1].count - a[1].count)) {
        log(`    ${APPLY ? "✏️" : "🔍"} ${change} (${info.count} records)`);

        if (APPLY) {
            // Update each record individually to handle unique constraint conflicts
            for (const c of info.records) {
                const { error } = await supabase
                    .from("vendor_invoices")
                    .update({
                        vendor_name: info.to,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", c.id);

                if (error) {
                    if (error.message.includes("uq_vendor_invoices_vendor_inv") && c.record.invoice_number) {
                        // Same dedup logic as Phase 1: compare the two records, keep the richer one
                        const { data: existing } = await supabase
                            .from("vendor_invoices")
                            .select("id, total, subtotal, freight, tax, line_items, status")
                            .eq("vendor_name", info.to)
                            .eq("invoice_number", c.record.invoice_number)
                            .single();

                        if (existing) {
                            const scoreRecord = (r: any) => {
                                let s = 0;
                                if (Number(r.total) > 0) s += 10;
                                if (Number(r.subtotal) > 0) s += 5;
                                if (Number(r.freight) > 0) s += 3;
                                if (Number(r.tax) > 0) s += 2;
                                if (Array.isArray(r.line_items) && r.line_items.length > 0) s += 8;
                                if (r.status === "reconciled") s += 20;
                                if (r.status === "paid") s += 15;
                                return s;
                            };
                            const currentScore = scoreRecord(c.record);
                            const existingScore = scoreRecord(existing);

                            if (currentScore > existingScore) {
                                await supabase.from("vendor_invoices").delete().eq("id", existing.id);
                                const { error: retryErr } = await supabase
                                    .from("vendor_invoices")
                                    .update({
                                        vendor_name: info.to,
                                        updated_at: new Date().toISOString(),
                                    })
                                    .eq("id", c.id);
                                if (!retryErr) { normalised++; deduped++; }
                                else { log(`      ❌ Retry failed: ${retryErr.message}`); }
                            } else {
                                await supabase.from("vendor_invoices").delete().eq("id", c.id);
                                normalised++;
                                deduped++;
                            }
                        }
                    } else {
                        log(`      ❌ Update failed for ${c.id.substring(0, 8)}: ${error.message}`);
                    }
                } else {
                    normalised++;
                }
            }
        } else {
            normalised += info.count;
        }
    }

    log(`\n  ${APPLY ? "Normalised" : "Would normalise"} ${normalised} records across ${Object.keys(changeGroups).length} name variants.`);
    if (deduped > 0) log(`  Resolved ${deduped} cross-vendor duplicates during normalisation.`);
    log("");
    return { normalised, deduped };
}

// ── Phase 3: Deduplicate cross-vendor records ───────────────────────────────

async function phase3_deduplicateRecords() {
    log("\n══════════════════════════════════════════════════════════");
    log("  PHASE 3: Deduplicate cross-vendor records");
    log("══════════════════════════════════════════════════════════\n");

    const supabase = createClient();

    // Find invoices that share the same (vendor_name, invoice_number)
    // After Phase 2, vendor names should be normalised, so true dupes should now
    // have identical vendor_name + invoice_number.
    const { data: allInvs } = await supabase
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, total, subtotal, freight, tax, line_items, status, created_at")
        .not("invoice_number", "is", null);

    if (!allInvs) {
        log("  ❌ Failed to fetch invoices.\n");
        return { deduped: 0 };
    }

    // Group by (vendor_name, invoice_number)
    const groups: Record<string, typeof allInvs> = {};
    for (const inv of allInvs) {
        const key = `${inv.vendor_name}::${inv.invoice_number}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(inv);
    }

    const dupeGroups = Object.entries(groups).filter(([_, records]) => records.length > 1);
    log(`  Found ${dupeGroups.length} duplicate groups.\n`);

    let deduped = 0;

    for (const [key, records] of dupeGroups) {
        // Score each record — higher is "richer" / more complete
        const scored = records.map((r) => {
            let score = 0;
            if (Number(r.total) > 0) score += 10;
            if (Number(r.subtotal) > 0) score += 5;
            if (Number(r.freight) > 0) score += 3;
            if (Number(r.tax) > 0) score += 2;
            if (Array.isArray(r.line_items) && r.line_items.length > 0) score += 8;
            if (r.status === "reconciled") score += 20;
            if (r.status === "paid") score += 15;
            return { ...r, score };
        });

        // Sort: highest score first, then newest created_at as tiebreaker
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

        const keep = scored[0];
        const remove = scored.slice(1);

        const [vendor, invNum] = key.split("::");
        log(`  ${APPLY ? "🗑️" : "🔍"} ${vendor} #${invNum}: keep id=${keep.id.substring(0, 8)}...(score=${keep.score}), remove ${remove.length} dupe(s)`);

        if (APPLY) {
            for (const r of remove) {
                const { error } = await supabase
                    .from("vendor_invoices")
                    .delete()
                    .eq("id", r.id);
                if (error) {
                    log(`      ❌ Delete failed for ${r.id}: ${error.message}`);
                } else {
                    deduped++;
                }
            }
        } else {
            deduped += remove.length;
        }
    }

    log(`\n  ${APPLY ? "Removed" : "Would remove"} ${deduped} duplicate records.\n`);
    return { deduped };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    log("╔══════════════════════════════════════════════════════════╗");
    log("║  VENDOR INVOICES DATA CLEANUP                           ║");
    log(`║  Mode: ${APPLY ? "🔴 APPLY (writing to database)" : "🟢 DRY-RUN (read-only preview)"}       ║`);
    if (PHASE_FILTER) {
        log(`║  Phase: ${PHASE_FILTER} only                                        ║`);
    }
    log("╚══════════════════════════════════════════════════════════╝");

    if (!APPLY) {
        log("\n  ℹ️  This is a DRY RUN. No data will be modified.");
        log("  ℹ️  To apply changes, run with --apply flag.\n");
    }

    const supabase = createClient();
    if (!supabase) {
        console.error("❌ Supabase client not initialized. Check env vars.");
        process.exit(1);
    }

    // Pre-flight: count total records
    const { count } = await supabase
        .from("vendor_invoices")
        .select("*", { count: "exact", head: true });
    log(`\n📊 Total records before cleanup: ${count}\n`);

    const results: Record<string, any> = {};

    if (shouldRun(1)) {
        results.phase1 = await phase1_fixVendorNames();
    }

    if (shouldRun(2)) {
        results.phase2 = await phase2_normaliseVendorNames();
    }

    if (shouldRun(3)) {
        results.phase3 = await phase3_deduplicateRecords();
    }

    // Post-flight: count after
    if (APPLY) {
        const { count: afterCount } = await supabase
            .from("vendor_invoices")
            .select("*", { count: "exact", head: true });
        log(`\n📊 Total records after cleanup: ${afterCount} (was ${count})\n`);
    }

    // Summary
    log("\n══════════════════════════════════════════════════════════");
    log(`  CLEANUP ${APPLY ? "COMPLETE" : "PREVIEW"}`);
    log("══════════════════════════════════════════════════════════");
    if (results.phase1) log(`  Phase 1 — Vendor fixes:  ${results.phase1.fixed} fixed, ${results.phase1.unfixable} unfixable, ${results.phase1.deduped ?? 0} dupes resolved`);
    if (results.phase2) log(`  Phase 2 — Normalisation: ${results.phase2.normalised} records`);
    if (results.phase3) log(`  Phase 3 — Deduplication: ${results.phase3.deduped} removed`);
    log("══════════════════════════════════════════════════════════\n");

    if (!APPLY) {
        log("  👆 To apply these changes, run:");
        log("     node --import tsx src/cli/cleanup-vendor-invoices.ts --apply\n");
        log("  Or apply one phase at a time:");
        log("     node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=1");
        log("     node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=2");
        log("     node --import tsx src/cli/cleanup-vendor-invoices.ts --apply --phase=3\n");
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
