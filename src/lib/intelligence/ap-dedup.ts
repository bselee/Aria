/**
 * @file    src/lib/intelligence/ap-dedup.ts
 * @purpose Single source of truth for AP invoice deduplication.
 *          Used by the local-first forwarder (and only by it after Phase 2).
 *          Checks three layers:
 *            1. gmail_message_id + pdf_filename (exact)
 *            2. pdf_content_hash (SHA-256 of the PDF bytes)
 *            3. billcom_bills_ref (vendor_name + invoice_number)
 * @author  Hermia
 * @created 2026-07-09
 * @updated 2026-07-09 — Added Layer 3: billcom_bills_ref check
 * @deps    @/lib/storage/local-db
 */

import { getLocalDb } from "@/lib/storage/local-db";

/**
 * Returns true if this invoice PDF has already been forwarded.
 * Layers (checked in order):
 *   1. gmail_message_id + pdf_filename (exact)
 *   2. pdf_content_hash (SHA-256 of the PDF bytes)
 */
export function isDuplicate(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
): boolean {
  const db = getLocalDb();

  // Layer 1: message_id + filename
  const byKey = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE gmail_message_id = ? AND pdf_filename = ?
       AND status = 'FORWARDED'
       LIMIT 1`,
    )
    .get(gmailMessageId, pdfFilename);

  if (byKey) return true;

  // Layer 2: content hash
  const byHash = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE pdf_content_hash = ?
       AND status = 'FORWARDED'
       LIMIT 1`,
    )
    .get(pdfHash);

  return !!byHash;
}

/**
 * Full three-layer dedup check including bill.com reference table.
 * Returns true if this invoice should be skipped.
 *
 * @param gmailMessageId - Gmail message ID
 * @param pdfFilename - PDF attachment filename
 * @param pdfHash - SHA-256 hash of PDF bytes
 * @param vendorName - Vendor name (optional, for Layer 3)
 * @param invoiceNumber - Invoice number (optional, for Layer 3)
 * @returns true if already forwarded or already in Bill.com
 */
export function isAlreadyForwarded(
    gmailMessageId: string,
    pdfFilename: string,
    pdfHash: string,
    vendorName?: string,
    invoiceNumber?: string,
): boolean {
    // Layers 1-2: local forward dedup
    if (isDuplicate(gmailMessageId, pdfFilename, pdfHash)) return true;

    // Layer 3: billcom_bills_ref check
    if (vendorName && invoiceNumber) {
        try {
            const db = getLocalDb();
            const row = db.prepare(
                `SELECT 1 FROM billcom_bills_ref
                 WHERE LOWER(vendor_name) = LOWER(?)
                 AND invoice_number = ?
                 LIMIT 1`
            ).get(vendorName.trim(), invoiceNumber.trim());
            if (row) return true;
        } catch {
            // DB error — assume not forwarded (safe default)
        }
    }

    return false;
}
