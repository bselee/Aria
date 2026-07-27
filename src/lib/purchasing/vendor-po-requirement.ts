/**
 * @file    src/lib/purchasing/vendor-po-requirement.ts
 * @purpose Determines whether a vendor name requires a purchase order.
 *          Vendors flagged as requires_po = false (service/utility/lab) have
 *          their invoices excluded from unmatched-invoice exception alerts.
 * @author  Hermia
 * @created 2026-08-01
 * @deps    @/lib/db (createClient — PostgREST)
 *
 * Usage:
 *   const map = await loadPoRequirementMap();
 *   if (!vendorRequiresPo("FedEx", map)) {
 *     // skip unmatched-invoice exception for FedEx
 *   }
 */

import { createClient } from "@/lib/db";

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  /** The loaded map from vendor_name → requires_po */
  map: Map<string, boolean>;
  /** Timestamp (ms) when the cache was populated */
  loadedAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

/** Module-scoped cache — survives across calls within the same process lifetime. */
let cache: CacheEntry | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load (or return cached) vendor → requires_po map from the database.
 *
 * Queries `vendor_profiles` for all rows and builds a Map of
 * vendor_name (string) → requires_po (boolean).
 * Absent vendors default to `true` (a purchase order is required).
 *
 * On any error (network, DB down, parse failure) returns an EMPTY map
 * so callers treat every vendor as requiring a PO — a DB hiccup can
 * never hide a real exception.
 *
 * Cache TTL is 60 seconds. Call this once per check; the module cache
 * handles the rest.
 *
 * @returns Promise<Map<string, boolean>> — never throws.
 */
export async function loadPoRequirementMap(): Promise<Map<string, boolean>> {
  // ── Check cache ─────────────────────────────────────────────────────────
  if (cache !== null && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.map;
  }

  // ── Fetch from DB ───────────────────────────────────────────────────────
  try {
    const db = createClient();
    const { data, error } = await db
      .from("vendor_profiles")
      .select("vendor_name, requires_po");

    if (error) {
      console.warn(
        "[vendor-po-requirement] DB query failed:",
        error instanceof Error ? error.message : String(error)
      );
      return new Map<string, boolean>();
    }

    if (!data || !Array.isArray(data)) {
      return new Map<string, boolean>();
    }

    const result = new Map<string, boolean>();
    for (const row of data) {
      if (row && typeof row.vendor_name === "string") {
        result.set(row.vendor_name, row.requires_po === true);
      }
    }

    // Update cache
    cache = { map: result, loadedAt: Date.now() };
    return result;
  } catch (err: unknown) {
    console.warn(
      "[vendor-po-requirement] Unexpected error loading vendor PO requirements:",
      err instanceof Error ? err.message : String(err)
    );
    return new Map<string, boolean>();
  }
}

/**
 * Check whether a given vendor name normally requires a purchase order.
 *
 * Pure function — no IO. Uses the pre-loaded map from `loadPoRequirementMap`.
 *
 * @param vendorName - The vendor name to check (case-sensitive against DB).
 * @param map        - The map returned by `loadPoRequirementMap()`.
 * @returns `true` if the vendor requires a PO (default when unknown),
 *          `false` if the vendor is explicitly flagged as service-only.
 */
export function vendorRequiresPo(
  vendorName: string,
  map: Map<string, boolean>
): boolean {
  if (!vendorName || typeof vendorName !== "string") {
    return true; // conservative default
  }

  const trimmed = vendorName.trim();
  if (trimmed === "") {
    return true;
  }

  // Default to TRUE — absence from the map means "needs a PO"
  const found = map.get(trimmed);
  return found !== false; // true when absent, false when explicitly set false
}

/**
 * Clear the module-level cache. Useful in tests and after a schema reload.
 */
export function clearPoRequirementCache(): void {
  cache = null;
}
