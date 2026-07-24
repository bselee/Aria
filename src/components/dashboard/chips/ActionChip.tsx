/**
 * @file    src/components/dashboard/chips/ActionChip.tsx
 * @purpose Filled-button style action chip for imperative shortcuts.
 *          Use when clicking performs a real action (e.g. "Order Now (2)",
 *          "Re-scan Finale", "Clear dismissed"). Visually distinct from
 *          FilterChip (outlined toggle) and StatusBadge (passive indicator)
 *          — ActionChip uses a SOLID background like a button, making it
 *          unambiguous that this is something you press to DO, not to SEE.
 * @author  delegated engineer (via Hermia oversight)
 * @created 2026-07-24
 * @deps    react
 */

"use client";

import React from "react";

/* ── Variant → Tailwind class map ───────────────────────────────────── */
const VARIANT_STYLES: Record<
  NonNullable<ActionChipProps["variant"]>,
  { base: string; disabled: string }
> = {
  primary: {
    base:     "bg-emerald-600/30 text-emerald-200 border-emerald-500/40 hover:bg-emerald-500/40 hover:text-emerald-100",
    disabled: "opacity-40 cursor-not-allowed hover:bg-emerald-600/30 hover:text-emerald-200",
  },
  secondary: {
    base:     "bg-zinc-800 text-zinc-300 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-200",
    disabled: "opacity-40 cursor-not-allowed hover:bg-zinc-800 hover:text-zinc-300",
  },
};

/* ── Types ──────────────────────────────────────────────────────────── */

export type ActionChipProps = {
  /** Action label. */
  label: string;
  /** Optional count — shown as a subdued numeral after the label. */
  count?: number;
  /** Action handler. */
  onClick: () => void;
  /** When true, chip is dimmed and non-interactive. */
  disabled?: boolean;
  /**
   * Visual prominence.
   * - `primary` (default): emerald-tinted solid — use for the main "do it"
   *   action (e.g. "Order Now", "Re-scan").
   * - `secondary`: zinc-toned — use for less prominent actions.
   */
  variant?: "primary" | "secondary";
};

/**
 * <ActionChip> — Filled-button style chip for imperative actions.
 *
 * Looks like a solid button, deliberately NOT an outlined pill. This is the
 * single biggest visual distinction from FilterChip (outlined toggle) and
 * StatusBadge (tinted passive badge). When you see an ActionChip, you know
 * clicking it DOES something — it doesn't just change a view.
 *
 * Use ActionChip when clicking triggers a side effect (create PO, re-scan,
 * fetch data). Do NOT use for filter toggles (use FilterChip) or passive
 * status info (use StatusBadge).
 *
 * @example
 * ```tsx
 * <ActionChip label="Order Now" count={2} onClick={handleOrderAll} variant="primary" />
 * <ActionChip label="Re-scan Finale" onClick={handleRefresh} variant="secondary" />
 * ```
 */
export default function ActionChip({
  label,
  count,
  onClick,
  disabled = false,
  variant = "primary",
}: ActionChipProps) {
  const v = VARIANT_STYLES[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        // Layout & typography
        "inline-flex items-center gap-1 px-2.5 py-1 rounded",
        "text-[10px] font-mono uppercase tracking-wider font-semibold",
        "transition-colors cursor-pointer select-none",
        // Border for definition on dark background
        "border",
        // Disabled vs enabled
        disabled ? v.disabled : v.base,
        // Focus ring for keyboard accessibility
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950",
      ].join(" ")}
    >
      <span className="truncate max-w-[160px]">{label}</span>
      {count !== undefined && (
        <span className="opacity-70 tabular-nums">({count})</span>
      )}
    </button>
  );
}
