/**
 * @file    src/lib/intelligence/ap-dedup.ts
 * @purpose Single source of truth for AP invoice deduplication.
 *          Used by the local-first forwarder (and only by it after Phase 2).
 *          Checks three layers: gmail_message_id + filename, pdf_content_hash.
 * @author  Hermia
 * @created 2026-07-09
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
