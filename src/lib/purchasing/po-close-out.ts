/**
 * @file    src/lib/purchasing/po-close-out.ts
 * @purpose One decision function for "what should happen to this PO now?" —
 *          promote a received draft, or complete a fully-reconciled PO.
 *
 * RULE (Bill, 2026-10-29, verbatim):
 *   "reception can happen when a PO is in draft. Finale is odd like that...
 *    If all is received it should be moved to committed as that it being in
 *    draft is probably an error (somebody did not manually click committed)
 *    so that can be automated. If PO is received without conflicts, has any
 *    applicable freight or taxes or misc and it matches invoice it can be
 *    completed. can not be completed if not received or not matching invoice."
 *
 * So there are exactly two autonomous actions:
 *
 *   RECEIVED + DRAFT            → COMMIT      (draft status was clerical error)
 *   RECEIVED + INVOICE MATCHED  → COMPLETE    (freight/tax/misc applied first)
 *
 * And a set of hard blocks. Anything not positively proven stays put: this
 * module NEVER guesses, and an unknown is never treated as a yes.
 *
 * @author  Hermia
 * @created 2026-10-29
 * @deps    none (pure)
 */

/** Statuses Finale uses for a PO that has not been committed yet. */
const DRAFT_STATUSES = new Set(["ORDER_CREATED", "ORDER_PENDING", "DRAFT", "CREATED"]);

/** Statuses meaning the PO is closed; nothing to do. */
const CLOSED_STATUSES = new Set(["ORDER_COMPLETED", "COMPLETED", "ORDER_CANCELED", "CANCELED", "VOID"]);

export type PoCloseAction = "commit" | "complete" | "none";

export interface PoCloseInput {
    orderId: string;
    /** Finale statusId, e.g. ORDER_CREATED / ORDER_LOCKED / ORDER_COMPLETED. */
    statusId: string;
    /** Per-SKU ordered/received from Finale shipments (receipt truth). */
    orderedUnits: number;
    receivedUnits: number;
    /** SKUs still short — names them for the log/UI. Empty when fully received. */
    shortSkus: string[];
    /** True when any line's remainder could not be read. */
    receiptsIncomplete: boolean;
    /** A vendor invoice is matched to this PO. */
    hasMatchedInvoice: boolean;
    /** Invoice total (before any tolerance logic). */
    invoiceTotal: number | null;
    /** PO total including applied adjustments (freight/tax/misc). */
    poTotal: number | null;
    /** True when the 3-way check found a blocking discrepancy (line not on PO,
     *  qty mismatch, price mismatch beyond tolerance). */
    hasBlockingDiscrepancy: boolean;
    /** Vendor's expected freight pattern still unapplied on the PO. */
    freightUnapplied: boolean;
    /** Vendor's expected tax/misc pattern still unapplied on the PO. */
    taxOrMiscUnapplied: boolean;
}

export interface PoCloseDecision {
    action: PoCloseAction;
    /** Human-readable why — one sentence, used in logs and the dashboard. */
    reason: string;
    /** Blocking facts that must clear before an action is possible. */
    blockers: string[];
}

/**
 * Is this PO fully received against its order?
 *
 * Receipt truth, never status. `receiptsIncomplete` fails closed: if we could
 * not read a line we do not claim receipt.
 *
 * @param input Receipt facts.
 */
export function isFullyReceived(
    input: Pick<PoCloseInput, "orderedUnits" | "receivedUnits" | "shortSkus" | "receiptsIncomplete">,
): boolean {
    if (input.receiptsIncomplete) return false;
    if (input.orderedUnits <= 0) return false;
    if (input.shortSkus.length > 0) return false;
    return input.receivedUnits >= input.orderedUnits;
}

/**
 * Decide the next autonomous step for one PO.
 *
 * Order matters: a received draft gets committed first (that is the clerical
 * error), and only a COMMITTED, fully received, reconciled PO is completed.
 *
 * @param input Everything the decision needs, all pre-loaded.
 * @returns     The action plus the reasons behind it.
 */
export function decidePoCloseAction(input: PoCloseInput): PoCloseDecision {
    const status = String(input.statusId || "").toUpperCase();

    if (CLOSED_STATUSES.has(status)) {
        return { action: "none", reason: "PO is already closed", blockers: [] };
    }

    const received = isFullyReceived(input);

    // ── Step 1: a received DRAFT is a clerical error, not a supply problem ──
    // Finale permits reception on a draft. If everything arrived, the PO should
    // never have stayed a draft; promote it so ordering and AP see reality.
    if (DRAFT_STATUSES.has(status)) {
        if (!received) {
            return {
                action: "none",
                reason: "draft still outstanding — nothing to promote until received",
                blockers: input.shortSkus,
            };
        }
        return {
            action: "commit",
            reason: "fully received while still a draft — advancing to committed",
            blockers: [],
        };
    }

    // ── Step 2: completion requires receipt AND a matching invoice ──────────
    const blockers: string[] = [];
    if (!received) {
        blockers.push(
            input.shortSkus.length > 0
                ? `not fully received (${input.shortSkus.join(", ")})`
                : "not fully received",
        );
    }
    if (input.receiptsIncomplete) blockers.push("receipt could not be fully read");
    if (!input.hasMatchedInvoice) blockers.push("no matched invoice");
    if (input.hasBlockingDiscrepancy) blockers.push("invoice/Po discrepancy");
    if (input.freightUnapplied) blockers.push("freight not yet on the PO");
    if (input.taxOrMiscUnapplied) blockers.push("tax/misc not yet on the PO");

    if (input.invoiceTotal != null && input.poTotal != null && input.invoiceTotal > 0) {
        // Freight and tax routinely move the total a few percent. Beyond the
        // tolerance the totals disagree and the PO must not close.
        const tolerance = Math.max(2, input.invoiceTotal * 0.02);
        if (Math.abs(input.invoiceTotal - input.poTotal) > tolerance) {
            blockers.push(
                `invoice $${input.invoiceTotal.toFixed(2)} vs PO $${input.poTotal.toFixed(2)}`,
            );
        }
    }

    if (blockers.length > 0) {
        return { action: "none", reason: "held for manual handling", blockers };
    }

    return {
        action: "complete",
        reason: "received, reconciled to the invoice, freight/tax applied",
        blockers: [],
    };
}
