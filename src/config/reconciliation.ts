export const RECONCILIATION_CONFIG = {
    subtotalToleranceDollars: 10,
    priceReasonable: {
        maxMultiplier: 100,
        minMultiplier: 0.01,
        absolutePriceCeilingForSmallPrices: { price: 10000, ceiling: 100 },
    },
    freight: {
        labelPrefix: 'FREIGHT',
        promoId: 10007,
    },
    logRetention: {
        maxAgeDays: 30,
        dir: 'logs/reconciliation',
    },
} as const;

export type ReconciliationConfig = typeof RECONCILIATION_CONFIG;
