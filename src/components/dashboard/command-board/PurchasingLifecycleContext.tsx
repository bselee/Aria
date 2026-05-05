"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export type LifecycleFocusSource = "ordering" | "purchases" | "rcv";

export type LifecycleFocus = {
    source: LifecycleFocusSource;
    vendorName?: string | null;
    orderId?: string | null;
    productIds?: string[];
};

type LifecycleMatchInput = {
    vendorName?: string | null;
    orderId?: string | null;
    productIds?: string[];
};

type PurchasingLifecycleContextValue = {
    focus: LifecycleFocus | null;
    setFocus: (focus: LifecycleFocus) => void;
    clearFocus: () => void;
    isMatch: (input: LifecycleMatchInput) => boolean;
    matchesFocus: (input: LifecycleMatchInput) => boolean;
};

const PurchasingLifecycleContext = createContext<PurchasingLifecycleContextValue>({
    focus: null,
    setFocus: () => { },
    clearFocus: () => { },
    isMatch: () => false,
    matchesFocus: () => false,
});

function normalize(value?: string | null): string {
    return (value ?? "").trim().toLowerCase();
}

function normalizeSkuSet(values?: string[]): Set<string> {
    return new Set((values ?? []).map(normalize).filter(Boolean));
}

export function PurchasingLifecycleProvider({ children }: { children: React.ReactNode }) {
    const [focus, setFocus] = useState<LifecycleFocus | null>(null);

    const clearFocus = useCallback(() => setFocus(null), []);

    const isMatch = useCallback((input: LifecycleMatchInput) => {
        if (!focus) return false;

        const focusVendor = normalize(focus.vendorName);
        const inputVendor = normalize(input.vendorName);
        if (focusVendor && inputVendor && focusVendor === inputVendor) return true;

        const focusOrder = normalize(focus.orderId);
        const inputOrder = normalize(input.orderId);
        if (focusOrder && inputOrder && focusOrder === inputOrder) return true;

        const focusSkus = normalizeSkuSet(focus.productIds);
        const inputSkus = normalizeSkuSet(input.productIds);
        for (const sku of inputSkus) {
            if (focusSkus.has(sku)) return true;
        }

        return false;
    }, [focus]);

    const value = useMemo(
        () => ({ focus, setFocus, clearFocus, isMatch, matchesFocus: isMatch }),
        [clearFocus, focus, isMatch],
    );

    return (
        <PurchasingLifecycleContext.Provider value={value}>
            {children}
        </PurchasingLifecycleContext.Provider>
    );
}

export function usePurchasingLifecycle() {
    return useContext(PurchasingLifecycleContext);
}
