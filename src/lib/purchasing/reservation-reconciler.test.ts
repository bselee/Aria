/**
 * @file reservation-reconciler.test.ts
 * @purpose Regression tests for draft-PO reservation reconciliation. A reservation may only
 *          credit supply while its Finale PO is still ORDER_CREATED; cancelled/committed POs
 *          must be dropped and released, and unreadable POs ignored.
 * @author Hermia
 * @created 2026-10-07
 */
import { describe, it, expect, vi } from 'vitest';
import {
    reconcileReservations,
    isLiveDraftStatus,
    releaseReasonForStatus,
    buildReservationMap,
    type ReservationRow,
} from './reservation-reconciler';

const rows = (list: Array<[string, string, number]>): ReservationRow[] =>
    list.map(([productId, draftPONumber, qty]) => ({ productId, draftPONumber, qty }));

describe('reservation-reconciler — status helpers', () => {
    it('treats only ORDER_CREATED as a live draft', () => {
        expect(isLiveDraftStatus('ORDER_CREATED')).toBe(true);
        expect(isLiveDraftStatus('order_created')).toBe(true);
        expect(isLiveDraftStatus('ORDER_LOCKED')).toBe(false);
        expect(isLiveDraftStatus('ORDER_CANCELLED')).toBe(false);
        expect(isLiveDraftStatus(null)).toBe(false);
    });

    it('maps dead statuses to release reasons', () => {
        expect(releaseReasonForStatus('ORDER_CANCELLED')).toBe('cancelled');
        expect(releaseReasonForStatus('ORDER_CANCELED')).toBe('cancelled');
        expect(releaseReasonForStatus('ORDER_LOCKED')).toBe('committed');
        expect(releaseReasonForStatus('ORDER_COMPLETED')).toBe('committed');
        expect(releaseReasonForStatus('SOMETHING_ELSE')).toBe('manual');
    });
});

describe('reconcileReservations', () => {
    it('credits a live draft as inbound supply', async () => {
        const release = vi.fn(async () => 0);
        const result = await reconcileReservations(
            rows([['BASLPE103', '125391', 48]]),
            { fetchDraftStatus: async () => 'ORDER_CREATED', release },
        );
        expect(release).not.toHaveBeenCalled();
        expect(result.live).toHaveLength(1);
        expect(result.liveByProduct.get('BASLPE103')?.qty).toBe(48);
        expect(result.liveByProduct.get('BASLPE103')?.draftPONumbers).toEqual(['125391']);
    });

    it('drops and releases a CANCELLED draft so it cannot move a recommendation', async () => {
        // The 2026-10-07 incident: PO 125391 cancelled in Finale, reservation left live.
        const release = vi.fn(async () => 1);
        const result = await reconcileReservations(
            rows([['BASLPE103', '125391', 48], ['BASLPE102', '125391', 56]]),
            { fetchDraftStatus: async () => 'ORDER_CANCELLED', release },
        );
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith('125391', 'cancelled');
        expect(result.live).toHaveLength(0);
        expect(result.liveByProduct.size).toBe(0);
        expect(result.released[0]).toMatchObject({ draftPONumber: '125391', reason: 'cancelled', qty: 104 });
        expect(result.released[0].products.sort()).toEqual(['BASLPE102', 'BASLPE103']);
    });

    it('drops and releases a COMMITTED draft (already credited via openPOs)', async () => {
        const release = vi.fn(async () => 1);
        const result = await reconcileReservations(
            rows([['BASLPEE102', '125379', 130]]),
            { fetchDraftStatus: async () => 'ORDER_LOCKED', release },
        );
        expect(release).toHaveBeenCalledWith('125379', 'committed');
        expect(result.liveByProduct.size).toBe(0);
    });

    it('keeps a product on both a live draft and a dead one, crediting only the live share', async () => {
        const statuses: Record<string, string> = { '111': 'ORDER_CREATED', '222': 'ORDER_CANCELLED' };
        const release = vi.fn(async () => 1);
        const result = await reconcileReservations(
            rows([['SKU-A', '111', 40], ['SKU-A', '222', 25]]),
            { fetchDraftStatus: async (po) => statuses[po], release },
        );
        expect(result.liveByProduct.get('SKU-A')?.qty).toBe(40);
        expect(result.released).toHaveLength(1);
        expect(result.released[0].qty).toBe(25);
    });

    it('ignores (never credits, never releases) a PO whose status cannot be read', async () => {
        const release = vi.fn(async () => 0);
        const result = await reconcileReservations(
            rows([['SKU-B', '333', 10]]),
            { fetchDraftStatus: async () => { throw new Error('Finale 429'); }, release },
        );
        expect(release).not.toHaveBeenCalled();
        expect(result.liveByProduct.size).toBe(0);
        expect(result.unverified).toEqual(['333']);
    });

    it('looks up each PO status once and survives a failing release', async () => {
        const fetchDraftStatus = vi.fn(async () => 'ORDER_LOCKED');
        const release = vi.fn(async () => { throw new Error('db down'); });
        const result = await reconcileReservations(
            rows([['SKU-C', '444', 5], ['SKU-D', '444', 7], ['SKU-E', '555', 3]]),
            { fetchDraftStatus, release },
        );
        expect(fetchDraftStatus).toHaveBeenCalledTimes(2);
        expect(result.liveByProduct.size).toBe(0);
        expect(result.released).toHaveLength(2);
    });

    it('returns empty results for no rows without touching Finale', async () => {
        const fetchDraftStatus = vi.fn();
        const result = await reconcileReservations([], { fetchDraftStatus, release: vi.fn() });
        expect(fetchDraftStatus).not.toHaveBeenCalled();
        expect(result.liveByProduct.size).toBe(0);
    });
});

describe('buildReservationMap', () => {
    it('aggregates multiple POs per product', () => {
        const map = buildReservationMap(rows([['SKU-A', '1', 10], ['SKU-A', '2', 5], ['SKU-B', '2', 7]]));
        expect(map.get('SKU-A')?.qty).toBe(15);
        expect(map.get('SKU-A')?.draftPONumbers).toEqual(['1', '2']);
        expect(map.get('SKU-B')?.qty).toBe(7);
    });
});
