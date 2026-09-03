/**
 * @file    src/cli/repair-failed-invoices.ts
 * @purpose Re-process vendor_invoices rows whose extraction_quality='failed' or
 *          'partial' by re-running the FIXED extraction chain (extractPDF →
 *          parseInvoice → normalizeInvoiceForDb) over the PDF still on disk.
 *
 *          Root cause fixed 2026-08-27 (PO 125212 / Aloe Corp 3327): the merge
 *          in normalizeInvoiceForDb trusted non-deterministic LLM output over
 *          deterministic regex. The same clean PDF produced poNumber=
 *          "C0000275" (customer number), total=0, invoiceDate=today across
 *          runs. Regex now wins for money/identity fields; LLM fills gaps.
 *
 *          SAFETY: dry-run by default. Pass --apply to write. Only touches
 *          rows where the PDF exists on disk AND the repaired extraction is
 *          strictly better (failed -> complete/partial, or partial -> complete).
 *          Never downgrades a row.
 *
 * @author  Hermia
 * @created 2026-08-27
 * @deps    tsx, @/lib/pdf/extractor, @/lib/pdf/invoice-field-normalize,
 *          @/lib/storage/vendor-invoices
 * @env     PGRST_URL (via .env.local)
 */
import { createClient } from "../lib/db";
import { readFileSync, existsSync } from "fs";
import { extractPDF } from "../lib/pdf/extractor";
import {
    normalizeInvoiceForDb,
    computeExtractionQuality,
} from "../lib/pdf/invoice-field-normalize";

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 200);

/** Resolve a stored 'local/storage/...' path to an absolute Windows path. */
function resolveStoragePath(p: string): string | null {
    if (!p) return null;
    const abs = p.replace(/^local\//, "C:/Users/BuildASoil/Documents/Projects/aria/local/");
    return existsSync(abs) ? abs : null;
}

const QUALITY_RANK = { failed: 0, partial: 1, complete: 2 } as const;

async function main() {
    const db = createClient();
    if (!db) { console.error("no db"); process.exit(1); }

    const { data: rows } = await db
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, po_number, total, extraction_quality, pdf_storage_path, source_ref")
        .in("extraction_quality", ["failed", "partial"])
        .limit(LIMIT);

    const targets = (rows || []).filter((r: any) => resolveStoragePath(r.pdf_storage_path));
    console.log(`targets: ${targets.length} of ${(rows || []).length} failed/partial rows have PDFs on disk`);
    console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"} (--apply to write)`);

    let repaired = 0, skipped = 0, errors = 0;
    for (const row of targets) {
        const pdfPath = resolveStoragePath(row.pdf_storage_path)!;
        try {
            const buf = readFileSync(pdfPath);
            const extraction = await extractPDF(buf);
            if ((extraction.rawText || "").trim().length < 20) {
                console.log(`  SKIP ${row.id} ${row.vendor_name}: extraction thin (${extraction.rawText?.length ?? 0} chars)`);
                skipped++;
                continue;
            }
            // Deterministic-only repair: pass parsed=null so normalizeInvoiceForDb
            // uses the regex layer exclusively (LLM not needed — regex is the
            // source of truth for money/identity fields; 2026-08-27 fix).
            const norm = normalizeInvoiceForDb(null, extraction.rawText, {});
            const newQuality = computeExtractionQuality({ total: norm.total, invoiceNumber: norm.invoiceNumber });

            const oldRank = QUALITY_RANK[(row.extraction_quality as keyof typeof QUALITY_RANK) ?? "failed"] ?? 0;
            const newRank = QUALITY_RANK[newQuality];
            if (newRank <= oldRank) {
                console.log(`  SKIP ${row.id} ${row.vendor_name} #${norm.invoiceNumber ?? "—"}: quality ${row.extraction_quality}->${newQuality} (no gain)`);
                skipped++;
                continue;
            }

            const line_items = norm.lineItems && norm.lineItems.length ? norm.lineItems : (row.line_items ?? []);
            console.log(
                `  ${APPLY ? "FIX" : "WOULD-FIX"} ${row.id} ${row.vendor_name} #${row.invoice_number ?? "—"}→#${norm.invoiceNumber ?? "—"} ` +
                `PO ${row.po_number ?? "—"}→${norm.poNumber ?? "—"} $${row.total}→$${norm.total} ` +
                `${row.extraction_quality}→${newQuality} (${extraction.ocrStrategy})`,
            );

            if (APPLY) {
                const { error } = await db.from("vendor_invoices").update({
                    invoice_number: norm.invoiceNumber,
                    po_number: norm.poNumber,
                    invoice_date: norm.invoiceDate,
                    subtotal: norm.subtotal,
                    freight: norm.freight,
                    tax: norm.tax,
                    total: norm.total,
                    line_items,
                    extraction_quality: newQuality,
                    updated_at: new Date().toISOString(),
                }).eq("id", row.id);
                if (error) throw error;
            }
            repaired++;
        } catch (e: any) {
            console.error(`  ERROR ${row.id} ${row.vendor_name}: ${e?.message || e}`);
            errors++;
        }
    }
    console.log(`DONE: repaired=${repaired} skipped=${skipped} errors=${errors}${APPLY ? " (applied)" : " (dry-run)"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
