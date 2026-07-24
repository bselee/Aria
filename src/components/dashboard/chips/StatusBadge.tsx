/**
 * @file    src/components/dashboard/chips/StatusBadge.tsx
 * @purpose Read-only status indicator with a solid/tinted badge appearance.
 *          Use for passive state labels that should be visually consumed but
 *          never interacted with (e.g. "In Transit", "⚠ OVERDUE 35d", "CRIT").
 *          Visually distinct from FilterChip (outlined toggle) and ActionChip
 *          (filled action button) — StatusBadge uses a heavier fill, NO hover
 *          effect, NO cursor-pointer, and an optional icon slot.
 * @author  delegated engineer (via Hermia oversight)
 * @created 2026-07-24
 * @deps    react
 */

"use client";

import React from "react";

/* ── Tone → Tailwind class map ──────────────────────────────────────── */
const TONE_STYLES: Record<NonNullable<StatusBadgeProps["tone"]>, string> = {
  red:     "bg-red-500/20 text-red-300  border-red-500/30",
  amber:   "bg-amber-500/20 text-amber-300  border-amber-500/30",
  orange:  "bg-orange-500/20 text-orange-300 border-orange-500/30",
  cyan:    "bg-cyan-500/20 text-cyan-300  border-cyan-500/30",
  emerald: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rose:    "bg-rose-500/20 text-rose-300  border-rose-500/30",
  neutral: "bg-zinc-800 text-zinc-300 border-zinc-700/50",
};

/* ── Types ──────────────────────────────────────────────────────────── */

export type StatusBadgeProps = {
  /** Short status label. Rendered uppercase via Tailwind (house style). */
  label: string;
  /** Semantic tone matching Aria color conventions. */
  tone: "red" | "amber" | "orange" | "cyan" | "emerald" | "rose" | "neutral";
  /** Optional leading icon (e.g. a lucide-react icon component instance). */
  icon?: React.ReactNode;
};

/**
 * <StatusBadge> — Heavily-tinted, non-interactive status indicator.
 *
 * Use for read-only metadata badges that communicate state at a glance.
 * Never clickable — no onClick, no hover effect, no cursor change.
 * The heavier fill (bg-*-500/20 + border) and `rounded-md` radius are
 * intentionally different from FilterChip's outlined pill and ActionChip's
 * solid button to make status info visually distinct at a glance.
 *
 * Use StatusBadge when the badge is passive info only. If it's a toggle
 * that changes what you see, use FilterChip. If clicking it performs an
 * action, use ActionChip.
 *
 * @example
 * ```tsx
 * <StatusBadge label="In Transit" tone="cyan" icon={<Truck size={10} />} />
 * <StatusBadge label="OVERDUE 35d" tone="red" />
 * ```
 */
export default function StatusBadge({
  label,
  tone,
  icon,
}: StatusBadgeProps) {
  return (
    <span
      className={[
        TONE_STYLES[tone],
        // Layout & typography
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
        "text-[10px] font-mono uppercase tracking-wider leading-none",
        // Explicitly NOT interactive
        "select-none",
        // Border — all tones get one for definition on the dark background
        "border",
      ].join(" ")}
    >
      {icon && (
        <span className="shrink-0 flex items-center [&>svg]:w-2.5 [&>svg]:h-2.5">
          {icon}
        </span>
      )}
      <span className="truncate max-w-[140px]">{label}</span>
    </span>
  );
}
