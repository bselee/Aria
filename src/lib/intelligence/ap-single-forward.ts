/**
 * @file    src/lib/intelligence/ap-single-forward.ts
 * @purpose THE only path that may send an AP invoice PDF to Bill.com.
 *          Atomic claim in SQLite BEFORE Gmail send so concurrent callers
 *          (local forwarder, Supabase forwarder, inline handler, ap-agent,
 *          dashboard) cannot double-forward the same invoice.
 * @author  Hermia
 * @created 2026-07-10
 * @updated 2026-07-10 — ERROR reclaim, hash-first claim, health-check ready
 * @deps    local-db, gmail, crypto
 * @env     BILL_COM_FORWARD_EMAIL (default: buildasoilap@bill.com)
 *
 * INVARIANT (Bill Selee, 2026-07-10):
 *   There can be only ONE clean forward to Bill.com per invoice.
 *   Flow: identify via email → classify → claim/dedup → forward once →
 *   match PO → notify ONLY when PO match fails.
 */

import { createHash, randomBytes } from "crypto";
import { getLocalDb } from "@/lib/storage/local-db";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";

const BILL_COM_EMAIL =
  process.env.BILL_COM_FORWARD_EMAIL || "buildasoilap@bill.com";

/** Statuses that mean "do not send again" */
const TAKEN = `('FORWARDED', 'CLAIMED', 'PENDING_SEND')`;

export type SingleForwardSource =
  | "local-forwarder"
  | "supabase-forwarder"
  | "inline-invoice"
  | "ap-agent"
  | "dashboard"
  | "scans-watcher"
  | "manual";

export interface SingleForwardRequest {
  gmailMessageId: string;
  emailFrom: string;
  emailSubject: string;
  pdfFilename: string;
  pdfBuffer: Buffer;
  vendorName?: string;
  invoiceNumber?: string;
  source: SingleForwardSource;
  gmail?: any;
  ocrRawText?: string;
  vendorRoutingAction?: string;
}

export type SingleForwardResult =
  | {
      status: "forwarded";
      billcomSentMessageId: string;
      pdfContentHash: string;
      claimId: number;
    }
  | {
      status: "already_forwarded";
      reason: string;
      pdfContentHash: string;
      existingBillcomMessageId?: string | null;
    }
  | {
      status: "blocked";
      reason: string;
      pdfContentHash: string;
    }
  | {
      status: "error";
      reason: string;
      pdfContentHash: string;
    };

export function sha256Pdf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sanitizeForwardFilename(original: string): string {
  const fedexMatch = original.match(
    /^(\d+)\.(\d+)\.(\d+)\.(\d{9,10})\.([A-Z]+)(\d+)\.(\d+)\.pdf$/i,
  );
  if (fedexMatch) {
    const invoiceNum = fedexMatch[4];
    const formatted = `${invoiceNum[0]}-${invoiceNum.slice(1, 4)}-${invoiceNum.slice(4)}`;
    return `FedEx_Invoice_${formatted}.pdf`;
  }
  return original.replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 180);
}

function expireStaleClaims(db: ReturnType<typeof getLocalDb>): void {
  try {
    db.prepare(
      `UPDATE ap_local_forwards
       SET status = 'ERROR',
           error_message = 'stale CLAIMED expired after 15m'
       WHERE status IN ('CLAIMED', 'PENDING_SEND')
         AND (billcom_sent_message_id IS NULL OR billcom_sent_message_id = '')
         AND forwarded_at < datetime('now', '-15 minutes')`,
    ).run();
  } catch {
    /* ignore */
  }
}

/**
 * Read-only check: has this invoice already been claimed/forwarded?
 * Content-hash is authoritative (survives filename sanitize differences).
 */
export function isAlreadyClaimedOrForwarded(
  gmailMessageId: string,
  pdfFilename: string,
  pdfHash: string,
  vendorName?: string,
  invoiceNumber?: string,
): { hit: boolean; reason: string; billcomSentMessageId?: string | null } {
  const db = getLocalDb();
  expireStaleClaims(db);

  // Layer 2 first: content hash (catches same PDF under different names)
  const byHash = db
    .prepare(
      `SELECT status, billcom_sent_message_id FROM ap_local_forwards
       WHERE pdf_content_hash = ?
         AND status IN ${TAKEN}
       LIMIT 1`,
    )
    .get(pdfHash) as
    | { status: string; billcom_sent_message_id: string | null }
    | undefined;
  if (byHash) {
    return {
      hit: true,
      reason: `content-hash (${byHash.status})`,
      billcomSentMessageId: byHash.billcom_sent_message_id,
    };
  }

  const safe = sanitizeForwardFilename(pdfFilename);
  const byKey = db
    .prepare(
      `SELECT status, billcom_sent_message_id FROM ap_local_forwards
       WHERE gmail_message_id = ?
         AND pdf_filename IN (?, ?)
         AND status IN ${TAKEN}
       LIMIT 1`,
    )
    .get(gmailMessageId, pdfFilename, safe) as
    | { status: string; billcom_sent_message_id: string | null }
    | undefined;
  if (byKey) {
    return {
      hit: true,
      reason: `message+filename (${byKey.status})`,
      billcomSentMessageId: byKey.billcom_sent_message_id,
    };
  }

  if (vendorName && invoiceNumber) {
    try {
      const ref = db
        .prepare(
          `SELECT 1 FROM billcom_bills_ref
           WHERE LOWER(vendor_name) = LOWER(?)
             AND invoice_number = ?
           LIMIT 1`,
        )
        .get(vendorName.trim(), invoiceNumber.trim());
      if (ref) {
        return { hit: true, reason: "billcom_bills_ref vendor+invoice#" };
      }
    } catch {
      /* ref table missing */
    }
  }

  return { hit: false, reason: "" };
}

/**
 * Atomically claim the right to forward.
 * - If FORWARDED/CLAIMED exists for hash or key → already_forwarded
 * - If ERROR/BLOCKED row exists for key or hash → reclaim via UPDATE to CLAIMED
 * - Else INSERT CLAIMED
 */
function claimForward(
  req: SingleForwardRequest,
  pdfHash: string,
  safeFilename: string,
): {
  claimed: boolean;
  claimId?: number;
  reason?: string;
  existingBillcomMessageId?: string | null;
} {
  const existing = isAlreadyClaimedOrForwarded(
    req.gmailMessageId,
    safeFilename,
    pdfHash,
    req.vendorName,
    req.invoiceNumber,
  );
  if (existing.hit) {
    return {
      claimed: false,
      reason: existing.reason,
      existingBillcomMessageId: existing.billcomSentMessageId,
    };
  }

  const db = getLocalDb();

  // Reclaim any prior ERROR/BLOCKED row for this hash (preferred) or message+filename
  try {
    const reclaimable = db
      .prepare(
        `SELECT id FROM ap_local_forwards
         WHERE (
           pdf_content_hash = ?
           OR (gmail_message_id = ? AND pdf_filename IN (?, ?))
         )
         AND status IN ('ERROR', 'BLOCKED')
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(pdfHash, req.gmailMessageId, safeFilename, req.pdfFilename) as
      | { id: number }
      | undefined;

    if (reclaimable) {
      db.prepare(
        `UPDATE ap_local_forwards
         SET status = 'CLAIMED',
             gmail_message_id = ?,
             email_from = ?,
             email_subject = ?,
             pdf_filename = ?,
             pdf_content_hash = ?,
             vendor_routing_action = ?,
             ocr_raw_text = COALESCE(?, ocr_raw_text),
             billcom_sent_message_id = NULL,
             error_message = ?,
             forwarded_at = datetime('now')
         WHERE id = ?`,
      ).run(
        req.gmailMessageId,
        req.emailFrom,
        req.emailSubject,
        safeFilename,
        pdfHash,
        req.vendorRoutingAction || req.source,
        req.ocrRawText || null,
        `reclaim:${req.source}`,
        reclaimable.id,
      );
      return { claimed: true, claimId: reclaimable.id };
    }
  } catch (e: any) {
    console.warn(`[ap-single-forward] reclaim probe failed: ${e.message}`);
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO ap_local_forwards
           (gmail_message_id, email_from, email_subject, pdf_filename,
            pdf_content_hash, status, vendor_routing_action, ocr_raw_text,
            error_message, forwarded_at)
         VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, datetime('now'))`,
      )
      .run(
        req.gmailMessageId,
        req.emailFrom,
        req.emailSubject,
        safeFilename,
        pdfHash,
        req.vendorRoutingAction || req.source,
        req.ocrRawText || null,
        `claim:${req.source}`,
      );
    return { claimed: true, claimId: Number(info.lastInsertRowid) };
  } catch (e: any) {
    // UNIQUE race — another worker won
    const again = isAlreadyClaimedOrForwarded(
      req.gmailMessageId,
      safeFilename,
      pdfHash,
      req.vendorName,
      req.invoiceNumber,
    );
    if (again.hit) {
      return {
        claimed: false,
        reason: again.reason,
        existingBillcomMessageId: again.billcomSentMessageId,
      };
    }
    // UNIQUE hit on ERROR row we failed to reclaim — force update by hash
    try {
      const row = db
        .prepare(
          `SELECT id FROM ap_local_forwards
           WHERE pdf_content_hash = ? OR (gmail_message_id = ? AND pdf_filename = ?)
           ORDER BY id DESC LIMIT 1`,
        )
        .get(pdfHash, req.gmailMessageId, safeFilename) as
        | { id: number }
        | undefined;
      if (row) {
        const taken = db
          .prepare(
            `SELECT status, billcom_sent_message_id FROM ap_local_forwards WHERE id = ?`,
          )
          .get(row.id) as
          | { status: string; billcom_sent_message_id: string | null }
          | undefined;
        if (taken && ["FORWARDED", "CLAIMED", "PENDING_SEND"].includes(taken.status)) {
          return {
            claimed: false,
            reason: `race (${taken.status})`,
            existingBillcomMessageId: taken.billcom_sent_message_id,
          };
        }
        db.prepare(
          `UPDATE ap_local_forwards
           SET status = 'CLAIMED',
               pdf_filename = ?,
               pdf_content_hash = ?,
               error_message = ?,
               billcom_sent_message_id = NULL,
               forwarded_at = datetime('now')
           WHERE id = ?`,
        ).run(safeFilename, pdfHash, `force-reclaim:${req.source}`, row.id);
        return { claimed: true, claimId: row.id };
      }
    } catch {
      /* fall through */
    }
    return {
      claimed: false,
      reason: e.message || "claim_race",
    };
  }
}

function markClaimForwarded(claimId: number, billcomSentMessageId: string): void {
  const db = getLocalDb();
  db.prepare(
    `UPDATE ap_local_forwards
     SET status = 'FORWARDED',
         billcom_sent_message_id = ?,
         forwarded_at = datetime('now'),
         error_message = NULL
     WHERE id = ?`,
  ).run(billcomSentMessageId, claimId);
}

function markClaimError(claimId: number, message: string): void {
  const db = getLocalDb();
  db.prepare(
    `UPDATE ap_local_forwards
     SET status = 'ERROR',
         error_message = ?
     WHERE id = ?`,
  ).run(message.slice(0, 500), claimId);
}

async function sendMime(
  gmail: any,
  emailSubject: string,
  emailFrom: string,
  safeFilename: string,
  pdfBuffer: Buffer,
): Promise<string | null> {
  const rawBase64 = pdfBuffer.toString("base64");
  const chunkedBase64 = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;
  const boundary = "b_aria_once_" + randomBytes(8).toString("hex");

  const forwardBody = [
    "Forwarded invoice (single-forward gate).",
    "",
    `Sent From: ${emailFrom}`,
    `Original Subject: ${emailSubject}`,
    `PDF: ${safeFilename}`,
  ].join("\r\n");

  const mimeMessage = [
    `To: ${BILL_COM_EMAIL}`,
    `Subject: Fwd: ${emailSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    forwardBody,
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${safeFilename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${safeFilename}"`,
    ``,
    chunkedBase64,
    `--${boundary}--`,
  ].join("\r\n");

  const sendResult = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(mimeMessage).toString("base64url") },
  });
  return sendResult.data.id || null;
}

/**
 * THE only function that may deliver an AP invoice PDF to Bill.com.
 */
export async function forwardInvoiceOnce(
  req: SingleForwardRequest,
): Promise<SingleForwardResult> {
  if (!req.pdfBuffer || req.pdfBuffer.length === 0) {
    return {
      status: "blocked",
      reason: "empty PDF buffer",
      pdfContentHash: "",
    };
  }
  if (!req.gmailMessageId) {
    return {
      status: "blocked",
      reason: "missing gmailMessageId",
      pdfContentHash: "",
    };
  }

  const pdfHash = sha256Pdf(req.pdfBuffer);
  const safeFilename = sanitizeForwardFilename(req.pdfFilename || "invoice.pdf");

  const claim = claimForward(req, pdfHash, safeFilename);
  if (!claim.claimed) {
    return {
      status: "already_forwarded",
      reason: claim.reason || "already claimed",
      pdfContentHash: pdfHash,
      existingBillcomMessageId: claim.existingBillcomMessageId,
    };
  }

  const claimId = claim.claimId!;
  try {
    let gmail = req.gmail;
    if (!gmail) {
      let auth;
      try {
        auth = await getAuthenticatedClient("ap");
      } catch {
        auth = await getAuthenticatedClient("default");
      }
      gmail = GmailApi({ version: "v1", auth });
    }

    const sentId = await sendMime(
      gmail,
      req.emailSubject,
      req.emailFrom,
      safeFilename,
      req.pdfBuffer,
    );
    if (!sentId) {
      markClaimError(claimId, "Gmail send returned no message id");
      return {
        status: "error",
        reason: "Gmail send returned no message id",
        pdfContentHash: pdfHash,
      };
    }

    markClaimForwarded(claimId, sentId);
    console.log(
      `[ap-single-forward] OK ${safeFilename} claim=${claimId} source=${req.source} hash=${pdfHash.slice(0, 12)}`,
    );
    return {
      status: "forwarded",
      billcomSentMessageId: sentId,
      pdfContentHash: pdfHash,
      claimId,
    };
  } catch (e: any) {
    markClaimError(claimId, e?.message || String(e));
    console.error(
      `[ap-single-forward] FAIL claim=${claimId} source=${req.source}: ${e?.message || e}`,
    );
    return {
      status: "error",
      reason: e?.message || String(e),
      pdfContentHash: pdfHash,
    };
  }
}

/**
 * Record PO-match outcome. Notify path should only fire when matched=false.
 */
export function recordPoMatchOutcome(opts: {
  pdfContentHash?: string;
  claimId?: number;
  matched: boolean;
  poNumber?: string | null;
  notes?: string;
}): void {
  const db = getLocalDb();
  const status = opts.matched ? "RECONCILED" : "PO_UNMATCHED";
  if (opts.claimId) {
    db.prepare(
      `UPDATE ap_local_forwards
       SET reconciliation_status = ?,
           matched_po_number = ?,
           reconciliation_notes = ?,
           reconciled_at = datetime('now')
       WHERE id = ?`,
    ).run(status, opts.poNumber || null, opts.notes || null, opts.claimId);
    return;
  }
  if (opts.pdfContentHash) {
    db.prepare(
      `UPDATE ap_local_forwards
       SET reconciliation_status = ?,
           matched_po_number = ?,
           reconciliation_notes = ?,
           reconciled_at = datetime('now')
       WHERE pdf_content_hash = ? AND status = 'FORWARDED'`,
    ).run(
      status,
      opts.poNumber || null,
      opts.notes || null,
      opts.pdfContentHash,
    );
  }
}
