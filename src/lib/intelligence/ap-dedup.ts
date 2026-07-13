/**
 * @file    src/lib/intelligence/ap-dedup.ts
 * @purpose Single source of truth for AP invoice deduplication.
 *          Used by local-first forwarder AND ap-single-forward claim path.
 * @author  Hermia
 * @created 2026-07-09
 * @updated 2026-07-10 — CLAIMED counts as taken; hash-first
 * @deps    @/lib/storage/local-db
 */

import { getLocalDb } from "@/lib/storage/local-db";

const TAKEN_STATUSES = `('FORWARDED', 'CLAIMED', 'PENDING_SEND')`;

/**
 * Returns true if this invoice PDF has already been claimed or forwarded.
 * Content-hash is authoritative.
 */
export function isDuplicate(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
): boolean {
  const db = getLocalDb();

  // Layer 2 first: content hash
  const byHash = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE pdf_content_hash = ?
       AND status IN ${TAKEN_STATUSES}
       LIMIT 1`,
    )
    .get(pdfHash);
  if (byHash) return true;

  // Layer 1: message_id + filename (original or common sanitize variants)
  const byKey = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE gmail_message_id = ? AND pdf_filename = ?
       AND status IN ${TAKEN_STATUSES}
       LIMIT 1`,
    )
    .get(gmailMessageId, pdfFilename);

  return !!byKey;
}

/**
 * Full three-layer dedup check including bill.com reference table.
 */
export function isAlreadyForwarded(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
  vendorName?: string,
  invoiceNumber?: string,
): boolean {
  if (isDuplicate(gmailMessageId, pdfFilename, pdfHash)) return true;

  if (vendorName && invoiceNumber) {
    try {
      const db = getLocalDb();
      const row = db
        .prepare(
          `SELECT 1 FROM billcom_bills_ref
           WHERE LOWER(vendor_name) = LOWER(?)
           AND invoice_number = ?
           LIMIT 1`,
        )
        .get(vendorName.trim(), invoiceNumber.trim());
      if (row) return true;
    } catch {
      // DB error — assume not forwarded
    }
  }

  return false;
}
