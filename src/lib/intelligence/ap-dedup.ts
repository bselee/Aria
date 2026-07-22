/**
 * @file    src/lib/intelligence/ap-dedup.ts
 * @purpose Single source of truth for AP invoice deduplication.
 *          Used by local-first forwarder AND ap-single-forward claim path.
 *          Rule: log once, never re-send the same invoice content or vendor+inv#.
 * @author  Hermia
 * @created 2026-07-09
 * @updated 2026-07-17 — vendor+invoice OCR, invoice_cache, SKIPPED logging
 * @deps    @/lib/storage/local-db
 */

import { getLocalDb } from "@/lib/storage/local-db";

/** Statuses that mean "do not send again" — always bound as parameters. */
const TAKEN_STATUS_LIST = ["FORWARDED", "CLAIMED", "PENDING_SEND"] as const;
const TAKEN_IN_CLAUSE = TAKEN_STATUS_LIST.map(() => "?").join(", ");

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
  const taken = [...TAKEN_STATUS_LIST];

  // Layer 2 first: content hash
  const byHash = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE pdf_content_hash = ?
       AND status IN (${TAKEN_IN_CLAUSE})
       LIMIT 1`,
    )
    .get(pdfHash, ...taken);
  if (byHash) return true;

  // Layer 1: message_id + filename (original or common sanitize variants)
  const byKey = db
    .prepare(
      `SELECT 1 FROM ap_local_forwards
       WHERE gmail_message_id = ? AND pdf_filename = ?
       AND status IN (${TAKEN_IN_CLAUSE})
       LIMIT 1`,
    )
    .get(gmailMessageId, pdfFilename, ...taken);

  return !!byKey;
}

/**
 * Full multi-layer dedup: hash, message+filename, vendor+invoice# (OCR/cache/Bill.com ref).
 * Prefer this when vendor/invoice are known so we never re-send a bill already logged.
 */
export function isAlreadyForwarded(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
  vendorName?: string,
  invoiceNumber?: string,
): boolean {
  if (isDuplicate(gmailMessageId, pdfFilename, pdfHash)) return true;

  const inv = (invoiceNumber || "").trim();
  const vendor = (vendorName || "").trim();
  if (vendor && inv && !/^(unknown|n\/a|na|none)$/i.test(inv)) {
    try {
      const db = getLocalDb();

      // Layer 3: already in Bill.com reference import
      try {
        const ref = db
          .prepare(
            `SELECT 1 FROM billcom_bills_ref
             WHERE LOWER(vendor_name) = LOWER(?)
             AND invoice_number = ?
             LIMIT 1`,
          )
          .get(vendor, inv);
        if (ref) return true;
      } catch {
        /* table may not exist in some envs */
      }

      // Layer 4: prior forward row with same OCR vendor+invoice
      const byOcr = db
        .prepare(
          `SELECT 1 FROM ap_local_forwards
           WHERE status IN (${TAKEN_IN_CLAUSE})
             AND LOWER(COALESCE(ocr_vendor_name, '')) = LOWER(?)
             AND ocr_invoice_number = ?
           LIMIT 1`,
        )
        .get(...takenParams(), vendor, inv);
      if (byOcr) return true;

      // Layer 5: local invoice_cache (365d AP logs)
      try {
        const byCache = db
          .prepare(
            `SELECT 1 FROM invoice_cache
             WHERE LOWER(vendor_name) = LOWER(?)
               AND invoice_number = ?
               AND expire_at > datetime('now')
             LIMIT 1`,
          )
          .get(vendor, inv);
        if (byCache) return true;
      } catch {
        /* non-fatal */
      }
    } catch {
      // DB error — assume not forwarded
    }
  }

  return false;
}

function takenParams(): string[] {
  return [...TAKEN_STATUS_LIST];
}

/**
 * Record a deliberate skip (routing / non-invoice / prepaid) so we log the
 * email without ever forwarding. Idempotent on message+filename.
 */
export function recordSkippedForward(args: {
  gmailMessageId: string;
  emailFrom: string;
  emailSubject: string;
  pdfFilename: string;
  pdfHash?: string;
  reason: string;
  vendorRoutingAction?: string;
}): void {
  try {
    const db = getLocalDb();
    const hash = args.pdfHash || `skip:${args.gmailMessageId}:${args.pdfFilename}`.slice(0, 64);
    const existing = db
      .prepare(
        `SELECT id FROM ap_local_forwards
         WHERE gmail_message_id = ? AND pdf_filename = ?
         LIMIT 1`,
      )
      .get(args.gmailMessageId, args.pdfFilename) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE ap_local_forwards
         SET status = 'SKIPPED',
             error_message = ?,
             vendor_routing_action = COALESCE(?, vendor_routing_action),
             forwarded_at = datetime('now')
         WHERE id = ?`,
      ).run(args.reason.slice(0, 500), args.vendorRoutingAction || null, existing.id);
      return;
    }
    db.prepare(
      `INSERT INTO ap_local_forwards
         (gmail_message_id, email_from, email_subject, pdf_filename, pdf_content_hash,
          status, error_message, vendor_routing_action, forwarded_at)
       VALUES (?, ?, ?, ?, ?, 'SKIPPED', ?, ?, datetime('now'))`,
    ).run(
      args.gmailMessageId,
      args.emailFrom,
      args.emailSubject,
      args.pdfFilename || "(none)",
      hash,
      args.reason.slice(0, 500),
      args.vendorRoutingAction || "skip",
    );
  } catch (e: any) {
    console.warn(`[ap-dedup] recordSkippedForward failed: ${e?.message || e}`);
  }
}
