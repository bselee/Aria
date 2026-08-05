/**
 * @file    InvoicePOMatcher.tsx
 * @purpose Invoice-to-PO matching for the Receivings column.
 *          Three clear sections: Ready to Match (high confidence, compact),
 *          Needs Review (low confidence / no candidates, detailed),
 *          Auto-Matched (system-matched, just needs approval).
 *
 * @author  Hermia
 * @created 2026-08-03
 * @deps    react, lucide-react
 */

"use client";

import React from "react";
import { useMemo, useState } from "react";
import { Check } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────

type InvoiceLineItem = { sku?: string; qty?: number; description?: string };

type MatchCandidate = {
    orderId: string;
    vendorName: string;
    orderDate: string;
    total: number;
    status: string;
    score: number;
    reasons: string[];
    isOpen: boolean;
};

type MatchSuggestion = {
    invoiceId: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceTotal: number;
    invoiceDate?: string;
    candidates: MatchCandidate[];
    autoApplyReady: boolean;
    autoMatched?: boolean;
    fromCache?: boolean;
    timedOut?: boolean;
    invoiceLineItems?: InvoiceLineItem[] | null;
};

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    supplier: string;
    total: number;
    items: Array<{ productId: string; quantity: number }>;
};

type InvoicePOMatcherProps = {
    suggestions: MatchSuggestion[];
    receivedPOs: ReceivedPO[];
    onMatch: (invoiceId: string, poNumber: string) => Promise<void>;
    onManualMatch: (invoiceId: string) => Promise<void>;
    onApproveReconciliation: (orderId: string, invoiceId?: string) => Promise<void>;
    approvingReconcile: Set<string>;
    manuallyMatching: Map<string, { poNumber: string; loading: boolean }>;
    onManualInputChange: (invoiceId: string, value: string) => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const READY_THRESHOLD = 70;
const REVIEW_THRESHOLD = 50;

function fmtDollars(n: number): string {
    if (!n || n <= 0) return "$0";
    return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtShortDate(s: string | undefined | null): string {
    if (!s) return "";
    const d = new Date(s.includes("T") ? s : s + "T00:00:00");
    if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function parseDate(s: string | undefined | null): number {
    if (!s) return 0;
    const d = new Date(s.includes("T") ? s : s + "T00:00:00");
    return isNaN(d.getTime()) ? 0 : d.getTime();
}
function daysBetween(a: string | undefined | null, b: string | undefined | null): number | null {
    const da = parseDate(a);
    const db = parseDate(b);
    if (!da || !db) return null;
    return Math.round((da - db) / 86_400_000);
}

// ── Component ─────────────────────────────────────────────────────────────

export default function InvoicePOMatcher({
    suggestions,
    receivedPOs,
    onMatch,
    onManualMatch,
    onApproveReconciliation,
    approvingReconcile,
    manuallyMatching,
    onManualInputChange,
}: InvoicePOMatcherProps) {
    // ── Partition into sections ──────────────────────────────────────────
    const { ready, review, autoMatched } = useMemo(() => {
        const ready: MatchSuggestion[] = [];
        const review: MatchSuggestion[] = [];
        const autoMatched: MatchSuggestion[] = [];

        for (const s of suggestions) {
            if (s.autoMatched) {
                autoMatched.push(s);
            } else {
                const best = s.candidates[0]?.score ?? 0;
                if (best >= READY_THRESHOLD) {
                    ready.push(s);
                } else {
                    review.push(s);
                }
            }
        }

        // Sort within each: highest score first
        const byScore = (a: MatchSuggestion, b: MatchSuggestion) =>
            (b.candidates[0]?.score ?? 0) - (a.candidates[0]?.score ?? 0);
        ready.sort(byScore);
        review.sort(byScore);
        autoMatched.sort(byScore);

        return { ready, review, autoMatched };
    }, [suggestions]);

    if (suggestions.length === 0) {
        return (
            <div className="px-4 py-6 text-center">
                <span className="text-xs font-mono text-emerald-400/70">
                    ✅ All invoices matched — nothing needs attention
                </span>
            </div>
        );
    }

    const totalDollars = suggestions.reduce((sum, s) => sum + (Number(s.invoiceTotal) || 0), 0);
    const readyTotal = ready.reduce((s, r) => s + (Number(r.invoiceTotal) || 0), 0);
    const reviewTotal = review.reduce((s, r) => s + (Number(r.invoiceTotal) || 0), 0);
    const autoTotal = autoMatched.reduce((s, r) => s + (Number(r.invoiceTotal) || 0), 0);

    // ── Expanded alternatives state ──────────────────────────────────────
    const [expandedAlts, setExpandedAlts] = useState<Set<string>>(new Set());

    // ── Shared row renderer ───────────────────────────────────────────────
    function Row({ s, compact = false }: { s: MatchSuggestion; compact?: boolean }) {
        const best = s.candidates[0];
        const hasCandidates = s.candidates.length > 0;
        const hasLineItems = s.invoiceLineItems && s.invoiceLineItems.length > 0;
        const isAuto = s.autoMatched;

        return (
            <div className="px-3 py-1.5 border-b border-zinc-800/30">
                {/* Main line: score · invoice · vendor · date · $ · action */}
                <div className="flex items-center gap-1.5">
                    {/* Score badge — category label instead of percentage */}
                    {isAuto ? (
                        <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                    ) : best && best.score >= 80 ? (
                        <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shrink-0">High</span>
                    ) : best && best.score >= 70 ? (
                        <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 shrink-0">Good</span>
                    ) : best && best.score >= 50 ? (
                        <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-zinc-600/40 bg-zinc-700/20 text-zinc-400 shrink-0">Low</span>
                    ) : (
                        <span className="text-[9px] font-mono text-zinc-600 shrink-0">—</span>
                    )}

                    {/* Invoice # */}
                    <span className={`text-[11px] font-mono font-semibold ${isAuto ? "text-zinc-500" : "text-zinc-100"}`}>
                        {s.invoiceNumber || "—"}
                    </span>

                    {/* Vendor */}
                    <span className="text-[10px] font-mono text-zinc-500 truncate">
                        {s.vendorName}
                    </span>

                    {/* Date */}
                    {s.invoiceDate && (
                        <span className="text-[9px] font-mono text-zinc-600 shrink-0">
                            {fmtShortDate(s.invoiceDate)}
                        </span>
                    )}

                    {/* Amount */}
                    {s.invoiceTotal <= 0 ? (
                        <span className="text-[9px] font-mono text-amber-500/60 ml-auto shrink-0" title="OCR could not read invoice total">
                            $?
                        </span>
                    ) : (
                        <span className="text-[10px] font-mono text-zinc-400 ml-auto shrink-0">
                            {fmtDollars(s.invoiceTotal)}
                        </span>
                    )}

                    {/* → PO target */}
                    {best && !isAuto && (
                        <span className="text-[9px] font-mono text-zinc-600 shrink-0">
                            → {best.orderId}
                        </span>
                    )}

                    {/* Action button */}
                    <div className="shrink-0">
                        {isAuto && best ? (
                            <button
                                onClick={() => onApproveReconciliation(best.orderId, s.invoiceId)}
                                disabled={approvingReconcile.has(best.orderId)}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors
                                    ${approvingReconcile.has(best.orderId)
                                        ? "opacity-50 cursor-wait bg-zinc-800/30 border-zinc-700/30 text-zinc-500"
                                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                                    }`}
                            >
                                {approvingReconcile.has(best.orderId) ? "…" : "Approve"}
                            </button>
                        ) : hasCandidates && best ? (
                            <button
                                onClick={() => onMatch(s.invoiceId, best.orderId)}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors shrink-0 ${
                                    compact
                                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                                        : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                                }`}
                            >
                                {compact ? "Review match" : "Compare"}
                            </button>
                        ) : (
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    placeholder="PO #"
                                    value={manuallyMatching.get(s.invoiceId)?.poNumber ?? ""}
                                    onChange={(e) => onManualInputChange(s.invoiceId, e.target.value)}
                                    className="w-14 px-1 py-0.5 rounded text-[9px] font-mono bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 placeholder-zinc-600"
                                />
                                <button
                                    onClick={() => onManualMatch(s.invoiceId)}
                                    disabled={!manuallyMatching.get(s.invoiceId)?.poNumber?.trim()}
                                    className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Go
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Detail line (only for non-compact / review rows) */}
                {!compact && (
                    <>
                        {/* Structured comparison — invoice vs PO side by side */}
                        {best && (
                            <div className="mt-1 ml-8 grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5 text-[8px] font-mono">
                                {/* Header */}
                                <span className="text-zinc-600"></span>
                                <span className="text-zinc-500 font-semibold">Invoice</span>
                                <span className="text-zinc-500 font-semibold">
                                    PO {best.orderId}
                                </span>

                                {/* Vendor */}
                                <span className="text-zinc-600">Vendor</span>
                                <span className="text-zinc-300">{s.vendorName}</span>
                                <span className={s.vendorName === best.vendorName ? "text-emerald-400" : "text-amber-400"}>
                                    {best.vendorName}
                                </span>

                                {/* Amount */}
                                <span className="text-zinc-600">Amount</span>
                                {s.invoiceTotal <= 0 ? (
                                    <span className="text-[9px] font-mono text-amber-500/60" title="OCR could not read invoice total">$?</span>
                                ) : (
                                    <span className="text-zinc-300">{fmtDollars(s.invoiceTotal)}</span>
                                )}
                                {s.invoiceTotal <= 0 ? (
                                    <span className="text-zinc-400">{fmtDollars(best.total)}</span>
                                ) : (
                                    <span className={Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)) < 1 ? "text-emerald-400" : "text-amber-400"}>
                                        {fmtDollars(best.total)}
                                        {Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)) >= 1 && (
                                            <span className="text-zinc-500 ml-0.5">
                                                Δ{fmtDollars(Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)))}
                                            </span>
                                        )}
                                    </span>
                                )}

                                {/* Date */}
                                <span className="text-zinc-600">Date</span>
                                <span className="text-zinc-300">{fmtShortDate(s.invoiceDate)}</span>
                                {(() => {
                                    const delta = daysBetween(s.invoiceDate, best.orderDate);
                                    const withinWeek = delta !== null && Math.abs(delta) <= 7;
                                    return (
                                        <span className={withinWeek ? "text-emerald-400" : "text-amber-400"}>
                                            {fmtShortDate(best.orderDate)}
                                            {delta !== null && (
                                                <span className="text-zinc-500 ml-0.5">
                                                    {delta > 0 ? `+${delta}d` : `${delta}d`}
                                                </span>
                                            )}
                                        </span>
                                    );
                                })()}

                                {/* Items (if line items exist) */}
                                {hasLineItems && (() => {
                                    const poItems = receivedPOs.find(p => p.orderId === best.orderId)?.items ?? [];
                                    const matched = s.invoiceLineItems!.filter(li => li.sku && poItems.some(pi => pi.productId === li.sku));
                                    const unmatched = s.invoiceLineItems!.filter(li => li.sku && !poItems.some(pi => pi.productId === li.sku));
                                    const poOnly = poItems.filter(pi => !s.invoiceLineItems!.some(li => li.sku === pi.productId));
                                    return (
                                        <>
                                            <span className="text-zinc-600">Items</span>
                                            <span className="text-zinc-300">
                                                {s.invoiceLineItems!.map(li => li.sku || li.description || "—").join(", ")}
                                            </span>
                                            <span className="text-zinc-400">
                                                {matched.length > 0 && (
                                                    <span className="text-emerald-400">{matched.map(li => li.sku).join(", ")}</span>
                                                )}
                                                {unmatched.length > 0 && (
                                                    <span className="text-rose-400/70 ml-0.5">missing: {unmatched.map(li => li.sku).join(", ")}</span>
                                                )}
                                                {poOnly.length > 0 && (
                                                    <span className="text-zinc-600 ml-0.5">+{poOnly.length} more on PO</span>
                                                )}
                                            </span>
                                        </>
                                    );
                                })()}

                                {/* Verdict line */}
                                <span className="text-zinc-600 pt-0.5">Verdict</span>
                                <span className="text-zinc-400 pt-0.5 col-span-2">
                                    {best.reasons.slice(0, 3).join(" · ")}
                                </span>
                            </div>
                        )}

                        {/* Alternatives — collapsed by default */}
                        {!isAuto && s.candidates.length > 1 && (
                            <div className="mt-0.5 ml-8">
                                {expandedAlts.has(s.invoiceId) ? (
                                    <div className="flex flex-wrap gap-1 text-[8px] font-mono">
                                        {s.candidates.slice(1).map(c => {
                                            const delta = daysBetween(s.invoiceDate, c.orderDate);
                                            return (
                                                <button
                                                    key={c.orderId}
                                                    onClick={() => onMatch(s.invoiceId, c.orderId)}
                                                    className={`px-1 py-px rounded border ${c.score >= 70 ? 'text-amber-400 border-amber-500/20 bg-amber-500/5' : 'text-zinc-500 border-zinc-700/30 bg-zinc-800/20'} hover:bg-zinc-700/30`}
                                                >
                                                    {c.score}% {c.orderId}
                                                    {delta != null && <span className="opacity-60"> {delta > 0 ? `+${delta}d` : `${delta}d`}</span>}
                                                </button>
                                            );
                                        })}
                                        <button
                                            onClick={() => setExpandedAlts(prev => { const n = new Set(prev); n.delete(s.invoiceId); return n; })}
                                            className="text-zinc-500 hover:text-zinc-300 px-1"
                                        >
                                            collapse
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        onClick={() => setExpandedAlts(prev => new Set(prev).add(s.invoiceId))}
                                        className="text-[8px] font-mono text-zinc-500 hover:text-zinc-300"
                                    >
                                        +{s.candidates.length - 1} other possible match{s.candidates.length - 1 > 1 ? 'es' : ''}
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    }

    return (
        <div className="border-t border-amber-500/20 bg-amber-500/[0.02]">
            {/* Header */}
            <div className="px-3 py-1 flex items-center gap-2 border-b border-amber-500/10 bg-amber-500/5">
                <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-amber-300/70">
                    Invoices to match
                </span>
                <span className="text-[10px] font-mono text-amber-500/50">
                    {suggestions.length}
                </span>
                <span className="text-[9px] font-mono text-zinc-600 ml-auto">
                    {fmtDollars(totalDollars)}
                </span>
            </div>

            <div className="max-h-[480px] overflow-y-auto">
                {/* ── SECTION 1: Ready to Match (compact) ── */}
                {ready.length > 0 && (
                    <div>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-emerald-400/60 uppercase tracking-wider bg-emerald-500/5 border-b border-emerald-500/10">
                            High confidence · {ready.length} · {readyTotal <= 0 ? <span className="text-amber-500/60" title="OCR could not read invoice total">$?</span> : fmtDollars(readyTotal)}
                        </div>
                        {ready.map(s => <Row key={s.invoiceId} s={s} compact />)}
                    </div>
                )}

                {/* ── SECTION 2: Needs Review (detailed) ── */}
                {review.length > 0 && (
                    <div>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-amber-400/60 uppercase tracking-wider bg-amber-500/5 border-b border-amber-500/10">
                            Review recommended · {review.length} · {reviewTotal <= 0 ? <span className="text-amber-500/60" title="OCR could not read invoice total">$?</span> : fmtDollars(reviewTotal)}
                        </div>
                        {review.map(s => <Row key={s.invoiceId} s={s} />)}
                    </div>
                )}

                {/* ── SECTION 3: Auto-Matched ── */}
                {autoMatched.length > 0 && (
                    <div>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-zinc-500 uppercase tracking-wider bg-zinc-800/20 border-b border-zinc-700/30">
                            Auto-matched · ready to approve · {autoMatched.length} · {autoTotal <= 0 ? <span className="text-amber-500/60" title="OCR could not read invoice total">$?</span> : fmtDollars(autoTotal)}
                        </div>
                        {autoMatched.map(s => <Row key={s.invoiceId} s={s} />)}
                    </div>
                )}
            </div>
        </div>
    );
}
