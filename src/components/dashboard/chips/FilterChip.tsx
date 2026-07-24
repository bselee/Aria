/**
 * @file    src/components/dashboard/chips/FilterChip.tsx
 * @purpose Toggle/filter pill with outlined border, tinted active state.
 *          Use when the user picks one option from a row of mutually-exclusive
 *          or independent toggles (e.g. "TODAY / 30 / 60 / 90 / ALL" day-range
 *          filter, or "Need Order / Topping Up / On Order" lifecycle bucket).
 *          Visually distinct from StatusBadge (passive read-only) and
 *          ActionChip (filled-button action) — FilterChip is an OUTLINED pill
 *          that changes fill only when active, signaling "this toggles a view."
 * @author  delegated engineer (via Hermia oversight)
 * @created 2026-07-24
 * @deps    react, lucide-react (none used directly; peer dep on Tailwind 3.4+)
 */

"use client";

import React from "react";

/* ── Tone → Tailwind class map ──────────────────────────────────────── */
const ACTIVE_TONES: Record<
  NonNullable<FilterChipProps["tone"]>,
  { bg: string; text: string; border: string }
> = {
  default: { bg: "bg-zinc-700", text: "text-dash-l1", border: "border-zinc-500" },
  red:     { bg: "bg-red-500/15", text: "text-red-300",  border: "border-red-500/40" },
  amber:   { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/40" },
  emerald: { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/40" },
  cyan:    { bg: "bg-cyan-500/15", text: "text-cyan-300",   border: "border-cyan-500/40" },
};

/* ── Types ──────────────────────────────────────────────────────────── */

export type FilterChipProps = {
  /** Visible label — rendered uppercase via Tailwind tracking. */
  label: string;
  /** Optional count number shown after the label. */
  count?: number;
  /** Whether this filter is currently selected/active. */
  active: boolean;
  /** Click handler. Use onClick instead of onChange since this is a toggle button. */
  onClick: () => void;
  /** Visual tone when active. Defaults to a neutral zinc scheme. */
  tone?: "default" | "red" | "amber" | "emerald" | "cyan";
  /** Native tooltip text (maps to HTML title attribute). */
  title?: string;
};

/**
 * <FilterChip> — Outlined pill toggle for filter/selection controls.
 *
 * When `active` is true the chip gets a tinted background matching `tone`;
 * when inactive it is transparent with a dim border. Always clickable.
 *
 * Use FilterChip when the user picks a view/filter (e.g. toggle "30" day
 * window). Do NOT use for read-only status info (use StatusBadge) or for
 * imperative actions (use ActionChip).
 *
 * @example
 * ```tsx
 * <FilterChip label="TODAY" count={3} active={focusFilter === "order_now"}
 *   onClick={() => setFocusFilter("order_now")} tone="red" title="Items short within lead time" />
 * ```
 */
export default function FilterChip({
  label,
  count,
  active,
  onClick,
  tone = "default",
  title,
}: FilterChipProps) {
  const a = ACTIVE_TONES[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        // Layout & typography (same base for active & inactive)
        "inline-flex items-center gap-1 px-2 py-0.5 rounded",
        "text-[10px] font-mono uppercase tracking-wider",
        "transition-colors cursor-pointer select-none",
        // Active state
        active
          ? `${a.bg} ${a.text} ${a.border}`
          : // Inactive state
            "bg-transparent border border-zinc-700 text-dash-l3",
        // Hover state (only when the chip itself isn't already active)
        !active &&
          "hover:bg-zinc-800/50 hover:border-zinc-600 hover:text-dash-l1",
        // Active-badge border (always visible when active)
        active && "border",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="truncate max-w-[120px]">{label}</span>
      {count !== undefined && (
        <span className="opacity-60 tabular-nums">{count}</span>
      )}
    </button>
  );
}
