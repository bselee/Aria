/**
 * @file Receivings PDF vendor allowlist — controls which vendors get PDF links
 *       and hover previews in the Receivings dashboard panel.
 * @purpose Single source of truth for Receivings PDF link/hover scope (list B).
 * @author Aria Coder
 * @created 2026-08-11
 * @deps none
 * @env none
 */

/** Bill 2026-08-11 list B — Receivings PDF link/hover scope only. */
export const RECEIVINGS_PDF_VENDORS = [
  "rootwise",
  "american extracts",
  "grassroots",
  "malibu",
  "lind marine",
  "lindmarine",
  "uline",
  "axiom",
] as const;

/**
 * Check whether a vendor name is in the Receivings PDF allowlist (list B).
 * Case-insensitive, normalizes spaces/underscores/dots, matches on substring inclusion.
 *
 * @param name - Vendor name to check (can be null/undefined — returns false)
 * @returns true if vendor is in the allowlist
 */
export function isReceivingsPdfVendor(name: string | null | undefined): boolean {
  const n = (name || "").toLowerCase().replace(/[_\s.]+/g, " ").trim();
  if (!n) return false;
  return RECEIVINGS_PDF_VENDORS.some((v) => n.includes(v));
}