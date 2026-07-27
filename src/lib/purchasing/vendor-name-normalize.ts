/**
 * @file    vendor-name-normalize.ts
 * @purpose Shared vendor name normalization and vendor_aliases resolution.
 *          Strips OCR noise (CRLF, trademark glyphs, punctuation variability)
 *          from raw invoice vendor names, then resolves them against the
 *          vendor_aliases table to produce canonical Finale supplier names.
 *
 *          All three exports are pure (or trivially cached) so the module
 *          is safe to import anywhere without side effects.
 *
 * @author  Hermia
 * @created 2026-07-27
 * @deps    @/lib/db (createClient)
 * @env     PGRST_URL / PGRST_JWT_SECRET — PostgREST endpoint for loadVendorAliases
 */

import { createClient } from "@/lib/db";

// ── Types ──────────────────────────────────────────────────────────────────

export interface VendorAliasRow {
    finale_supplier_name: string;
    alias: string;
}

// ── Normalize ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw vendor name string by stripping OCR noise and collapsing
 * whitespace. Returns an uppercase, trimmed string suitable for comparison.
 *
 * Strips:
 *  - CR / LF / CRLF line breaks embedded by PDF text extraction
 *  - Trademark (™), copyright (©), registered (®) glyphs
 *  - All runs of whitespace collapsed to a single space
 *
 * @param raw  Raw vendor name from OCR / invoice PDF extraction. May be
 *             null, undefined, or contain embedded control characters,
 *             trademark symbols, and irregular whitespace.
 * @returns    Normalized uppercase string, or '' for null/undefined/empty input.
 *
 * @example
 *   normalizeVendorName("AAA COOPER\\r\\nTRANSPORTATION™")
 *   // → "AAA COOPER TRANSPORTATION"
 *
 *   normalizeVendorName("  AutoPot  USA  ")
 *   // → "AUTOPOT USA"
 *
 *   normalizeVendorName(null)
 *   // → ""
 */
export function normalizeVendorName(raw: string | null | undefined): string {
    if (raw === null || raw === undefined || raw === "") return "";

    return raw
        // Strip CR / LF embedded by PDF text extraction (including \r\n pairs)
        .replace(/[\r\n]+/g, " ")
        // Strip trademark / copyright / registered symbols and similar
        .replace(/[™®©℠℗℞℟℠℡℣ℤ℥Ω℧ℨ℩KÅℬℭ℮ℯℰℱℲℳℴℵℶℷℸℹ℺℻ℼℽℾℿ⅀⅁⅂⅃⅄ⅅⅆⅇⅈⅉ]/gu, "")
        // Strip other non-ASCII dingbats / decorative chars that sneak in
        .replace(/[\u2000-\u206F\u2100-\u214F\u2190-\u21FF\u2300-\u23FF\u2400-\u243F\u2440-\u245F\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u27C0-\u27EF\u27F0-\u27FF\u2800-\u28FF\u2900-\u297F\u2980-\u29FF]/gu, " ")
        // Strip any trailing/leading quotes that wrapped the value
        .replace(/^["'\s]+|["'\s]+$/g, "")
        // Collapse all whitespace runs to single space
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

// ── Resolve canonical vendor via aliases ────────────────────────────────────

/**
 * Resolve a raw vendor name against the vendor_aliases table in memory.
 *
 * Both the raw name and each alias are normalized before comparison, so OCR
 * noise (CRLF, ™, case, whitespace) does not block a match.
 *
 * @param raw      Raw vendor name from an invoice (may be messy OCR text).
 * @param aliases  Array of alias rows from vendor_aliases. Pass the result
 *                 of loadVendorAliases() for a live DB-backed resolution, or
 *                 a static array in tests.
 * @returns        The canonical `finale_supplier_name` if an alias matches,
 *                 or `null` if no alias resolves.
 *
 * @example
 *   resolveCanonicalVendor("autopot usa", [
 *     { finale_supplier_name: "AutoPot USA", alias: "Autopot USA" },
 *     { finale_supplier_name: "AutoPot USA", alias: "AutoPot Watering Systems USA" },
 *   ])
 *   // → "AutoPot USA"
 *
 *   resolveCanonicalVendor("FakeCo LLC", [
 *     { finale_supplier_name: "AutoPot USA", alias: "Autopot USA" },
 *   ])
 *   // → null
 */
export function resolveCanonicalVendor(
    raw: string | null | undefined,
    aliases: VendorAliasRow[],
): string | null {
    const normalized = normalizeVendorName(raw);
    if (!normalized) return null;

    for (const row of aliases) {
        if (normalizeVendorName(row.alias) === normalized) {
            return row.finale_supplier_name;
        }
    }
    return null;
}

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
    data: VendorAliasRow[];
    loadedAt: number;
}

let _cache: CacheEntry | null = null;

/**
 * Load vendor_aliases from the database via PostgREST.
 *
 * Results are cached in module scope for 60 seconds. The table is tiny (32 rows)
 * and read constantly during batch matching, so caching avoids hammering the DB.
 *
 * @returns Array of { finale_supplier_name, alias } rows. Returns [] on any error
 *          (DB hiccup must never break invoice matching — degraded gracefully).
 */
export async function loadVendorAliases(): Promise<VendorAliasRow[]> {
    // Return cached data if within TTL
    if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) {
        return _cache.data;
    }

    try {
        const db = createClient();
        if (!db) return [];

        const { data, error } = await db
            .from("vendor_aliases")
            .select("finale_supplier_name, alias");

        if (error) {
            console.warn("[vendor-name-normalize] loadVendorAliases error:", error);
            // Return stale cache if we have one, else empty
            return _cache?.data ?? [];
        }

        const rows = (data ?? []) as VendorAliasRow[];
        _cache = { data: rows, loadedAt: Date.now() };
        return rows;
    } catch (err) {
        console.warn("[vendor-name-normalize] loadVendorAliases exception:", err);
        // Degrade gracefully — never throw
        return _cache?.data ?? [];
    }
}

/**
 * Clear the in-memory module-level cache. Useful in tests to force a fresh
 * load, or when the alias table changes at runtime.
 */
export function clearVendorAliasesCache(): void {
    _cache = null;
}
