"use client";

/**
 * @file    PurchasingLifecycleContext.tsx
 * @purpose Focus/hover highlighting context with Click-to-Lock, Debounced Transitions,
 *          Option C (BOM dependency highlights), draft/receipt bridges, and
 *          scroll-to-PO navigation across Ordering / Purchases / RCV.
 * @author  Aria
 * @created 2026-05-19
 * @updated 2026-07-10 — requestScrollToOrder + notifyReceipt bridges
 * @deps    react
 */

import React, { createContext, useCallback, useContext, useMemo, useState, useRef } from "react";

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

type MatchDetails = {
    isDirect: boolean;
    isBom: boolean;
    isLockedDirect: boolean;
    isLockedBom: boolean;
};

type DraftEvent = {
    vendorName: string;
    orderId: string;
    itemCount: number;
    totalUnits: number;
    draftedAt: number;
};

type ScrollToOrderRequest = {
    orderId: string;
    source: LifecycleFocusSource;
    at: number;
};

type ReceiptEvent = {
    orderIds: string[];
    at: number;
};

type PurchasingLifecycleContextValue = {
    focus: LifecycleFocus | null;
    lockedFocus: LifecycleFocus | null;
    setFocus: (focus: LifecycleFocus) => void;
    clearFocus: () => void;
    setLockedFocus: (focus: LifecycleFocus | null) => void;
    clearLockedFocus: () => void;
    isMatch: (input: LifecycleMatchInput) => boolean;
    matchesFocus: (input: LifecycleMatchInput) => boolean;
    matchesLockedFocus: (input: LifecycleMatchInput) => boolean;
    
    // Option C BOM Additions
    registerBOM: (componentSku: string, finishedGoodSkus: string[]) => void;
    checkMatchDetails: (input: LifecycleMatchInput) => MatchDetails;

    // Draft event bridge: Ordering → Purchases → Receiving flow
    lastDraft: DraftEvent | null;
    notifyDraft: (event: Omit<DraftEvent, "draftedAt">) => void;

    /** Ordering ribbon click → Purchases scrolls/expands this orderId. */
    scrollToOrder: ScrollToOrderRequest | null;
    requestScrollToOrder: (orderId: string, source?: LifecycleFocusSource) => void;

    /** RCV panel saw new receipts → Ordering should bust purchasing cache. */
    lastReceipt: ReceiptEvent | null;
    notifyReceipt: (orderIds: string[]) => void;
};

const PurchasingLifecycleContext = createContext<PurchasingLifecycleContextValue>({
    focus: null,
    lockedFocus: null,
    setFocus: () => { },
    clearFocus: () => { },
    setLockedFocus: () => { },
    clearLockedFocus: () => { },
    isMatch: () => false,
    matchesFocus: () => false,
    matchesLockedFocus: () => false,
    registerBOM: () => { },
    checkMatchDetails: () => ({ isDirect: false, isBom: false, isLockedDirect: false, isLockedBom: false }),
    lastDraft: null,
    notifyDraft: () => { },
    scrollToOrder: null,
    requestScrollToOrder: () => { },
    lastReceipt: null,
    notifyReceipt: () => { },
});

function normalize(value?: string | null): string {
    return (value ?? "").trim().toLowerCase();
}

function normalizeSkuSet(values?: string[]): Set<string> {
    return new Set((values ?? []).map(normalize).filter(Boolean));
}

export function PurchasingLifecycleProvider({ children }: { children: React.ReactNode }) {
    const [focus, setFocusState] = useState<LifecycleFocus | null>(null);
    const [lockedFocus, setLockedFocusState] = useState<LifecycleFocus | null>(null);
    const [lastDraft, setLastDraft] = useState<DraftEvent | null>(null);
    const [scrollToOrder, setScrollToOrder] = useState<ScrollToOrderRequest | null>(null);
    const [lastReceipt, setLastReceipt] = useState<ReceiptEvent | null>(null);

    // Dynamic, non-rendering BOM relationships registry (Option C)
    const bomRelationsRef = useRef<{
        componentToFgs: Map<string, Set<string>>;
        fgToComponents: Map<string, Set<string>>;
    }>({
        componentToFgs: new Map(),
        fgToComponents: new Map()
    });

    // Debouncing setup for hover interactions to optimize React re-rendering
    const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

    const setFocus = useCallback((nextFocus: LifecycleFocus) => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
        }
        // DECISION(2026-05-19): Debounce hover setFocus by 50ms so fast mouse sweeps 
        // across tables don't trigger intermediate blocking React renders.
        hoverTimerRef.current = setTimeout(() => {
            setFocusState(nextFocus);
        }, 50);
    }, []);

    const clearFocus = useCallback(() => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        setFocusState(null);
    }, []);

    // Toggle locked focus on click — instantaneous, never debounced.
    const setLockedFocus = useCallback((nextLocked: LifecycleFocus | null) => {
        setLockedFocusState(current => {
            if (!nextLocked) return null;
            
            // Check equality to support toggling off if clicked again
            const sameSource = current?.source === nextLocked.source;
            const sameVendor = normalize(current?.vendorName) === normalize(nextLocked.vendorName);
            const sameOrder = normalize(current?.orderId) === normalize(nextLocked.orderId);
            
            const currentSkus = normalizeSkuSet(current?.productIds);
            const nextSkus = normalizeSkuSet(nextLocked.productIds);
            let sameSkus = currentSkus.size === nextSkus.size;
            if (sameSkus) {
                for (const sku of nextSkus) {
                    if (!currentSkus.has(sku)) {
                        sameSkus = false;
                        break;
                    }
                }
            }

            const isSame = sameSource && sameVendor && sameOrder && sameSkus;
            return isSame ? null : nextLocked;
        });
    }, []);

    const clearLockedFocus = useCallback(() => {
        setLockedFocusState(null);
    }, []);

    // Populates the BOM dependency relationships dynamically
    const registerBOM = useCallback((componentSku: string, finishedGoodSkus: string[]) => {
        const comp = normalize(componentSku);
        if (!comp) return;

        const { componentToFgs, fgToComponents } = bomRelationsRef.current;
        
        let fgs = componentToFgs.get(comp);
        if (!fgs) {
            fgs = new Set();
            componentToFgs.set(comp, fgs);
        }

        finishedGoodSkus.forEach(fg => {
            const fgNorm = normalize(fg);
            if (fgNorm) {
                fgs!.add(fgNorm);
                
                let comps = fgToComponents.get(fgNorm);
                if (!comps) {
                    comps = new Set();
                    fgToComponents.set(fgNorm, comps);
                }
                comps.add(comp);
            }
        });
    }, []);

    // Check matches including dynamic Option C BOM dependency expansions
    const checkMatchDetails = useCallback((input: LifecycleMatchInput): MatchDetails => {
        let isDirect = false;
        let isBom = false;
        let isLockedDirect = false;
        let isLockedBom = false;

        const checkFocus = (target: LifecycleFocus | null, isLocked: boolean) => {
            if (!target) return;

            // 1. Check Vendor Match (direct)
            const targetVendor = normalize(target.vendorName);
            const inputVendor = normalize(input.vendorName);
            if (targetVendor && inputVendor && targetVendor === inputVendor) {
                if (isLocked) isLockedDirect = true;
                else isDirect = true;
                return;
            }

            // 2. Check Order Match (direct)
            const targetOrder = normalize(target.orderId);
            const inputOrder = normalize(input.orderId);
            if (targetOrder && inputOrder && targetOrder === inputOrder) {
                if (isLocked) isLockedDirect = true;
                else isDirect = true;
                return;
            }

            // 3. Check SKU Match
            const targetSkus = target.productIds ?? [];
            const inputSkus = input.productIds ?? [];
            if (targetSkus.length > 0 && inputSkus.length > 0) {
                const targetSkusSet = normalizeSkuSet(targetSkus);
                const inputSkusSet = normalizeSkuSet(inputSkus);

                // Direct SKU match
                let hasDirectSkuMatch = false;
                for (const sku of inputSkusSet) {
                    if (targetSkusSet.has(sku)) {
                        hasDirectSkuMatch = true;
                        break;
                    }
                }

                if (hasDirectSkuMatch) {
                    if (isLocked) isLockedDirect = true;
                    else isDirect = true;
                    return;
                }

                // BOM relation match
                const { componentToFgs, fgToComponents } = bomRelationsRef.current;
                
                // Construct target's related SKUs set (direct + BOM expanded)
                const relatedTargetSkus = new Set<string>();
                for (const sku of targetSkusSet) {
                    const fgs = componentToFgs.get(sku);
                    if (fgs) {
                        for (const fg of fgs) relatedTargetSkus.add(fg);
                    }
                    const comps = fgToComponents.get(sku);
                    if (comps) {
                        for (const comp of comps) relatedTargetSkus.add(comp);
                    }
                }

                let hasBomSkuMatch = false;
                for (const sku of inputSkusSet) {
                    if (relatedTargetSkus.has(sku)) {
                        hasBomSkuMatch = true;
                        break;
                    }
                }

                if (hasBomSkuMatch) {
                    if (isLocked) isLockedBom = true;
                    else isBom = true;
                }
            }
        };

        checkFocus(focus, false);
        checkFocus(lockedFocus, true);

        return { isDirect, isBom, isLockedDirect, isLockedBom };
    }, [focus, lockedFocus]);

    const isMatch = useCallback((input: LifecycleMatchInput) => {
        const details = checkMatchDetails(input);
        return details.isDirect || details.isBom || details.isLockedDirect || details.isLockedBom;
    }, [checkMatchDetails]);

    const matchesLockedFocus = useCallback((input: LifecycleMatchInput) => {
        const details = checkMatchDetails(input);
        return details.isLockedDirect || details.isLockedBom;
    }, [checkMatchDetails]);

    // Draft event bridge: called by Ordering pane after successful PO draft
    const notifyDraft = useCallback((event: Omit<DraftEvent, "draftedAt">) => {
        setLastDraft({ ...event, draftedAt: Date.now() });
    }, []);

    // Ordering "Already ordered · PO #" → Purchases scroll/expand that row
    const requestScrollToOrder = useCallback((orderId: string, source: LifecycleFocusSource = "ordering") => {
        const id = String(orderId || "").trim();
        if (!id) return;
        setScrollToOrder({ orderId: id, source, at: Date.now() });
    }, []);

    // RCV panel detected new Finale receipts → Ordering cache bust
    const notifyReceipt = useCallback((orderIds: string[]) => {
        const ids = (orderIds ?? []).map(String).filter(Boolean);
        if (ids.length === 0) return;
        setLastReceipt({ orderIds: ids, at: Date.now() });
    }, []);

    // DECISION(2026-05-19): Register a global keydown listener for the Escape key 
    // inside the provider to clear locked focus and hover focus instantly.
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                clearLockedFocus();
                clearFocus();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [clearLockedFocus, clearFocus]);

    const value = useMemo(
        () => ({ 
            focus, 
            lockedFocus, 
            setFocus, 
            clearFocus, 
            setLockedFocus, 
            clearLockedFocus, 
            isMatch, 
            matchesFocus: isMatch,
            matchesLockedFocus,
            registerBOM,
            checkMatchDetails,
            lastDraft,
            notifyDraft,
            scrollToOrder,
            requestScrollToOrder,
            lastReceipt,
            notifyReceipt,
        }),
        [focus, lockedFocus, setFocus, clearFocus, setLockedFocus, clearLockedFocus, isMatch, matchesLockedFocus, registerBOM, checkMatchDetails, lastDraft, notifyDraft, scrollToOrder, requestScrollToOrder, lastReceipt, notifyReceipt],
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
