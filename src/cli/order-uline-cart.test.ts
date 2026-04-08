import { describe, expect, it } from 'vitest';

import {
    formatCartVerificationMessage,
    planDraftPOCartUpdates,
    verifyUlineCart,
    type ExpectedUlineCartItem,
    type ObservedUlineCartRow,
} from './order-uline-cart';

describe('verifyUlineCart', () => {
    const expected: ExpectedUlineCartItem[] = [
        { finaleSku: 'ULS455', ulineModel: 'S-4551', quantity: 171, unitPrice: 2.43 },
        { finaleSku: 'S-4128', ulineModel: 'S-4128', quantity: 1285, unitPrice: 0.65 },
    ];

    it('classifies a fully matched cart as verified', () => {
        const observed: ObservedUlineCartRow[] = [
            { ulineModel: 'S-4551', quantity: 171, unitPrice: 2.43 },
            { ulineModel: 'S-4128', quantity: 1285, unitPrice: 0.67 },
        ];

        const result = verifyUlineCart(expected, observed);

        expect(result.status).toBe('verified');
        expect(result.matchedModels).toEqual(['S-4551', 'S-4128']);
        expect(result.missingModels).toEqual([]);
        expect(result.quantityMismatches).toEqual([]);
    });

    it('classifies a cart with a missing item as partial', () => {
        const observed: ObservedUlineCartRow[] = [
            { ulineModel: 'S-4551', quantity: 171, unitPrice: 2.43 },
        ];

        const result = verifyUlineCart(expected, observed);

        expect(result.status).toBe('partial');
        expect(result.missingModels).toEqual(['S-4128']);
    });

    it('classifies a cart with no observed rows as unverified', () => {
        const result = verifyUlineCart(expected, []);

        expect(result.status).toBe('unverified');
        expect(result.matchedModels).toEqual([]);
    });
});

describe('planDraftPOCartUpdates', () => {
    it('plans cart-normalized price changes for observed rows', () => {
        const expected: ExpectedUlineCartItem[] = [
            { finaleSku: 'ULS455', ulineModel: 'S-4551', quantity: 171, unitPrice: 2.43 },
            { finaleSku: 'S-4128', ulineModel: 'S-4128', quantity: 1285, unitPrice: 0.65 },
        ];
        const observed: ObservedUlineCartRow[] = [
            { ulineModel: 'S-4551', quantity: 171, unitPrice: 2.43 },
            { ulineModel: 'S-4128', quantity: 1285, unitPrice: 0.67 },
        ];

        const verification = verifyUlineCart(expected, observed);
        const updates = planDraftPOCartUpdates(expected, observed, verification);

        expect(updates).toEqual([
            {
                finaleSku: 'S-4128',
                ulineModel: 'S-4128',
                oldQuantity: 1285,
                newQuantity: 1285,
                oldUnitPrice: 0.65,
                newUnitPrice: 0.67,
            },
        ]);
    });

    it('normalizes pack-unit prices back to Finale each-cost', () => {
        const expected: ExpectedUlineCartItem[] = [
            {
                finaleSku: 'S-2835',
                ulineModel: 'S-2835',
                quantity: 1,
                unitPrice: 41,
                finaleUnitPrice: 0.041,
                orderUnitEaches: 1000,
            },
        ];
        const observed: ObservedUlineCartRow[] = [
            { ulineModel: 'S-2835', quantity: 1, unitPrice: 43 },
        ];

        const verification = verifyUlineCart(expected, observed);
        const updates = planDraftPOCartUpdates(expected, observed, verification);

        expect(updates).toEqual([
            {
                finaleSku: 'S-2835',
                ulineModel: 'S-2835',
                oldQuantity: 1000,
                newQuantity: 1000,
                oldUnitPrice: 0.041,
                newUnitPrice: 0.043,
            },
        ]);
    });

    it('converts observed vendor quantities back into Finale eaches even on quantity mismatch', () => {
        const expected: ExpectedUlineCartItem[] = [
            {
                finaleSku: 'S-1667',
                ulineModel: 'S-1667',
                quantity: 459,
                effectiveEachQuantity: 459,
                unitPrice: 0.328,
                finaleUnitPrice: 0.328,
                orderUnitEaches: 500,
            },
        ];
        const observed: ObservedUlineCartRow[] = [
            { ulineModel: 'S-1667', quantity: 1, unitPrice: 164 },
        ];

        const verification = verifyUlineCart(expected, observed);
        const updates = planDraftPOCartUpdates(expected, observed, verification);

        expect(verification.status).toBe('partial');
        expect(updates).toEqual([
            {
                finaleSku: 'S-1667',
                ulineModel: 'S-1667',
                oldQuantity: 459,
                newQuantity: 500,
                oldUnitPrice: 0.328,
                newUnitPrice: 0.328,
            },
        ]);
    });
});

describe('formatCartVerificationMessage', () => {
    it('formats verified wording', () => {
        const message = formatCartVerificationMessage({
            status: 'verified',
            matchedModels: ['S-4551', 'S-4128'],
            missingModels: [],
            quantityMismatches: [],
            unexpectedModels: [],
        });

        expect(message).toContain('Cart verified');
    });

    it('formats partial wording', () => {
        const message = formatCartVerificationMessage({
            status: 'partial',
            matchedModels: ['S-4551'],
            missingModels: ['S-4128'],
            quantityMismatches: [],
            unexpectedModels: [],
        });

        expect(message).toContain('Cart needs review');
        expect(message).toContain('S-4128');
    });

    it('formats unverified wording', () => {
        const message = formatCartVerificationMessage({
            status: 'unverified',
            matchedModels: [],
            missingModels: ['S-4551'],
            quantityMismatches: [],
            unexpectedModels: [],
        });

        expect(message).toContain('manual verification');
    });
});
