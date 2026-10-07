/**
 * @file reservation-reconciler.ts
 * @purpose Verify draft-PO reservations against live Finale status before they are allowed to
 *          credit supply, and release the ones whose PO is no longer an unsent draft.
 *
 * WHY THIS EXISTS (incident 2026-10-07):
 * `createDraftPurchaseOrder` writes a `qty_reservations` row for every line it drafts so the next
 * scan does not re-order the same quantity. Those rows were only ever released by Aria's own
 * commit/cancel paths or the 72h expiry, so a PO cancelled or committed inside Finale kept its
 * reservation alive. The recommender then treated those units as supply already spoken for and
 * produced doubled quantities plus false 0-day CRITICAL rows (Miles Filippelli LPE103: card asked
 * 96 for a 48-unit need, because the cancelled draft PO 125391 still held 48).
 *
 * A reservation means exactly one thing: "these units are on an unsent draft". That is true only
 * while the PO still reports ORDER_CREATED. Anything else is dead weight and must be dropped and
 * released, never allowed to move a recommendation.
 *
 * @author Hermia
 * @created 2026-10-07
 * @deps @/lib/purchasing/calibration (ActiveReservation), releaseReservations
 */

import type { ActiveReservation } from "@/lib/purchasing/calibration";

/** Finale status a draft must still report for its reservation to count as inbound supply. */
export const LIVE_DRAFT_STATUS = "ORDER_CREATED";

export type ReleaseReason = "committed" | "cancelled" | "manual";

export interface ReservationRow {
    productId: string;
    draftPONumber: string;
    qty: number;
}

export interface ReservationReconcileDeps {
    /** Live status of a Finale PO (`statusId`), or null when it cannot be read. */
    fetchDraftStatus: (draftPONumber: string) => Promise<string | null>;
    /** Releases every unreleased reservation row for a PO. */
    release: (draftPONumber: string, reason: ReleaseReason) => Promise<number>;
    /** Optional logger — reconcile results are worth one line in the scan log. */
    log?: (message: string) => void;
}

export interface ReservationReconcileResult {
    /** productId -> reservation credited as inbound supply (only live drafts). */
    liveByProduct: Map<string, ActiveReservation>;
    /** Rows whose PO is still an unsent draft. */
    live: ReservationRow[];
    /** Rows dropped because the PO is no longer a draft (released in Finale terms). */
    released: Array<{ draftPONumber: string; statusId: string; reason: ReleaseReason; products: string[]; qty: number }>;
    /** POs whose status could not be read, so their reservations were ignored this scan. */
    unverified: string[];
}

/** Best-effort message text from an unknown thrown value. */
function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    return typeof err === 'string' ? err : JSON.stringify(err);
}

/** True when a Finale PO is still an unsent draft the reservation can legitimately cover. */
export function isLiveDraftStatus(statusId: string | null | undefined): boolean {
    return String(statusId ?? "").trim().toUpperCase() === LIVE_DRAFT_STATUS;
}

/** Maps a dead PO's status to the reservation release reason. */
export function releaseReasonForStatus(statusId: string | null | undefined): ReleaseReason {
    const s = String(statusId ?? "").trim().toUpperCase();
    if (s === "ORDER_CANCELLED" || s === "ORDER_CANCELED") return "cancelled";
    if (s === "ORDER_LOCKED" || s === "ORDER_COMPLETED" || s === "ORDER_RECEIVED") return "committed";
    return "manual";
}

/** Groups flat reservation rows into the per-product shape the recommender consumes. */
export function buildReservationMap(rows: ReservationRow[]): Map<string, ActiveReservation> {
    const map = new Map<string, ActiveReservation>();
    for (const row of rows) {
        const existing = map.get(row.productId);
        if (existing) {
            existing.qty += row.qty;
            existing.rows.push({ draftPONumber: row.draftPONumber, qty: row.qty });
            if (!existing.draftPONumbers.includes(row.draftPONumber)) existing.draftPONumbers.push(row.draftPONumber);
        } else {
            map.set(row.productId, {
                productId: row.productId,
                qty: row.qty,
                draftPONumbers: [row.draftPONumber],
                rows: [{ draftPONumber: row.draftPONumber, qty: row.qty }],
            });
        }
    }
    return map;
}

/**
 * Keeps only the reservations whose PO is still an unsent Finale draft, releasing the rest.
 *
 * Fail-open by design on an unreadable status: the reservation is ignored (not credited, not
 * released) so a stale draft can never inflate or suppress a recommendation, and the next scan
 * retries the release. Erring the other way (crediting an unknown PO) is what double-ordered.
 *
 * @param rows Flat reservation rows from `loadActiveReservationRows()`.
 * @param deps Status fetcher + release function (injected so this stays unit-testable).
 * @returns Live reservations, dropped/released rows, and unverifiable PO numbers.
 */
export async function reconcileReservations(
    rows: ReservationRow[],
    deps: ReservationReconcileDeps,
): Promise<ReservationReconcileResult> {
    const result: ReservationReconcileResult = {
        liveByProduct: new Map(),
        live: [],
        released: [],
        unverified: [],
    };
    if (rows.length === 0) return result;

    // One status lookup per PO, however many SKUs sit on it.
    const poNumbers = [...new Set(rows.map(r => r.draftPONumber))];
    const statusByPo = new Map<string, string | null>();
    await Promise.all(poNumbers.map(async (po) => {
        try {
            statusByPo.set(po, await deps.fetchDraftStatus(po));
        } catch (err: unknown) {
            deps.log?.(`[reservations] PO #${po} status check failed: ${errorText(err)}`);
            statusByPo.set(po, null);
        }
    }));

    const deadByPo = new Map<string, { statusId: string; reason: ReleaseReason; products: string[]; qty: number }>();

    for (const row of rows) {
        const statusId = statusByPo.get(row.draftPONumber) ?? null;
        if (isLiveDraftStatus(statusId)) {
            result.live.push(row);
            continue;
        }
        if (statusId == null) {
            // Unreadable: ignore it this scan rather than guess.
            if (!result.unverified.includes(row.draftPONumber)) result.unverified.push(row.draftPONumber);
            continue;
        }
        const entry = deadByPo.get(row.draftPONumber) ?? {
            statusId,
            reason: releaseReasonForStatus(statusId),
            products: [],
            qty: 0,
        };
        if (!entry.products.includes(row.productId)) entry.products.push(row.productId);
        entry.qty += row.qty;
        deadByPo.set(row.draftPONumber, entry);
    }

    for (const [po, entry] of deadByPo) {
        let released = 0;
        try {
            released = await deps.release(po, entry.reason);
        } catch (err: unknown) {
            deps.log?.(`[reservations] release failed for PO #${po}: ${errorText(err)}`);
        }
        result.released.push({ draftPONumber: po, ...entry });
        deps.log?.(
            `[reservations] PO #${po} is ${entry.statusId}, not a live draft — dropped ${Math.round(entry.qty)} ` +
            `unit(s) across ${entry.products.join(", ")} and released ${released} reservation row(s)`,
        );
    }

    if (result.unverified.length > 0) {
        deps.log?.(
            `[reservations] could not verify PO status for ${result.unverified.join(", ")} — ` +
            `reservations ignored this scan (not credited, not released)`,
        );
    }

    result.liveByProduct = buildReservationMap(result.live);
    return result;
}
