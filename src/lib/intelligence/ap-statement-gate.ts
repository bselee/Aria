/**
 * @file    ap-statement-gate.ts
 * @purpose Shared statement/non-invoice detection for the AP forward path.
 *          A vendor statement ("Statement from LOGAN LABS LLC",
 *          "STATEMENT/RELEVÉ DE COMPTE") is a summary of open invoices, NOT a
 *          bill. Forwarding one creates a bogus Bill.com bill that re-saves as
 *          "Auto-saved" (e.g. bill 3457 $1,737). Every forward path must run
 *          these gates before sending anything to buildasoilap@bill.com.
 * @author  Bill Selee (Hermia)
 * @created 2026-09-10
 * @deps    none
 */

/**
 * Statement-signal detection on the SUBJECT.
 *
 * Word-boundary "statement" matches "Statement from …", "Monthly Statement",
 * "Statement of Account", etc. The French "relevé de compte" is Berger's
 * statement subject.
 *
 * Deliberately does NOT match "Invoice Stmt" / "Invoice Statement" — those are
 * AAA Cooper's per-Pro# INVOICES and must keep forwarding.
 */
export function isStatementSubject(subject: string): boolean {
    const s = (subject || "").toLowerCase();
    if (s.includes("relevé de compte") || s.includes("releve de compte")) return true;
    const isInvoiceStatement = /\binvoice\s+st(atement|mt)\b/.test(s);
    return /\bstatement\b/.test(s) && !isInvoiceStatement;
}

/**
 * Statement / collections attachment detection on the FILENAME (plus sender
 * hints). Complements isStatementSubject — a statement whose filename is
 * opaque ("BUIAS1.pdf") is caught by the subject gate; a statement whose
 * subject is opaque is caught here.
 */
export function isStatementAttachment(filename: string, from: string, subject: string): boolean {
    const f = (filename || "").toLowerCase();
    const fromLower = (from || "").toLowerCase();
    const subjectLower = (subject || "").toLowerCase();
    if (!f) return false;
    if (f.includes("statement") || f.includes("aging") || f.includes("account_summary")) return true;
    // Belt Power remitto invoices are Inv######.pdf — statements are BuildASoil_LLC_Statement.pdf
    if (fromLower.includes("beltpower") && f.includes("statement")) return true;
    if (fromLower.includes("beltpower") && subjectLower.includes("reminder") && !f.startsWith("inv")) return true;
    return false;
}

/**
 * Combined statement gate — returns true when the email is a statement and
 * must NOT be forwarded to Bill.com, regardless of which forward path is
 * handling it.
 */
export function isStatementDocument(subject: string, filename: string, from: string): boolean {
    return isStatementSubject(subject) || isStatementAttachment(filename, from, subject);
}
