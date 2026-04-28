/**
 * @file    useDashboardLayout.ts
 * @purpose Pure layout migration helpers + React hook for the Aria Command
 *          Board. Extracts the localStorage / column migration logic that
 *          previously lived inline in `src/app/dashboard/page.tsx`.
 *
 *          The exported `migrateDashboardLayout` is a pure function so it can
 *          be unit-tested without a DOM, while `useDashboardLayout` wires the
 *          same logic to React state + localStorage with hydration safety.
 *
 *          Panel ids and the localStorage key (`aria-dash-layout`) are
 *          deliberately preserved from the legacy implementation.
 */

import { useCallback, useEffect, useState } from "react";

// ── Panel ids — must remain stable across versions ──────────────────────────
// All current dashboard panel ids. New panels added here will be appended to
// the right column on first load (preserves saved customisations while
// preventing silent drops).
export const ALL_PANEL_IDS = [
    "build-risk",
    "receivings",
    "activity",
    "invoice-queue",
    "statement-reconciliation",
    "purchasing",
    "build-schedule",
    "active-purchases",
    "tracking-board",
    "purchasing-calendar",
    "oversight",
] as const;

export type PanelId = (typeof ALL_PANEL_IDS)[number];

const PANEL_ID_SET: Set<string> = new Set(ALL_PANEL_IDS);

// Panels that are no longer rendered. We strip them from any restored layout.
const RETIRED_PANELS: ReadonlySet<string> = new Set([
    "chat-mirror",
    "reorder",
    "axiom-queue",
]);

export type ColumnId = "left" | "midLeft" | "midRight" | "right";
export type DashboardLayout = Record<ColumnId, string[]>;

export const ALL_COLUMNS: ColumnId[] = ["left", "midLeft", "midRight", "right"];

// ── Default layout — keep in sync with `src/app/dashboard/page.tsx` ─────────
export const DEFAULT_LAYOUT: DashboardLayout = {
    left: ["build-risk", "receivings"],
    midLeft: [
        "invoice-queue",
        "statement-reconciliation",
        "active-purchases",
        "tracking-board",
    ],
    midRight: ["purchasing", "purchasing-calendar"],
    right: ["activity", "build-schedule", "oversight"],
};

export const LAYOUT_STORAGE_KEY = "aria-dash-layout";

function emptyLayout(): DashboardLayout {
    return { left: [], midLeft: [], midRight: [], right: [] };
}

function cloneDefault(): DashboardLayout {
    return {
        left: [...DEFAULT_LAYOUT.left],
        midLeft: [...DEFAULT_LAYOUT.midLeft],
        midRight: [...DEFAULT_LAYOUT.midRight],
        right: [...DEFAULT_LAYOUT.right],
    };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalises an arbitrary stored layout into the current shape. Pure — no
 * localStorage / DOM access. Designed to be safe to call against any user
 * input.
 *
 * Migration rules (in order):
 * 1. Empty / corrupt / unknown → return clone of `DEFAULT_LAYOUT`
 * 2. Old 3-column "mid" → split between midLeft / midRight (overflow → right)
 * 3. Old 5-column "farRight" → merge into midRight
 * 4. Strip retired panels and ids that are not in `ALL_PANEL_IDS`
 * 5. Deduplicate (first occurrence wins)
 * 6. Append any panels missing from saved layout to the column they default
 *    to, so newly-shipped panels appear without forcing a reset.
 */
export function migrateDashboardLayout(saved: unknown): DashboardLayout {
    if (!isPlainRecord(saved)) return cloneDefault();

    // Start from an empty layout and copy in any string[] values that look
    // like columns. Anything else (numbers, objects) is dropped.
    const restored: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value) && value.every(v => typeof v === "string")) {
            restored[key] = value.slice();
        }
    }

    // Migration: 3-col "mid" → midLeft + midRight
    if (restored.mid && !restored.midLeft) {
        const oldMid = restored.mid;
        restored.midLeft = oldMid.filter(id =>
            DEFAULT_LAYOUT.midLeft.includes(id),
        );
        restored.midRight = oldMid.filter(id =>
            DEFAULT_LAYOUT.midRight.includes(id),
        );
        const placed = new Set([...restored.midLeft, ...restored.midRight]);
        const overflow = oldMid.filter(id => !placed.has(id));
        restored.right = [...(restored.right ?? []), ...overflow];
        delete restored.mid;
    }

    // Migration: 5-col "farRight" → midRight
    if (restored.farRight) {
        const farRightPanels = restored.farRight;
        if (!restored.midRight) restored.midRight = [];
        for (const id of farRightPanels) {
            if (!restored.midRight.includes(id)) {
                restored.midRight.push(id);
            }
        }
        delete restored.farRight;
    }

    const out: DashboardLayout = emptyLayout();
    for (const col of ALL_COLUMNS) {
        if (Array.isArray(restored[col])) {
            out[col] = restored[col].slice();
        }
    }

    // If nothing valid was restored (no columns at all) → defaults.
    const hasAny = ALL_COLUMNS.some(col => out[col].length > 0);
    if (!hasAny) return cloneDefault();

    // Filter retired + unknown panel ids; dedup across all columns.
    const seen = new Set<string>();
    for (const col of ALL_COLUMNS) {
        out[col] = out[col].filter(id => {
            if (RETIRED_PANELS.has(id)) return false;
            if (!PANEL_ID_SET.has(id)) return false;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    // Append panels that still aren't placed anywhere — drop them in their
    // default column so newly-shipped panels surface without a reset.
    for (const col of ALL_COLUMNS) {
        for (const id of DEFAULT_LAYOUT[col]) {
            if (!seen.has(id)) {
                out[col].push(id);
                seen.add(id);
            }
        }
    }

    return out;
}

/** Stable serialisation — used by the round-trip test and the persist step. */
export function serialiseDashboardLayout(layout: DashboardLayout): string {
    return JSON.stringify({
        left: layout.left,
        midLeft: layout.midLeft,
        midRight: layout.midRight,
        right: layout.right,
    });
}

// ── Hook ────────────────────────────────────────────────────────────────────

export type UseDashboardLayoutResult = {
    layout: DashboardLayout;
    setLayout: (next: DashboardLayout | ((prev: DashboardLayout) => DashboardLayout)) => void;
    mounted: boolean;
    resetLayout: () => void;
};

export function useDashboardLayout(): UseDashboardLayoutResult {
    const [layout, setLayoutState] = useState<DashboardLayout>(cloneDefault());
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        if (typeof window === "undefined") return;
        try {
            const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            setLayoutState(migrateDashboardLayout(parsed));
        } catch {
            // corrupt JSON — keep defaults
        }
    }, []);

    useEffect(() => {
        if (!mounted) return;
        try {
            window.localStorage.setItem(
                LAYOUT_STORAGE_KEY,
                serialiseDashboardLayout(layout),
            );
        } catch {
            // quota / SSR — ignore
        }
    }, [layout, mounted]);

    const setLayout = useCallback(
        (next: DashboardLayout | ((prev: DashboardLayout) => DashboardLayout)) => {
            setLayoutState(prev =>
                typeof next === "function"
                    ? (next as (p: DashboardLayout) => DashboardLayout)(prev)
                    : next,
            );
        },
        [],
    );

    const resetLayout = useCallback(() => {
        setLayoutState(cloneDefault());
    }, []);

    return { layout, setLayout, mounted, resetLayout };
}
