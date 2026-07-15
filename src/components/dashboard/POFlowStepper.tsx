/**
 * @file    POFlowStepper.tsx
 * @purpose Compact horizontal flow stepper used in Active Purchases and Receivings panels.
 *          Shows a human operator the current step in the PO lifecycle at a glance,
 *          and what action is needed next.
 *
 *          Active Purchases mode (3 steps):
 *            📤 Sent → 👀 Acknowledged → 📬 In Transit
 *
 *          Receivings mode (3 steps):
 *            📦 Received → 📄 Invoice Matched → 🔒 Complete
 *
 * @deps    react
 * @author  Hermia
 * @created 2026-07-15
 */

"use client";

import React from "react";

export type StepperMode = "active-purchases" | "receivings";

export type StepState = "done" | "active" | "pending" | "issue";

export interface POFlowStep {
    label: string;
    emoji: string;
    state: StepState;
    action?: string;        // What the human should do at this step
    actionButton?: {
        text: string;
        onClick: () => void;
        loading?: boolean;
        tone?: "primary" | "warning" | "danger" | "success" | "default";
    };
}

interface POFlowStepperProps {
    steps: POFlowStep[];
    /** Optional — only show the active step with its action, collapse completed */
    compact?: boolean;
}

const stepColors: Record<StepState, { dot: string; line: string; label: string; bg: string }> = {
    done:   { dot: "bg-emerald-500",        line: "bg-emerald-500/40",    label: "text-emerald-400",  bg: "bg-emerald-500/10" },
    active: { dot: "bg-amber-400 animate-pulse", line: "bg-amber-500/30", label: "text-amber-300",    bg: "bg-amber-500/10" },
    pending: { dot: "bg-zinc-700",          line: "bg-zinc-800/60",      label: "text-zinc-500",     bg: "bg-zinc-800/30" },
    issue:  { dot: "bg-rose-500 animate-pulse", line: "bg-rose-500/30",  label: "text-rose-400",     bg: "bg-rose-500/10" },
};

/** POFlowStepper — compact horizontal visual flow for human operators */
export default function POFlowStepper({ steps, compact = false }: POFlowStepperProps) {
    const activeIdx = steps.findIndex(s => s.state === "active" || s.state === "issue");
    const visibleSteps = compact && activeIdx > 1 ? steps.slice(Math.max(0, activeIdx - 1)) : steps;

    return (
        <div className="flex flex-col gap-2">
            {/* Stepper dots + labels */}
            <div className="flex items-center gap-0">
                {visibleSteps.map((step, i) => {
                    const colors = stepColors[step.state];
                    const isLast = i === visibleSteps.length - 1;
                    const isFirst = i === 0;
                    const isActive = step.state === "active" || step.state === "issue";
                    return (
                        <React.Fragment key={step.label}>
                            {/* Step dot + label */}
                            <div className={`flex flex-col items-center ${isActive ? "cursor-pointer" : ""}`}>
                                <div className={`w-5 h-5 rounded-full flex items-center justify-center ${colors.bg} border-2 ${step.state === "done" ? "border-emerald-500/60" : step.state === "active" ? "border-amber-400/60" : step.state === "issue" ? "border-rose-500/60" : "border-zinc-700/60"}`}>
                                    {step.state === "done" ? (
                                        <span className="text-[10px] text-emerald-400">✓</span>
                                    ) : (
                                        <span className="text-[10px]">{step.emoji}</span>
                                    )}
                                </div>
                                <span className={`text-[9px] font-mono mt-0.5 whitespace-nowrap ${colors.label} ${step.state === "pending" ? "hidden sm:inline" : ""}`}>
                                    {step.state === "pending" ? "" : step.label}
                                </span>
                            </div>
                            {/* Connector line */}
                            {!isLast && (
                                <div className={`flex-1 h-0.5 mx-1 mb-3.5 ${colors.line}`} />
                            )}
                        </React.Fragment>
                    );
                })}
            </div>

            {/* Action button for active step */}
            {visibleSteps.find(s => s.actionButton) && (
                <div className="flex flex-wrap items-center gap-2 mt-1">
                    {visibleSteps.map((step) => {
                        if (!step.actionButton || (step.state !== "active" && step.state !== "issue")) return null;
                        const btn = step.actionButton;
                        const toneStyles = {
                            primary:  "bg-blue-500/15 border-blue-500/40 text-blue-300 hover:bg-blue-500/25",
                            warning:  "bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25",
                            danger:   "bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25",
                            success:  "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25",
                            default:  "bg-zinc-800/50 border-zinc-700/40 text-zinc-300 hover:bg-zinc-700/50",
                        };
                        return (
                            <button
                                key={step.label}
                                onClick={(e) => { e.stopPropagation(); btn.onClick(); }}
                                disabled={btn.loading}
                                className={`text-[11px] font-mono font-semibold px-2.5 py-1 rounded border cursor-pointer transition-colors ${toneStyles[btn.tone || "primary"]} ${btn.loading ? "opacity-50 cursor-wait" : ""}`}
                            >
                                {btn.loading ? "Working…" : `${step.emoji} ${btn.text}`}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
