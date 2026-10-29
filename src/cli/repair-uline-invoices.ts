/**
 * @file    src/cli/repair-uline-invoices.ts
 * @purpose Repair already-stored Uline invoice identity (WS3.2, 2026-10-29).
 *
 *          Five recent Uline forwards landed with `invoice_number =
 *          "BERINVOICE"` and `po_number` = the 8-digit Uline web order
 *          (`ORDER #`), never the Finale PO, so no Uline receipt could link to
 *          its PO and three sat at "awaiting invoice" while the real invoice
 *          showed at match-score 70.
 *
 *          The true identity is in the document:
 *            `CUSTOMER NO. / PURCHASE ORDER NO.` jammed header
 *               `9897269125429` = customer 9897269 + Finale PO 125429
 *            `INVOICE #: 215047605`
 *          When the printed PO is absent, fall back to EXACT SKU overlap
 *          against `purchase_orders.line_items[].productId` (never substring —
 *          S-4738 is not S-473824).
 *
 *          Two passes, because the damage is stored twice:
 *            (1) `vendor_invoices` (PostgREST) — rows with a digit-less invoice
 *                number. Repaired in place and mirrored into SQLite
 *                (`ocr_invoice_number`, `matched_po_number`,
 *                `reconciliation_status`).
 *            (2) `ap_local_forwards` (SQLite) — FORWARDED rows whose
 *                `matched_po_number` is an 8-digit web order (or null). Two of
 *                the affected forwards (214717726, 213433278) have NO
 *                `vendor_invoices` row at all, so a ledger-only loop strands
 *                them: pass 2 repairs SQLite AND backfills the missing ledger
 *                row through `upsertVendorInvoice`.
 *
 *          Idempotent: after repair the invoice number carries digits and the
 *          PO is 12xxxx-shaped, so a second run finds nothing to do.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/repair-uline-invoices.ts
 *            → DRY RUN (default; prints the plan, writes nothing)
 *          node --import tsx --env-file=.env.local src/cli/repair-uline-invoices.ts --live
 *            → applies the repairs (`--dry-run` is accepted as a no-op alias)
 * @author  Hermia
 * @created 2026-10-29
 * @deps    @/lib/purchasing/uline-invoice-repair, @/lib/db, @/lib/storage/*
 */

import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";
import { createClient } from "@/lib/db";
import { getLocalDb } from "@/lib/storage/local-db";
import { downloadPDF } from "@/lib/storage/supabase-storage";
import {
    upsertVendorInvoice,
    type VendorInvoiceLineItem,
} from "@/lib/storage/vendor-invoices";
import {
    ulineInvoiceNumber,
    ulinePoFromRaw,
    isUlineVendorName,
    skusFromInvoiceLines,
    exactSkuOverlap,
    productIdsFromPoLines,
} from "@/lib/purchasing/uline-invoice-repair";

/** Finale internal PO shape. A Uline 8-digit web order is never a PO. */
const FINALE_PO_RE = /^12\d{4}$/;

const COLS =
    "id, invoice_number, po_number, vendor_name, total, source_ref, raw_data, line_items, pdf_storage_path";

/**
 * Dry run is the DEFAULT — live writes require an explicit `--live`. The
 * one-pass version defaulted to live, which is the wrong way round for a
 * script that rewrites AP identity.
 */
const LIVE = process.argv.includes("--live");
const DRY_RUN = !LIVE;

const STORAGE_ROOT = path.join(process.cwd(), "local", "storage");

type Db = NonNullable<ReturnType<typeof createClient>>;

interface VendorInvoiceRow {
    id: string;
    invoice_number: string | null;
    po_number: string | null;
    vendor_name: string | null;
    total: number | string | null;
    source_ref: string | null;
    raw_data: Record<string, unknown> | null;
    line_items: unknown;
    pdf_storage_path: string | null;
}

interface ForwardRow {
    id: number;
    gmail_message_id: string;
    pdf_filename: string | null;
    email_from: string | null;
    email_subject: string | null;
    ocr_raw_text: string | null;
    ocr_line_items: string | null;
    ocr_vendor_name: string | null;
    ocr_invoice_number: string | null;
    ocr_total: string | null;
    ocr_freight: string | null;
    ocr_tax: string | null;
    matched_po_number: string | null;
    reconciliation_status: string | null;
    reconciliation_notes: string | null;
}

interface Identity {
    invoiceNumber: string | null;
    poNumber: string | null;
    poSource: string;
}

interface PassStats {
    candidates: number;
    repaired: number;
    linked: number;
    needsReview: number;
    failed: number;
}

function emptyStats(): PassStats {
    return { candidates: 0, repaired: 0, linked: 0, needsReview: 0, failed: 0 };
}

/** Uline evidence on the row, even when OCR mangled the vendor name. */
function isUlineRow(row: VendorInvoiceRow): boolean {
    const raw = (row.raw_data ?? {}) as Record<string, unknown>;
    return (
        isUlineVendorName(row.vendor_name) ||
        isUlineVendorName(String(raw.email_from ?? "")) ||
        /uline/i.test(String(raw.pdf_filename ?? ""))
    );
}

function digitless(value: string | null | undefined): boolean {
    const v = String(value ?? "").trim();
    return !v || !/\d/.test(v);
}

/** A stored PO is only trustworthy when it is Finale-shaped. */
function isFinalePo(value: string | null | undefined): boolean {
    return FINALE_PO_RE.test(String(value ?? "").trim());
}

function toNumber(value: unknown): number | undefined {
    if (value == null || value === "") return undefined;
    const n = Number(String(value).replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : undefined;
}

/** Read the stored PDF text only when no OCR text survived the forward. */
async function reOcr(pdfStoragePath: string | null): Promise<string> {
    if (!pdfStoragePath) return "";
    try {
        const buf = await downloadPDF(pdfStoragePath);
        if (!buf) return "";
        const parsed = await pdfParse(buf);
        return String(parsed?.text ?? "");
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`   ✗ re-OCR ${pdfStoragePath}: ${msg}`);
        return "";
    }
}

/** Locate an already-stored PDF for a forward that has no ledger row yet. */
function findStoredPdf(pdfFilename: string): string | null {
    const name = String(pdfFilename ?? "").trim();
    if (!name || !fs.existsSync(STORAGE_ROOT)) return null;
    try {
        const entries = fs.readdirSync(STORAGE_ROOT, {
            recursive: true,
            encoding: "utf8",
        }) as string[];
        const hit = entries.find((rel) => {
            const norm = rel.split(path.sep).join("/");
            return norm === name || norm.endsWith(`/${name}`);
        });
        if (!hit) return null;
        return path.join("local", "storage", hit).replace(/\\/g, "/");
    } catch {
        return null;
    }
}

/** Invoice lines stored on the forward (OCR shape, already ext-priced). */
function lineItemsFromForward(forward: ForwardRow): VendorInvoiceLineItem[] {
    try {
        const parsed = JSON.parse(String(forward.ocr_line_items ?? "[]"));
        return Array.isArray(parsed) ? (parsed as VendorInvoiceLineItem[]) : [];
    } catch {
        return [];
    }
}

/** Printed total, else the sum of the printed line extensions. 0 = unknown. */
function forwardTotal(forward: ForwardRow, lines: VendorInvoiceLineItem[]): number {
    const stated = toNumber(forward.ocr_total);
    if (stated != null) return stated;
    return Math.round(lines.reduce((a, li) => a + (Number(li.ext_price) || 0), 0) * 100) / 100;
}

function skusForForward(forward: ForwardRow | undefined, fallbackLines: unknown): string[] {
    let lines: Array<{ sku?: string | null }> = [];
    const fromOcr = String(forward?.ocr_line_items ?? "");
    if (fromOcr) {
        try {
            const parsed = JSON.parse(fromOcr);
            if (Array.isArray(parsed)) lines = parsed;
        } catch {
            /* fall through to vendor_invoices line_items */
        }
    }
    if (lines.length === 0 && Array.isArray(fallbackLines)) {
        lines = fallbackLines as Array<{ sku?: string | null }>;
    }
    return skusFromInvoiceLines(lines);
}

/**
 * Fallback identity: the one Uline PO whose line items share an EXACT
 * productId with the invoice lines. Ambiguous (2+ POs) returns null for review.
 */
async function poByExactSku(db: Db, skus: string[]): Promise<string | null> {
    if (skus.length === 0) return null;
    const { data, error } = await db
        .from("purchase_orders")
        .select("po_number, vendor_name, total_amount, status, line_items")
        .ilike("vendor_name", "%uline%")
        .order("issue_date", { ascending: false })
        .limit(60);
    if (error) {
        // Never swallow a read error into a confident blank (WS1/WS5 lesson).
        console.warn(`   ✗ purchase_orders read failed: ${error.message}`);
        return null;
    }

    const hits = ((data ?? []) as Array<Record<string, unknown>>)
        .filter((po) => !/DropshipPO$/i.test(String(po.po_number ?? "")))
        .map((po) => ({
            poNumber: String(po.po_number ?? ""),
            matched: exactSkuOverlap(skus, productIdsFromPoLines(po.line_items)),
        }))
        .filter((h) => h.matched.length > 0 && isFinalePo(h.poNumber))
        .sort((a, b) => b.matched.length - a.matched.length);

    if (hits.length === 1) {
        console.log(`   SKU ${hits[0].matched.join(", ")} → PO ${hits[0].poNumber}`);
        return hits[0].poNumber;
    }
    if (hits.length > 1) {
        console.log(
            `   ambiguous SKU match (needs review): ${hits
                .map((h) => `${h.poNumber}(${h.matched.join("/")})`)
                .join(", ")}`,
        );
    }
    return null;
}

/** Recover invoice number + PO from raw text, printed PO first, SKU second. */
async function resolveIdentity(
    db: Db,
    rawText: string,
    pdfFilename: string,
    skus: string[],
): Promise<Identity> {
    const invoiceNumber = ulineInvoiceNumber(rawText, pdfFilename);
    let poNumber = ulinePoFromRaw(rawText);
    let poSource = poNumber ? "printed PO on invoice" : "";
    if (!poNumber) {
        poNumber = await poByExactSku(db, skus);
        poSource = poNumber ? "exact SKU overlap" : "";
    }
    return { invoiceNumber, poNumber, poSource };
}

// ── Pass 1: vendor_invoices (PostgREST) ──────────────────────────────────────

async function pass1VendorInvoices(db: Db, stats: PassStats): Promise<void> {
    const [{ data: byVendor, error: vendorErr }, { data: byNumber, error: numberErr }] =
        await Promise.all([
            db.from("vendor_invoices").select(COLS).ilike("vendor_name", "%uline%").limit(200),
            db.from("vendor_invoices").select(COLS).eq("invoice_number", "BERINVOICE").limit(200),
        ]);
    if (vendorErr) throw new Error(`vendor_invoices (uline) read failed: ${vendorErr.message}`);
    if (numberErr) throw new Error(`vendor_invoices (BERINVOICE) read failed: ${numberErr.message}`);

    const seen = new Map<string, VendorInvoiceRow>();
    for (const row of [...(byVendor ?? []), ...(byNumber ?? [])] as VendorInvoiceRow[]) {
        if (row?.id && !seen.has(row.id)) seen.set(row.id, row);
    }

    const candidates = [...seen.values()].filter(
        (row) => isUlineRow(row) && digitless(row.invoice_number),
    );
    stats.candidates = candidates.length;

    const sqlite = getLocalDb();
    const forwardByMessage = sqlite.prepare(
        `SELECT id, gmail_message_id, pdf_filename, email_from, email_subject,
                ocr_raw_text, ocr_line_items, ocr_vendor_name, ocr_invoice_number,
                ocr_total, ocr_freight, ocr_tax, matched_po_number,
                reconciliation_status, reconciliation_notes
         FROM ap_local_forwards
         WHERE gmail_message_id = ?
         ORDER BY id DESC
         LIMIT 1`,
    );
    const updateForward = sqlite.prepare(
        `UPDATE ap_local_forwards
         SET ocr_invoice_number = ?,
             matched_po_number = ?,
             reconciliation_status = ?,
             reconciliation_notes = COALESCE(reconciliation_notes, '') || ?
         WHERE id = ?`,
    );

    console.log(
        `\n[pass 1] vendor_invoices — Uline rows with a digit-less invoice number: ${candidates.length}`,
    );

    for (const row of candidates) {
        const raw = (row.raw_data ?? {}) as Record<string, unknown>;
        const pdfFilename = String(raw.pdf_filename ?? "");
        const forward = row.source_ref
            ? (forwardByMessage.get(String(row.source_ref)) as ForwardRow | undefined)
            : undefined;

        let rawText = String(forward?.ocr_raw_text ?? "");
        let textSource = rawText ? "ap_local_forwards.ocr_raw_text" : "";
        if (!rawText) {
            rawText = await reOcr(row.pdf_storage_path);
            textSource = rawText ? `re-OCR ${row.pdf_storage_path}` : "no text";
        }

        const existingInvoice = String(row.invoice_number ?? "").trim();
        const identity = await resolveIdentity(
            db,
            rawText,
            pdfFilename,
            skusForForward(forward, row.line_items),
        );

        const existingPo = String(row.po_number ?? "").trim();
        const resolvedPo = identity.poNumber ?? (isFinalePo(existingPo) ? existingPo : null);
        const poChanged = resolvedPo !== (existingPo || null);

        console.log(
            `\n${row.id} ${row.vendor_name ?? "—"} ${pdfFilename || "(no filename)"} total=${row.total ?? "—"}` +
                `\n   text: ${textSource}` +
                `\n   inv#:  ${existingInvoice || "∅"} → ${identity.invoiceNumber ?? "∅"}` +
                `\n   PO:    ${existingPo || "∅"} → ${resolvedPo ?? "∅"}${identity.poSource ? ` (${identity.poSource})` : ""}`,
        );

        if (!identity.invoiceNumber) {
            console.warn("   ✗ invoice number not recoverable — left for review");
            stats.needsReview++;
            continue;
        }
        if (!resolvedPo) stats.needsReview++;
        else stats.linked++;

        if (DRY_RUN) {
            stats.repaired++;
            continue;
        }

        try {
            const patch: Record<string, unknown> = {};
            if (identity.invoiceNumber !== existingInvoice) {
                patch.invoice_number = identity.invoiceNumber;
            }
            if (poChanged) patch.po_number = resolvedPo;
            if (Object.keys(patch).length > 0) {
                const { error } = await db.from("vendor_invoices").update(patch).eq("id", row.id);
                if (error) throw new Error(`vendor_invoices update failed: ${error.message}`);
            }

            if (forward) {
                const note = ` | Uline identity repair 2026-10-29: inv ${identity.invoiceNumber}, PO ${resolvedPo ?? "none"}${identity.poSource ? ` (${identity.poSource})` : ""}`;
                updateForward.run(
                    identity.invoiceNumber,
                    resolvedPo,
                    resolvedPo ? "PO_CANDIDATE" : "PO_UNMATCHED",
                    note,
                    forward.id,
                );
            } else {
                console.warn(
                    `   ⚠ no ap_local_forwards row for gmail message ${row.source_ref ?? "—"} — PostgREST only`,
                );
            }
            stats.repaired++;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`   ✗ ${msg}`);
            stats.failed++;
        }
    }
}

// ── Pass 2: ap_local_forwards (SQLite) + missing-ledger backfill ─────────────

async function pass2Forwards(db: Db, stats: PassStats): Promise<void> {
    const sqlite = getLocalDb();
    const rows = sqlite
        .prepare(
            `SELECT id, gmail_message_id, pdf_filename, email_from, email_subject,
                    ocr_raw_text, ocr_line_items, ocr_vendor_name, ocr_invoice_number,
                    ocr_total, ocr_freight, ocr_tax, matched_po_number,
                    reconciliation_status, reconciliation_notes
             FROM ap_local_forwards
             WHERE status = 'FORWARDED'
               AND (lower(pdf_filename) LIKE '%uline%'
                    OR lower(coalesce(email_from, '')) LIKE '%uline%'
                    OR ocr_invoice_number = 'BERINVOICE')
             ORDER BY id`,
        )
        .all() as ForwardRow[];

    // Only rows whose stored identity is still wrong: a digit-less invoice
    // number, or an 8-digit Uline web order sitting in the PO column.
    const candidates = rows.filter(
        (r) => digitless(r.ocr_invoice_number) || !isFinalePo(r.matched_po_number),
    );
    stats.candidates = candidates.length;

    const updateForward = sqlite.prepare(
        `UPDATE ap_local_forwards
         SET ocr_invoice_number = ?,
             matched_po_number = ?,
             reconciliation_status = ?,
             reconciliation_notes = COALESCE(reconciliation_notes, '') || ?
         WHERE id = ?`,
    );

    console.log(
        `\n[pass 2] ap_local_forwards — FORWARDED Uline rows with a non-Finale PO: ${candidates.length}`,
    );

    for (const forward of candidates) {
        const pdfFilename = String(forward.pdf_filename ?? "");
        let rawText = String(forward.ocr_raw_text ?? "");
        let textSource = rawText ? "ocr_raw_text" : "";
        if (!rawText) {
            const stored = findStoredPdf(pdfFilename);
            rawText = await reOcr(stored);
            textSource = rawText ? `re-OCR ${stored}` : "no text";
        }

        const skus = skusForForward(forward, null);
        const identity = await resolveIdentity(db, rawText, pdfFilename, skus);
        const existingInv = String(forward.ocr_invoice_number ?? "").trim();
        const lineItems = lineItemsFromForward(forward);
        const total = forwardTotal(forward, lineItems);

        // No document text and no readable PDF: the only "identity" left is the
        // filename. That is not enough to rewrite a ledger row (it would create
        // a $0 invoice with a null PO), so leave it for review.
        if (!rawText) {
            console.log(
                `\n#${forward.id} ${forward.ocr_vendor_name ?? "—"} ${pdfFilename || "(no filename)"}` +
                    `\n   text: none (OCR text gone, PDF not stored)` +
                    `\n   ✗ no source text — left for review (nothing written)`,
            );
            stats.needsReview++;
            continue;
        }

        // Is there already a ledger row for this document? (source_ref first —
        // that is how pass 1 leaves them — then the invoice number.)
        let ledgerId: string | null = null;
        {
            const { data, error } = await db
                .from("vendor_invoices")
                .select("id")
                .eq("source_ref", forward.gmail_message_id)
                .limit(1);
            if (error) console.warn(`   ✗ vendor_invoices (source_ref) read failed: ${error.message}`);
            ledgerId = (data?.[0] as { id?: string } | undefined)?.id ?? null;
        }
        if (!ledgerId && identity.invoiceNumber) {
            const { data, error } = await db
                .from("vendor_invoices")
                .select("id")
                .eq("invoice_number", identity.invoiceNumber)
                .limit(1);
            if (error) console.warn(`   ✗ vendor_invoices (invoice_number) read failed: ${error.message}`);
            ledgerId = (data?.[0] as { id?: string } | undefined)?.id ?? null;
        }

        const ledgerPlan = ledgerId
            ? `exists ${ledgerId}`
            : !identity.invoiceNumber
              ? "missing (no identity)"
              : total > 0
                ? "MISSING → backfill"
                : "MISSING → backfill SKIPPED (no total)";

        console.log(
            `\n#${forward.id} ${forward.ocr_vendor_name ?? "—"} ${pdfFilename || "(no filename)"} total=${forward.ocr_total ?? (total || "—")}` +
                `\n   text: ${textSource}` +
                `\n   inv#:  ${existingInv || "∅"} → ${identity.invoiceNumber ?? "∅"}` +
                `\n   PO:    ${forward.matched_po_number || "∅"} → ${identity.poNumber ?? "∅"}${identity.poSource ? ` (${identity.poSource})` : ""}` +
                `\n   ledger: ${ledgerPlan}`,
        );

        if (!identity.invoiceNumber) {
            console.warn("   ✗ invoice number not recoverable — left for review");
            stats.needsReview++;
            continue;
        }
        if (!identity.poNumber) {
            // A digit-enabled invoice number with no Finale PO is not a repair:
            // rewriting it would either fabricate a link or blank the only PO
            // evidence. Report it and leave the row untouched.
            console.warn("   ✗ no Finale PO recoverable — left for review (nothing written)");
            stats.needsReview++;
            continue;
        }
        stats.linked++;

        if (DRY_RUN) {
            stats.repaired++;
            continue;
        }

        try {
            const note = ` | Uline identity repair 2026-10-29 (forward): inv ${identity.invoiceNumber}, PO ${identity.poNumber}${identity.poSource ? ` (${identity.poSource})` : ""}`;
            updateForward.run(
                identity.invoiceNumber,
                identity.poNumber,
                "PO_CANDIDATE",
                note,
                forward.id,
            );

            if (!ledgerId) {
                if (total <= 0) {
                    // A ledger row with a $0 total would poison 3-way match.
                    console.warn(
                        "   ⚠ identity repaired; ledger backfill skipped (no total on the forward or its lines)",
                    );
                    stats.repaired++;
                    continue;
                }
                const freight = toNumber(forward.ocr_freight) ?? 0;
                const tax = toNumber(forward.ocr_tax) ?? 0;
                const subtotal = Math.max(0, Math.round((total - freight - tax) * 100) / 100);
                const created = await upsertVendorInvoice({
                    vendor_name: isUlineVendorName(forward.ocr_vendor_name)
                        ? String(forward.ocr_vendor_name)
                        : "Uline",
                    invoice_number: identity.invoiceNumber,
                    po_number: identity.poNumber,
                    subtotal,
                    freight,
                    tax,
                    total,
                    status: "received",
                    source: "email_attachment",
                    source_ref: forward.gmail_message_id,
                    pdf_storage_path: findStoredPdf(pdfFilename),
                    line_items: lineItems,
                    raw_data: {
                        email_from: forward.email_from ?? null,
                        email_subject: forward.email_subject ?? null,
                        pdf_filename: pdfFilename,
                        local_cache_id: `apfwd:${forward.gmail_message_id}:${pdfFilename}`,
                        repaired_by: "repair-uline-invoices.ts (WS3.2)",
                    },
                    notes: `Backfilled from ap_local_forwards #${forward.id} (Uline identity repair 2026-10-29)`,
                });
                if (created) console.log(`   ✓ ledger backfilled: ${created}`);
                else console.warn("   ⚠ ledger backfill returned null — row not created");
            }
            stats.repaired++;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`   ✗ ${msg}`);
            stats.failed++;
        }
    }
}

function report(label: string, s: PassStats): void {
    console.log(
        `${DRY_RUN ? "[DRY RUN] " : ""}${label}: candidates=${s.candidates} repaired=${s.repaired} linked=${s.linked} needs_review=${s.needsReview} failed=${s.failed}`,
    );
}

async function main(): Promise<void> {
    const db = createClient();
    if (!db) {
        throw new Error("createClient() returned null — PostgREST not reachable (PGRST_URL)");
    }

    console.log(
        `${DRY_RUN ? "[DRY RUN — no writes; pass --live to apply] " : "[LIVE] "}Uline invoice identity repair`,
    );

    const pass1 = emptyStats();
    const pass2 = emptyStats();

    await pass1VendorInvoices(db, pass1);
    await pass2Forwards(db, pass2);

    console.log("");
    report("pass 1 vendor_invoices", pass1);
    report("pass 2 ap_local_forwards", pass2);

    const failed = pass1.failed + pass2.failed;
    if (failed > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
});
