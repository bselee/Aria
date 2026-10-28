/**
 * @file    src/lib/purchasing/invoice-delivery-link.ts
 * @purpose Event-driven invoice → PO linking. When an invoice lands in AP
 *          email (or the default inbox), link it to the vendor's CURRENT PO
 *          instead of leaving it unmatched for the dashboard to flag.
 *
 *          Bill (2026-10-28): "We could also recognize when an invoice comes
 *          through AP or bill.selee email and link to current PO for that
 *          vendor." Vendors like Miles/Cowoco/New Moon/CR Minerals/Rootwise/
 *          Thrive bill per delivery on blanket POs, so the current OPEN PO of
 *          the vendor is the invoice's PO.
 *
 *          Decision ladder (conservative — never link on an amount guess):
 *            1. Exactly ONE open PO for the vendor  → that PO (any vendor).
 *            2. Several open POs                     → line-match bill lines
 *               (qty + unit price) against each PO's line_items; link the PO
 *               with the highest unique line coverage.
 *            3. Zero open POs                        → most recent PO for the
 *               vendor; link only if its lines match the bill lines.
 *            Otherwise return null — the 30-minute batch matcher and the
 *            receivings panel handle what remains.
 *
 *          This module is READ-ONLY over the DB: it decides and returns the
 *          PO number. Callers apply the link through their own write paths
 *          (the forwarder stamps norm.poNumber before its upsert; the batch
 *          matcher writes po_number itself).
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db, @/lib/purchasing/deliver-bill-vendors
 */

import { createClient } from "@/lib/db";

/** PO statuses that mean the PO is still open to receive goods/bills. */
const OPEN_PO_STATUSES = new Set(["open", "partial", "committed", "locked", "created", "pending"]);

/** OCR junk identities that must never drive a vendor search. */
const JUNK_VENDOR_TOKENS = new Set(["", "error", "unknown", "null", "nan", "none", "unknown vendor"]);

export interface InvoiceLinkContext {
    /** OCR-derived vendor name (may be junk after a parse failure). */
    vendorName: string | null | undefined;
    /** Display name from the sending mailbox ("miles filippelli"). */
    senderName?: string | null;
    /** Invoice total — a $0 or missing total never drives a link. */
    total: number;
    /** Invoice date (ISO or YYYY-MM-DD). */
    invoiceDate?: string | null;
    /** Bill line items from OCR — used for multi-PO line matching. */
    lineItems?: Array<{ sku?: string; description?: string; qty: number; unit_price: number }>;
}

export interface InvoiceLinkDecision {
    linked: boolean;
    poNumber: string | null;
    confidence: "single_open_po" | "line_match" | "recent_po" | "none";
    reason: string;
}

function searchTerm(vendorName: string | null | undefined): string {
    // First significant word of ≥3 letters; "Miles Filippelli" → "miles".
    const words = String(vendorName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !["inc", "llc", "co", "ltd", "the", "and", "company"].includes(w));
    return words[0] || "";
}

function isJunkVendor(name: string | null | undefined): boolean {
    return JUNK_VENDOR_TOKENS.has(String(name ?? "").trim().toLowerCase());
}

interface PoRow {
    po_number?: string | null;
    vendor_name?: string | null;
    issue_date?: string | null;
    total_amount?: number | null;
    total?: number | null;
    status?: string | null;
    line_items?: unknown;
}

/** Parse line_items from purchase_orders (object array or JSON string). */
function poLines(po: PoRow | null | undefined): Array<{ quantity: number; unitPrice: number }> {
    let raw: unknown = po?.line_items;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Record<string, unknown>>)
        .map((li) => ({
            quantity: Number(li?.quantity ?? 0),
            unitPrice: Number(li?.unitPrice ?? 0),
        }))
        .filter((l) => l.quantity > 0);
}

/** Count bill lines matched to a PO's lines on (qty, unit price). */
function lineCoverage(billLines: Array<{ qty: number; unit_price: number }>, po: PoRow | null | undefined): number {
    const lines = poLines(po);
    if (lines.length === 0) return 0;
    let matched = 0;
    for (const bl of billLines) {
        if (!(bl.qty > 0)) continue;
        const hit = lines.some((pl) => {
            const qtyMatch = Math.abs(pl.quantity - bl.qty) < 0.001;
            const priceMatch = bl.unit_price > 0 ? Math.abs(pl.unitPrice - bl.unit_price) < 0.01 : true;
            return qtyMatch && priceMatch;
        });
        if (hit) matched++;
    }
    return matched;
}

/**
 * Find the current PO an incoming invoice belongs to. Pure decision — no
 * writes. Returns null when no confident target exists.
 */
export async function findCurrentPoForInvoice(ctx: InvoiceLinkContext): Promise<InvoiceLinkDecision | null> {
    const db = createClient();
    if (!db) return null;
    if (!(Number(ctx.total) > 0)) return null;

    const identity = isJunkVendor(ctx.vendorName) ? ctx.senderName : ctx.vendorName;
    if (isJunkVendor(identity)) {
        return {
            linked: false,
            poNumber: null,
            confidence: "none",
            reason: "no usable vendor identity on invoice or email",
        };
    }

    // ── Find the vendor's POs: direct ilike first, then first-term fallback ──
    let pos: PoRow[] = [];
    try {
        const { data } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, issue_date, total_amount, total, status, line_items")
            .ilike("vendor_name", `%${identity}%`)
            .order("issue_date", { ascending: false })
            .limit(15);
        pos = (data || []) as PoRow[];
    } catch (err: unknown) {
        console.warn(`[invoice-delivery-link] vendor PO query failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    if (pos.length === 0) {
        const term = searchTerm(identity);
        if (term) {
            try {
                const { data } = await db
                    .from("purchase_orders")
                    .select("po_number, vendor_name, issue_date, total_amount, total, status, line_items")
                    .ilike("vendor_name", `%${term}%`)
                    .order("issue_date", { ascending: false })
                    .limit(15);
                pos = (data || []) as PoRow[];
            } catch {
                return null;
            }
        }
    }
    if (pos.length === 0) {
        return { linked: false, poNumber: null, confidence: "none", reason: `no POs found for vendor "${identity}"` };
    }

    const open = pos.filter((p) => OPEN_PO_STATUSES.has(String(p.status || "").toLowerCase()));
    const billLines = (ctx.lineItems || []).filter((l) => Number(l.qty) > 0);

    // 1. Exactly one open PO — the vendor's current PO is the invoice's PO.
    if (open.length === 1) {
        const po = open[0];
        return {
            linked: true,
            poNumber: String(po.po_number),
            confidence: "single_open_po",
            reason: `single open PO ${po.po_number} for vendor "${identity}"`,
        };
    }

    // 2. Several open POs — line-match; link the best-covered PO only when it
    //    is strictly ahead of the rest.
    if (open.length > 1 && billLines.length > 0) {
        const scored = open
            .map((po) => ({ po, coverage: lineCoverage(billLines, po) }))
            .filter((s) => s.coverage > 0)
            .sort((a, b) => b.coverage - a.coverage);
        if (scored.length > 0 && (scored.length === 1 || scored[0].coverage > scored[1].coverage)) {
            const po = scored[0].po;
            return {
                linked: true,
                poNumber: String(po.po_number),
                confidence: "line_match",
                reason: `bill lines match ${scored[0].coverage} of ${billLines.length} lines on PO ${po.po_number}`,
            };
        }
        return {
            linked: false,
            poNumber: null,
            confidence: "none",
            reason: `${open.length} open POs and no unique line match — leave for batch matcher`,
        };
    }

    // 3. Zero open POs — the most recent PO wins only on a line match.
    if (billLines.length > 0 && pos.length > 0) {
        const recent = pos[0];
        const coverage = lineCoverage(billLines, recent);
        if (coverage > 0) {
            return {
                linked: true,
                poNumber: String(recent.po_number),
                confidence: "recent_po",
                reason: `no open PO; bill lines match ${coverage} lines on most recent PO ${recent.po_number}`,
            };
        }
    }

    return {
        linked: false,
        poNumber: null,
        confidence: "none",
        reason: open.length === 0 ? "no open PO and no line match on recent POs" : "no confident current PO",
    };
}
