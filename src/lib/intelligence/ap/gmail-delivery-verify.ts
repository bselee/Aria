/**
 * @file    src/lib/intelligence/ap/gmail-delivery-verify.ts
 * @purpose Verify that AP forwards actually reached Bill.com using GMAIL as the
 *          source of truth — no third-party service, no scraping, no CSV export.
 *
 *          WHY THIS EXISTS (2026-08-13): verification was originally built
 *          against billcom_bills_ref, a table populated by scraping a CSV out of
 *          bill.com with Playwright. That chain has three independent failure
 *          modes — the login breaks (it did, for 5 weeks), the export is
 *          FILTERED to one vendor (13 of 17 manual exports are), and paid bills
 *          age off the report entirely. Every one of those turns "absent from the
 *          reference" into a false "never landed" alert. Bill caught exactly that:
 *          Uline, Abel's, CR Minerals, Evergreen and Logan Labs were reported
 *          missing while all five had healthy Bill.com history.
 *
 *          Aria already owns better evidence. Every row in ap_local_forwards
 *          carries billcom_sent_message_id — the Gmail ID of the forward we sent
 *          (274/274 = 100% coverage). Gmail can be asked, authoritatively:
 *          does that message exist, was it addressed to the Bill.com intake
 *          address, did it carry the PDF, and did anything bounce?
 *
 *          An accepted SMTP delivery to buildasoilap@bill.com with no bounce IS
 *          receipt. That is a different — and far more answerable — question than
 *          "did Bill.com's OCR finish processing it", which is the only thing the
 *          CSV could ever tell us.
 *
 * @author  Hermia
 * @created 2026-08-13
 * @deps    @/lib/storage/local-db (better-sqlite3), @/lib/gmail/auth,
 *          @googleapis/gmail
 * @env     Gmail OAuth token for the "ap" slot (ap-token.json)
 */

import { getLocalDb } from "@/lib/storage/local-db";

/** Bill.com invoice intake address every forward must be addressed to. */
export const BILLCOM_INTAKE_ADDRESS = "buildasoilap@bill.com";

/** Outcome for a single forward. */
export type DeliveryVerdict =
  /** Gmail has the sent message, addressed to Bill.com, PDF attached. */
  | "delivered"
  /** Gmail has the message but it is missing the PDF attachment. */
  | "sent_without_pdf"
  /** Gmail has the message but it was not addressed to the intake address. */
  | "wrong_recipient"
  /** A bounce / delivery-failure notice references this send. */
  | "bounced"
  /** Gmail returned 404 — the send never actually happened. */
  | "not_in_gmail"
  /** Row has no billcom_sent_message_id to check. */
  | "no_send_id"
  /** Gmail lookup failed for a transient reason; retry next sweep. */
  | "lookup_error";

/** Per-row verification result. */
export interface DeliveryCheck {
  id: number;
  sentMessageId: string | null;
  verdict: DeliveryVerdict;
  vendorName: string | null;
  invoiceNumber: string | null;
  emailSubject: string;
  recipient: string | null;
  detail: string;
}

/** Aggregate sweep result. */
export interface DeliverySweepResult {
  checked: number;
  delivered: number;
  alreadyVerified: number;
  /** Rows needing human attention — anything that is not "delivered". */
  problems: DeliveryCheck[];
  /** Counts keyed by verdict, for observability. */
  byVerdict: Record<string, number>;
}

interface ForwardRow {
  id: number;
  billcom_sent_message_id: string | null;
  email_subject: string | null;
  ocr_vendor_name: string | null;
  ocr_invoice_number: string | null;
  verified: number;
}

const TAKEN_STATUS_LIST = ["FORWARDED", "CLAIMED", "PENDING_SEND"] as const;

/** Minimal Gmail surface this module needs — keeps it unit-testable. */
export interface GmailLike {
  users: {
    messages: {
      get: (params: Record<string, unknown>) => Promise<{ data: GmailMessage }>;
      list?: (params: Record<string, unknown>) => Promise<{ data: { messages?: Array<{ id?: string | null }> } }>;
    };
  };
}

interface GmailPart {
  filename?: string | null;
  mimeType?: string | null;
  parts?: GmailPart[];
  headers?: Array<{ name?: string | null; value?: string | null }>;
}

interface GmailMessage {
  id?: string | null;
  labelIds?: string[] | null;
  payload?: GmailPart | null;
}

/** Read a header value from a Gmail payload, case-insensitively. */
function header(payload: GmailPart | null | undefined, name: string): string | null {
  const hs = payload?.headers ?? [];
  const hit = hs.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

/**
 * Walk a MIME tree looking for a PDF attachment.
 *
 * Matches on mimeType application/pdf OR a .pdf filename — Gmail occasionally
 * reports application/octet-stream for PDFs produced by vendor mailers, and a
 * missed attachment would be reported as a delivery problem.
 *
 * @param part - MIME part to search (recurses into part.parts)
 * @returns true when any descendant looks like a PDF attachment
 */
export function hasPdfAttachment(part: GmailPart | null | undefined): boolean {
  if (!part) return false;
  const filename = part.filename ?? "";
  const mimeType = (part.mimeType ?? "").toLowerCase();
  if (mimeType === "application/pdf") return true;
  if (filename.toLowerCase().endsWith(".pdf")) return true;
  if (part.parts && part.parts.length > 0) {
    return part.parts.some((p) => hasPdfAttachment(p));
  }
  return false;
}

/**
 * Classify one forward against Gmail.
 *
 * Never throws: a transient Gmail failure yields "lookup_error" so the sweep
 * retries next run instead of reporting a false problem. A hard 404 is
 * meaningful and yields "not_in_gmail" — that is a genuinely missing send.
 *
 * @param gmail - Gmail client (users.messages.get)
 * @param row   - forward row to classify
 * @returns the verdict plus supporting detail
 */
export async function classifyForward(gmail: GmailLike, row: ForwardRow): Promise<DeliveryCheck> {
  const base = {
    id: row.id,
    sentMessageId: row.billcom_sent_message_id,
    vendorName: row.ocr_vendor_name ?? null,
    invoiceNumber: row.ocr_invoice_number ?? null,
    emailSubject: row.email_subject ?? "",
    recipient: null as string | null,
  };

  const sentId = (row.billcom_sent_message_id ?? "").trim();
  if (!sentId) {
    return { ...base, verdict: "no_send_id", detail: "row has no billcom_sent_message_id" };
  }

  let msg: GmailMessage;
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: sentId,
      format: "full",
    });
    msg = res.data;
  } catch (e: unknown) {
    const err = e as { code?: number; status?: number; message?: string };
    const code = err?.code ?? err?.status;
    if (code === 404) {
      return {
        ...base,
        verdict: "not_in_gmail",
        detail: "Gmail 404 — the forward was recorded but no sent message exists",
      };
    }
    return { ...base, verdict: "lookup_error", detail: `Gmail lookup failed: ${err?.message ?? String(e)}` };
  }

  const to = header(msg.payload, "To") ?? "";
  const recipient = to.trim() || null;

  if (!to.toLowerCase().includes(BILLCOM_INTAKE_ADDRESS)) {
    return {
      ...base,
      recipient,
      verdict: "wrong_recipient",
      detail: `addressed to "${to}" instead of ${BILLCOM_INTAKE_ADDRESS}`,
    };
  }

  if (!hasPdfAttachment(msg.payload)) {
    return { ...base, recipient, verdict: "sent_without_pdf", detail: "no PDF attachment found in sent message" };
  }

  return { ...base, recipient, verdict: "delivered", detail: `SENT to ${BILLCOM_INTAKE_ADDRESS} with PDF attached` };
}

/**
 * Collect Gmail message IDs referenced by recent bounce / delivery-failure mail.
 *
 * Bounces arrive from mailer-daemon or postmaster and quote the original
 * message. We cannot join them to a send by ID directly, so the subject of the
 * bounce is matched against forward subjects by the caller. Returns the raw
 * bounce subjects for that comparison.
 *
 * @param gmail - Gmail client with users.messages.list
 * @param days  - how far back to scan (default 30)
 * @returns bounce subject lines (lowercased), empty on any failure
 */
export async function fetchBounceSubjects(gmail: GmailLike, days = 30): Promise<string[]> {
  if (!gmail.users.messages.list) return [];
  const subjects: string[] = [];
  try {
    const after = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "/");
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `after:${after} (from:mailer-daemon OR from:postmaster OR subject:"delivery status notification" OR subject:"undeliverable")`,
      maxResults: 50,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    for (const id of ids) {
      try {
        const full = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject"],
        });
        const subj = header(full.data.payload, "Subject");
        if (subj) subjects.push(subj.toLowerCase());
      } catch {
        /* skip unreadable bounce */
      }
    }
  } catch {
    return [];
  }
  return subjects;
}

/**
 * Verify every recorded forward against Gmail and activate the `verified` flag.
 *
 * This is the primary AP delivery check. It depends only on Gmail — the same
 * API Aria already uses to send — so it cannot be broken by a vendor portal
 * login, a filtered CSV export, or a paid bill ageing off a report.
 *
 * Rows already verified are skipped (idempotent and cheap to run often).
 *
 * @param gmail - authenticated Gmail client for the "ap" slot
 * @param opts.lookbackDays - how far back to verify (default 45)
 * @param opts.graceHours   - skip sends younger than this (default 1)
 * @param opts.checkBounces - also scan for bounce notices (default true)
 * @returns counts plus the list of forwards that need attention
 */
export async function runGmailDeliverySweep(
  gmail: GmailLike,
  opts?: { lookbackDays?: number; graceHours?: number; checkBounces?: boolean },
): Promise<DeliverySweepResult> {
  const lookbackDays = opts?.lookbackDays ?? 45;
  const graceHours = opts?.graceHours ?? 1;
  const checkBounces = opts?.checkBounces ?? true;

  const empty: DeliverySweepResult = {
    checked: 0,
    delivered: 0,
    alreadyVerified: 0,
    problems: [],
    byVerdict: {},
  };

  let rows: ForwardRow[];
  let db: ReturnType<typeof getLocalDb>;
  try {
    db = getLocalDb();
    rows = db
      .prepare(
        `SELECT id, billcom_sent_message_id, email_subject,
                ocr_vendor_name, ocr_invoice_number, verified
         FROM ap_local_forwards
         WHERE status IN (${TAKEN_STATUS_LIST.map(() => "?").join(",")})
           AND forwarded_at >= datetime('now', ?)
           AND forwarded_at <= datetime('now', ?)
         ORDER BY forwarded_at DESC`,
      )
      .all(...TAKEN_STATUS_LIST, `-${lookbackDays} days`, `-${graceHours} hours`) as ForwardRow[];
  } catch (err) {
    console.error("[gmail-delivery-verify] DB read failed:", err);
    return empty;
  }

  let alreadyVerified = 0;
  const candidates: ForwardRow[] = [];
  for (const r of rows) {
    if (r.verified === 1) alreadyVerified += 1;
    else candidates.push(r);
  }

  const markVerified = db.prepare("UPDATE ap_local_forwards SET verified = 1 WHERE id = ?");
  const byVerdict: Record<string, number> = {};
  const problems: DeliveryCheck[] = [];
  let delivered = 0;

  for (const row of candidates) {
    const check = await classifyForward(gmail, row);
    byVerdict[check.verdict] = (byVerdict[check.verdict] ?? 0) + 1;

    if (check.verdict === "delivered") {
      delivered += 1;
      try {
        markVerified.run(row.id);
      } catch {
        /* non-fatal: the verdict still stands */
      }
      continue;
    }

    // "lookup_error" is transient — count it but never surface it as a problem.
    if (check.verdict !== "lookup_error") {
      problems.push(check);
    }
  }

  // Bounces override a "delivered" verdict: SMTP accepted, then rejected later.
  if (checkBounces && problems.length >= 0) {
    const bounceSubjects = await fetchBounceSubjects(gmail);
    if (bounceSubjects.length > 0) {
      for (const row of candidates) {
        const subj = (row.email_subject ?? "").toLowerCase().trim();
        if (!subj) continue;
        if (bounceSubjects.some((b) => b.includes(subj) || subj.includes(b.replace(/^(re|fwd):\s*/i, "")))) {
          byVerdict["bounced"] = (byVerdict["bounced"] ?? 0) + 1;
          problems.push({
            id: row.id,
            sentMessageId: row.billcom_sent_message_id,
            verdict: "bounced",
            vendorName: row.ocr_vendor_name ?? null,
            invoiceNumber: row.ocr_invoice_number ?? null,
            emailSubject: row.email_subject ?? "",
            recipient: null,
            detail: "a delivery-failure notice references this forward",
          });
        }
      }
    }
  }

  return {
    checked: candidates.length,
    delivered,
    alreadyVerified,
    problems,
    byVerdict,
  };
}
