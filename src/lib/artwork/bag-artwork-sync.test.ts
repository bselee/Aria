/**
 * @file    src/lib/artwork/bag-artwork-sync.test.ts
 * @purpose Unit tests for the artwork sync parser and the review-wins state
 *          rule. No network, no DB, no Finale.
 * @author  Hermia
 * @created 2026-10-28
 */
import { effectiveArtState, parseTab, type ArtworkRow } from './bag-artwork-sync';

const row = (cells: Array<string | number | null>): unknown[] => cells;

describe('parseTab', () => {
    it('locates the header dynamically and skips sku-less rows', () => {
        const { rows, orphans } = parseTab(
            [
                row([null, null, null, null, null]),
                row(['need revision', null, 'Coconut Water Powder', null, null]),
                row(['Status', 'Family', 'Version', 'Sku', 'Weight', 'Front', 'Back', 'Canva', 'Prop65']),
                row(['In Review', 'BuildAVeg', 'v3', 'BAV103', '1 lb', 'front.pdf', 'back.pdf', 'https://x', 'Awaiting CA']),
                row([null, 'Worm', null, null, null]),
                row(['Ordered', null, 'Craft Blend', 'Craft1', '3 lb', 'file.pdf']),
            ],
            'review',
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ artworkSku: 'BAV103', version: 'v3', tab: 'review' });
        expect(rows[1]).toMatchObject({ artworkSku: 'Craft1', status: 'Ordered', tab: 'review' });
        expect(orphans).toEqual(
            expect.arrayContaining([
                expect.stringContaining('pre-header: need revision'),
                expect.stringContaining('Worm'),
            ]),
        );
    });

    it('rejects a tab without a header row', () => {
        expect(() => parseTab([row(['foo', 'bar'])], 'complete')).toThrow(/header/);
    });
});

describe('effectiveArtState', () => {
    const r = (over: Partial<ArtworkRow>): ArtworkRow => ({
        artworkSku: 'BAV103',
        family: 'BuildAVeg',
        version: 'v3',
        status: '',
        weight: '1 lb',
        frontFile: '',
        backFile: '',
        rtpFile: '',
        canvaLink: '',
        tab: 'complete',
        prop65Status: '',
        ...over,
    });

    it('complete when only a Complete-tab row exists with a clean status', () => {
        expect(effectiveArtState([r({ tab: 'complete', status: 'Ordered' })])).toBe('complete');
    });

    it('review-wins when the SKU sits on the Review tab', () => {
        expect(effectiveArtState([r({ tab: 'complete', status: 'Ordered' }), r({ tab: 'review', status: '' })])).toBe('in_review');
    });

    it('blocks on a blocking status even on the Complete tab', () => {
        expect(effectiveArtState([r({ tab: 'complete', status: 'In Review' })])).toBe('in_review');
        expect(effectiveArtState([r({ tab: 'complete', status: 'need revision' })])).toBe('in_review');
    });
});
