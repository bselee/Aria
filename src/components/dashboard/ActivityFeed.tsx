"use client";

/**
 * @file    ActivityFeed.tsx
 * @purpose Real-time AP activity feed with full reconciliation card expansion,
 *          Finale PO links, change detail rendering, and approve/reject/dismiss
 *          workflow identical to Telegram but on the dashboard.
 * @author  Will
 * @created 2026-02-27
 * @updated 2026-03-04
 * @deps    supabase, lucide-react
 */

import { useCallback, useEffect, useState } from "react";
import { createClient as createBrowserClient } from "@/lib/db";
import {
    ExternalLink, FileText, CheckCircle2, AlertCircle, Trash2,
    Webhook, BotMessageSquare, ChevronDown, ChevronRight,
    Check, X, Pause, RotateCcw, CreditCard,
    FileQuestion, Ban, Loader2, Send, TrendingUp, Sparkles,
    MessageSquare, CalendarDays, RefreshCw
} from "lucide-react";

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

type ActivityLog = {
    id: string;
    created_at: string;
    email_from: string;
    email_subject: string;
    intent: string;
    action_taken: string;
    metadata: any; // any: ap_activity_log.metadata JSONB — shape varies by intent
    reviewed_at: string | null;
    reviewed_action: string | null;
    dismiss_reason: string | null;
};

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────

/**
 * Construct a Finale PO URL from an orderId.
 * Uses the same base64-encoded pattern as ReceivedItemsPanel.
 */
function buildFinaleUrl(orderId: string): string {
    const accountPath = process.env.NEXT_PUBLIC_FINALE_ACCOUNT_PATH || "buildasoilorganics";
    const orderApiPath = `/${accountPath}/api/order/${orderId}`;
    const encoded = btoa(orderApiPath);
    return `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encoded}`;
}

function fmtTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDollars(n: number): string {
    return "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ──────────────────────────────────────────────────
// DISMISS OPTIONS
// ──────────────────────────────────────────────────

const DISMISS_OPTIONS = [
    { key: "already_handled", label: "Already Handled", icon: Check, description: "Already reconciled manually" },
    { key: "duplicate", label: "Duplicate", icon: RotateCcw, description: "Copy of an already-processed invoice" },
    { key: "credit_memo", label: "Credit Memo", icon: CreditCard, description: "Not a payable invoice — it's a credit" },
    { key: "statement", label: "Statement", icon: FileQuestion, description: "Misclassified — this is a statement" },
    { key: "not_ours", label: "Not Ours", icon: Ban, description: "Wrong company or vendor" },
] as const;

// ──────────────────────────────────────────────────
// RECONCILIATION CARD DETAIL
// ──────────────────────────────────────────────────

function ReconciliationDetail({ metadata }: { metadata: any }) {
    const priceChanges = metadata?.priceChanges || [];
    const feeChanges = metadata?.feeChanges || [];
    const tracking = metadata?.tracking;
    const totalImpact = metadata?.totalDollarImpact ?? metadata?.totalImpact ?? 0;
    const verdict = metadata?.verdict;

    const meaningfulPrices = priceChanges.filter(
        (pc: any) => pc.verdict !== "no_change" && pc.verdict !== "no_match"
    );

    if (meaningfulPrices.length === 0 && feeChanges.length === 0 && !tracking) {
        return (
            <div className="mt-2 text-xs text-zinc-600 font-mono italic">
                No price or fee changes to display.
            </div>
        );
    }

    return (
        <div className="mt-3 space-y-2 font-mono text-xs">
            {/* Verdict badge */}
            {verdict && (
                <div className="flex items-center gap-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${verdict === "auto_approve" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        : verdict === "needs_approval" ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                            : verdict === "rejected" ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
                                : "text-zinc-400 bg-zinc-700/20 border-zinc-700/30"
                        }`}>
                        {verdict.replace(/_/g, " ")}
                    </span>
                    <span className="text-zinc-500">
                        Impact: <span className={totalImpact > 0 ? "text-amber-400" : "text-zinc-400"}>{fmtDollars(totalImpact)}</span>
                    </span>
                </div>
            )}

            {/* Price changes table */}
            {meaningfulPrices.length > 0 && (
                <div>
                    <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-1">Price Changes</div>
                    <div className="space-y-0.5">
                        {meaningfulPrices.map((pc: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                                <span className={`text-[10px] ${pc.verdict === "auto_approve" ? "text-emerald-500" : pc.verdict === "rejected" ? "text-rose-500" : "text-amber-500"}`}>
                                    {pc.verdict === "auto_approve" ? "✅" : pc.verdict === "rejected" ? "🚨" : "⚠️"}
                                </span>
                                <span className="text-zinc-300 truncate max-w-[120px]" title={pc.description || pc.productId}>
                                    {pc.productId}
                                </span>
                                <span className="text-zinc-600">{fmtDollars(pc.from)}</span>
                                <span className="text-zinc-600">→</span>
                                <span className="text-zinc-200">{fmtDollars(pc.to)}</span>
                                <span className={`text-[10px] ${pc.pct > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                                    {pc.pct > 0 ? "+" : ""}{pc.pct?.toFixed(1)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Fee changes */}
            {feeChanges.length > 0 && (
                <div>
                    <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-1">Fee / Charge Updates</div>
                    <div className="space-y-0.5">
                        {feeChanges.map((fc: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                                <span className={`text-[10px] ${fc.verdict === "auto_approve" ? "text-emerald-500" : "text-amber-500"}`}>
                                    {fc.verdict === "auto_approve" ? "✅" : "⚠️"}
                                </span>
                                <span className="text-zinc-300 truncate max-w-[120px]">{fc.description || fc.type}</span>
                                {fc.from > 0 && (
                                    <>
                                        <span className="text-zinc-600">{fmtDollars(fc.from)}</span>
                                        <span className="text-zinc-600">→</span>
                                    </>
                                )}
                                <span className="text-zinc-200">{fmtDollars(fc.to)}</span>
                                {fc.from === 0 && <span className="text-[10px] text-blue-400 uppercase">New</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Tracking */}
            {tracking && (
                <div>
                    <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-1">Tracking</div>
                    {tracking.trackingNumbers?.length > 0 && (
                        <div className="text-zinc-300">🚚 {tracking.trackingNumbers.join(", ")}</div>
                    )}
                    {tracking.shipDate && <div className="text-zinc-400">📅 Ship date: {tracking.shipDate}</div>}
                    {tracking.carrier && <div className="text-zinc-400">📦 Carrier: {tracking.carrier}</div>}
                </div>
            )}
        </div>
    );
}

// ──────────────────────────────────────────────────
// AUTO-APPLY / VENDOR DISCREPANCY DETAIL
// ──────────────────────────────────────────────────

function AutoApplyDetail({ intent, metadata }: { intent: string; metadata: any }) {
    if (!metadata) return null;

    // RECONCILIATION_AUTO_APPLIED
    if (intent === "RECONCILIATION_AUTO_APPLIED") {
        const applied = metadata.applied ?? [];
        const skipped = metadata.skipped ?? [];
        const errors = metadata.errors ?? [];
        const hasFreight = metadata.hasFreightChange;

        return (
            <div className="mt-3 space-y-2 font-mono text-xs">
                {metadata.overallVerdict && (
                    <div className="flex items-center gap-1.5">
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border text-emerald-400 bg-emerald-500/10 border-emerald-500/20">
                            {metadata.overallVerdict}
                        </span>
                    </div>
                )}
                <div className="text-zinc-500 uppercase tracking-wider text-[10px]">
                    Changes Applied
                </div>
                {applied.length > 0 && (
                    <div className="space-y-0.5">
                        {applied.map((item: string, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 text-emerald-400">
                                <Check className="w-3 h-3 shrink-0" />
                                <span>{item}</span>
                            </div>
                        ))}
                    </div>
                )}
                {skipped.length > 0 && (
                    <div>
                        <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-0.5">Skipped</div>
                        {skipped.map((item: string, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 text-amber-400">
                                <AlertCircle className="w-3 h-3 shrink-0" />
                                <span>{item}</span>
                            </div>
                        ))}
                    </div>
                )}
                {errors.length > 0 && (
                    <div>
                        <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-0.5">Errors</div>
                        {errors.map((item: string, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 text-rose-400">
                                <AlertCircle className="w-3 h-3 shrink-0" />
                                <span>{item}</span>
                            </div>
                        ))}
                    </div>
                )}
                {hasFreight && (
                    <div className="text-blue-400 flex items-center gap-1">
                        <Send className="w-3 h-3" /> Freight change applied
                    </div>
                )}
                {metadata.priceChangeCount > 0 && (
                    <div className="text-zinc-400">
                        {metadata.priceChangeCount} price change{metadata.priceChangeCount !== 1 ? "s" : ""}
                        {metadata.feeChangeCount > 0 && ` · ${metadata.feeChangeCount} fee change${metadata.feeChangeCount !== 1 ? "s" : ""}`}
                    </div>
                )}
            </div>
        );
    }

    // RECONCILIATION_BLOCKED
    if (intent === "RECONCILIATION_BLOCKED") {
        const dollarImpact = metadata.totalDollarImpact ?? 0;
        const sanityViolation = metadata.sanityViolation;

        return (
            <div className="mt-3 space-y-2 font-mono text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-amber-400 font-bold">
                        {fmtDollars(dollarImpact)}
                    </span>
                    <span className="text-zinc-500">total dollar impact</span>
                </div>
                {metadata.priceChangeCount > 0 && (
                    <div className="text-zinc-400">
                        {metadata.priceChangeCount} price change{metadata.priceChangeCount !== 1 ? "s" : ""}
                        {metadata.feeChangeCount > 0 && ` · ${metadata.feeChangeCount} fee change${metadata.feeChangeCount !== 1 ? "s" : ""}`}
                    </div>
                )}
                {sanityViolation && (
                    <div className="flex items-center gap-1.5 text-rose-400 bg-rose-500/10 px-2 py-1 rounded">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        <span>Sanity check failed: {sanityViolation}</span>
                    </div>
                )}
            </div>
        );
    }

    // RECONCILIATION_ERROR
    if (intent === "RECONCILIATION_ERROR") {
        return (
            <div className="mt-3 space-y-1 font-mono text-xs">
                <div className="flex items-center gap-1.5 text-rose-400">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span className="text-zinc-400">Error:</span>
                    <span>{metadata.error ?? "Unknown error"}</span>
                </div>
            </div>
        );
    }

    // VENDOR_QTY_DISCREPANCY_EMAILED
    if (intent === "VENDOR_QTY_DISCREPANCY_EMAILED") {
        const shortLines = metadata.shortShipmentLines ?? [];
        return (
            <div className="mt-3 space-y-1 font-mono text-xs">
                {shortLines.length > 0 && (
                    <div>
                        <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-0.5">Short Shipment Lines</div>
                        {shortLines.map((sl: any, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-zinc-300">
                                <span className="text-amber-400">⚠</span>
                                <span>{sl.sku || sl.productId || sl.item}</span>
                                {sl.ordered !== undefined && sl.received !== undefined && (
                                    <span className="text-zinc-500">
                                        ordered {sl.ordered} · received {sl.received}
                                    </span>
                                )}
                                {sl.shortQty !== undefined && (
                                    <span className="text-rose-400">short {sl.shortQty}</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                {metadata.gmailMessageId && (
                    <div className="text-zinc-500 flex items-center gap-1">
                        <Send className="w-3 h-3" />
                        Email sent via Gmail
                    </div>
                )}
            </div>
        );
    }

    // VENDOR_QTY_DISCREPANCY_RESOLVED
    if (intent === "VENDOR_QTY_DISCREPANCY_RESOLVED") {
        return (
            <div className="mt-3 font-mono text-xs">
                <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span>Vendor replied — qty discrepancy resolved</span>
                </div>
            </div>
        );
    }

    // VENDOR_QTY_DISCREPANCY_ESCALATED
    if (intent === "VENDOR_QTY_DISCREPANCY_ESCALATED") {
        return (
            <div className="mt-3 font-mono text-xs">
                <div className="flex items-center gap-1.5 text-rose-400">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    <span>No reply in 7 days — requires manual follow-up</span>
                </div>
            </div>
        );
    }

    return null;
}

// ──────────────────────────────────────────────────
// DISMISS MENU

function DismissMenu({ onDismiss, loading }: { onDismiss: (reason: string) => void; loading: boolean }) {
    return (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
            {DISMISS_OPTIONS.map(opt => (
                <button
                    key={opt.key}
                    onClick={() => onDismiss(opt.key)}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-mono rounded-md bg-zinc-800/60 border border-zinc-700/40 hover:bg-zinc-700/60 hover:border-zinc-600/60 transition-all text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                    title={opt.description}
                >
                    <opt.icon className="w-3 h-3 shrink-0" />
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

// ──────────────────────────────────────────────────
// REMATCH PANEL (Phase 2 — Natural Language)
// ──────────────────────────────────────────────────

function RematchPanel({
    vendorName,
    invoiceNumber,
    onRematch,
    loading
}: {
    vendorName: string;
    invoiceNumber?: string;
    onRematch: (poNumber: string) => void;
    loading: boolean;
}) {
    const [candidates, setCandidates] = useState<any[]>([]);
    const [fetching, setFetching] = useState(false);
    const [poInput, setPoInput] = useState("");
    const [searching, setSearching] = useState(false);
    const [interpretation, setInterpretation] = useState<string | null>(null);
    const [smartResults, setSmartResults] = useState<any[] | null>(null);

    useEffect(() => {
        if (!vendorName) return;
        setFetching(true);
        fetch(`/api/dashboard/rematch-candidates?vendor=${encodeURIComponent(vendorName)}`)
            .then(r => r.json())
            .then(data => setCandidates(data.candidates || []))
            .catch(() => setCandidates([]))
            .finally(() => setFetching(false));
    }, [vendorName]);

    // Natural language search via LLM
    const handleSmartSearch = async () => {
        if (!poInput.trim()) return;

        // Check if it's a direct PO number (5-7 digits)
        if (/^\d{5,7}$/.test(poInput.trim())) {
            onRematch(poInput.trim());
            return;
        }

        setSearching(true);
        setInterpretation(null);
        setSmartResults(null);

        try {
            const res = await fetch("/api/dashboard/smart-rematch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: poInput.trim(),
                    vendor: vendorName,
                    invoiceNumber,
                }),
            });
            const data = await res.json();
            setInterpretation(data.interpretation || null);
            setSmartResults(data.matches || []);
        } catch {
            setInterpretation("Search failed. Try a PO number directly.");
            setSmartResults([]);
        } finally {
            setSearching(false);
        }
    };

    return (
        <div className="mt-2 space-y-2">
            {/* Candidate PO chips */}
            {fetching ? (
                <div className="flex items-center gap-1.5 text-xs text-zinc-600">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading POs for {vendorName}...
                </div>
            ) : candidates.length > 0 ? (
                <div>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Recent POs from {vendorName}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {candidates.map((c: any) => (
                            <button
                                key={c.orderId}
                                onClick={() => onRematch(c.orderId)}
                                disabled={loading}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-40"
                            >
                                {c.orderId}
                                {c.orderDate && <span className="text-zinc-600 text-[9px]">({new Date(c.orderDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })})</span>}
                                {c.total && <span className="text-zinc-500">${c.total.toLocaleString()}</span>}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <div className="text-xs text-zinc-600 font-mono">No recent POs found for {vendorName}</div>
            )}

            {/* Natural language + PO# input */}
            <div className="flex gap-1.5">
                <div className="flex-1 relative">
                    <MessageSquare className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-700" />
                    <input
                        type="text"
                        value={poInput}
                        onChange={e => { setPoInput(e.target.value); setSmartResults(null); setInterpretation(null); }}
                        placeholder='PO#, or try "the March order"...'
                        className="w-full pl-7 pr-2 py-1.5 text-xs font-mono bg-zinc-900 border border-zinc-700 rounded-md text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-blue-500/50"
                        onKeyDown={e => { if (e.key === "Enter") handleSmartSearch(); }}
                    />
                </div>
                <button
                    onClick={handleSmartSearch}
                    disabled={!poInput.trim() || searching || loading}
                    className="px-2 py-1 text-xs rounded-md bg-blue-500/20 text-blue-400 border border-blue-500/20 hover:bg-blue-500/30 transition-colors disabled:opacity-40"
                    title="Search with Aria"
                >
                    {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                </button>
            </div>

            {/* LLM interpretation */}
            {interpretation && (
                <div className="text-[10px] font-mono text-blue-400/80 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 shrink-0" />
                    {interpretation}
                </div>
            )}

            {/* Smart search results */}
            {smartResults && smartResults.length > 0 && (
                <div>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Aria suggests</div>
                    <div className="flex flex-wrap gap-1.5">
                        {smartResults.map((m: any) => (
                            <button
                                key={m.orderId}
                                onClick={() => onRematch(m.orderId)}
                                disabled={loading}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors disabled:opacity-40"
                            >
                                <Sparkles className="w-2.5 h-2.5" />
                                {m.orderId}
                                {m.orderDate && <span className="text-zinc-600 text-[9px]">
                                    ({new Date(m.orderDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })})
                                </span>}
                                {m.total && <span className="text-zinc-500">${m.total.toLocaleString()}</span>}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {smartResults && smartResults.length === 0 && (
                <div className="text-[10px] font-mono text-zinc-600">No matches found. Try a different description or PO number.</div>
            )}
        </div>
    );
}

// ──────────────────────────────────────────────────
// VENDOR INSIGHT BANNER
// ──────────────────────────────────────────────────

function VendorInsightBanner({ vendorName }: { vendorName: string }) {
    const [insight, setInsight] = useState<any>(null);
    const [fetching, setFetching] = useState(false);

    useEffect(() => {
        if (!vendorName) return;
        setFetching(true);
        fetch(`/api/dashboard/vendor-insights?vendor=${encodeURIComponent(vendorName)}`)
            .then(r => r.json())
            .then(data => setInsight(data))
            .catch(() => setInsight(null))
            .finally(() => setFetching(false));
    }, [vendorName]);

    if (fetching || !insight || !insight.suggestion) return null;

    const sug = insight.suggestion;
    const isAutoApprove = sug.type === "auto_approve";
    const isCaution = sug.type === "caution";

    return (
        <div className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md text-[10px] font-mono border transition-all ${isAutoApprove
            ? "bg-emerald-500/[.06] text-emerald-400 border-emerald-500/15"
            : isCaution
                ? "bg-amber-500/[.06] text-amber-400 border-amber-500/15"
                : "bg-zinc-800/30 text-zinc-500 border-zinc-800/40"
            }`}>
            {isAutoApprove ? (
                <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            ) : isCaution ? (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            ) : (
                <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            )}
            <div>
                <div>{sug.message}</div>
                {(insight.avgImpact > 0 || insight.autoApproveThreshold !== null) && (
                    <div className="text-zinc-600 mt-0.5">
                        {insight.avgImpact > 0 && <>Avg impact: {fmtDollars(insight.avgImpact)} · {insight.approvalRate}% approval rate</>}
                        {insight.autoApproveThreshold !== null && (
                            <span className="text-emerald-600"> · Auto-approve ≤{insight.autoApproveThreshold}%</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────
// ACTION BUTTONS
// ──────────────────────────────────────────────────

function ReconciliationActions({
    log,
    onAction
}: {
    log: ActivityLog;
    onAction: (logId: string, action: string, extra?: any) => Promise<void>;
}) {
    const [loading, setLoading] = useState(false);
    const [activePanel, setActivePanel] = useState<"dismiss" | "rematch" | null>(null);
    const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

    const isRecon = log.intent === "RECONCILIATION";
    const isPaused = log.reviewed_action === "paused";
    const isReviewed = !!log.reviewed_at && log.reviewed_action !== "paused";
    const needsApproval = log.action_taken?.toLowerCase().includes("flagged") ||
        log.action_taken?.toLowerCase().includes("review") ||
        log.metadata?.verdict === "needs_approval";

    // Don't show actions for non-reconciliation or already-reviewed entries
    if (!isRecon || (isReviewed && !isPaused)) return null;

    const handleAction = async (action: string, extra?: any) => {
        setLoading(true);
        try {
            await onAction(log.id, action, extra);
            setActivePanel(null);
        } catch (err: any) {
            setResult({ success: false, message: err.message });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="mt-3 space-y-2">
            {/* Vendor insight banner — Phase 2 smart suggestions */}
            <VendorInsightBanner vendorName={log.email_from || log.metadata?.vendorName || ""} />
            {result && (
                <div className={`text-xs font-mono px-2 py-1 rounded ${result.success ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
                    {result.message}
                </div>
            )}

            {/* Main action buttons */}
            <div className="flex flex-wrap gap-1.5">
                {/* Approve & Apply — visible for needs_approval or paused */}
                {(needsApproval || isPaused) && (
                    <button
                        onClick={() => handleAction("approve")}
                        disabled={loading}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors disabled:opacity-40"
                    >
                        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Approve & Apply
                    </button>
                )}

                {/* Pause — only for needs_approval (not already paused) */}
                {needsApproval && !isPaused && (
                    <button
                        onClick={() => handleAction("pause")}
                        disabled={loading}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
                    >
                        <Pause className="w-3 h-3" />
                        Pause
                    </button>
                )}

                {/* Re-match — visible for paused */}
                {isPaused && (
                    <button
                        onClick={() => setActivePanel(activePanel === "rematch" ? null : "rematch")}
                        disabled={loading}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md border transition-colors ${activePanel === "rematch"
                            ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                            : "bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20"
                            }`}
                    >
                        <RotateCcw className="w-3 h-3" />
                        Re-match
                    </button>
                )}

                {/* Dismiss — visible for needs_approval or paused */}
                {(needsApproval || isPaused) && (
                    <button
                        onClick={() => setActivePanel(activePanel === "dismiss" ? null : "dismiss")}
                        disabled={loading}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md border transition-colors ${activePanel === "dismiss"
                            ? "bg-zinc-600/20 text-zinc-300 border-zinc-500/30"
                            : "bg-zinc-700/10 text-zinc-400 border-zinc-700/20 hover:bg-zinc-700/20"
                            }`}
                    >
                        <X className="w-3 h-3" />
                        Dismiss
                    </button>
                )}

                {/* Acknowledge — for auto-approved entries that haven't been reviewed */}
                {!needsApproval && !isPaused && !isReviewed && (
                    <button
                        onClick={() => handleAction("approve")}
                        disabled={loading}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-zinc-700/20 text-zinc-400 border border-zinc-700/30 hover:bg-zinc-700/40 hover:text-zinc-200 transition-colors disabled:opacity-40"
                    >
                        <Check className="w-3 h-3" />
                        Reviewed
                    </button>
                )}
            </div>

            {/* Dismiss options panel */}
            {activePanel === "dismiss" && (
                <DismissMenu
                    onDismiss={(reason) => handleAction("dismiss", { dismissReason: reason })}
                    loading={loading}
                />
            )}

            {/* Re-match panel */}
            {activePanel === "rematch" && (
                <RematchPanel
                    vendorName={log.email_from || log.metadata?.vendorName || ""}
                    invoiceNumber={log.metadata?.invoiceNumber}
                    onRematch={(poNumber) => handleAction("rematch", { rematchPoNumber: poNumber })}
                    loading={loading}
                />
            )}
        </div>
    );
}

// ──────────────────────────────────────────────────
// MAIN COMPONENT
// ──────────────────────────────────────────────────

export default function ActivityFeed() {
    const [logs, setLogs] = useState<ActivityLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [activeFilter, setActiveFilter] = useState<string>("all");
    const [summary, setSummary] = useState<{
        autoApplied: number;
        blocked: number;
        errors: number;
        emailed: number;
        resolved: number;
        escalated: number;
        total: number;
    } | null>(null);

    useEffect(() => {
        const supabase = createBrowserClient();

        // Initial fetch
        const fetchLogs = async () => {
            const { data } = await supabase
                .from("ap_activity_log")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(50);

            if (data) setLogs(data);
            setLoading(false);
        };

        fetchLogs();

        // Subscribe to real-time INSERT and UPDATE events
        const subscription = supabase
            .channel("ap_activity_log_changes")
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "ap_activity_log" },
                (payload: any) => {
                    setLogs((current) => [payload.new as ActivityLog, ...current].slice(0, 50));
                }
            )
            .on(
                "postgres_changes",
                { event: "UPDATE", schema: "public", table: "ap_activity_log" },
                (payload: any) => {
                    setLogs((current) =>
                        current.map(log => log.id === payload.new.id ? payload.new as ActivityLog : log)
                    );
                }
            )
            .subscribe();

        return () => {
                    supabase.removeChannel(subscription);
                };
            }, []);

            // Fetch activity summary for auto-apply banner
            useEffect(() => {
                const fetchSummary = async () => {
                    try {
                        const res = await fetch("/api/dashboard/activity-summary");
                        if (res.ok) {
                            const data = await res.json();
                            setSummary(data);
                        }
                    } catch { /* ignore */ }
                };
                fetchSummary();
                const id = setInterval(fetchSummary, 60_000);
                return () => clearInterval(id);
            }, []);

            // Per-row UI state for the PO_ARRIVAL_AT_RISK action buttons. Keyed by
    // activity row id so independent rows don't share spinners or errors.
    const [poRiskBusy, setPoRiskBusy] = useState<Record<string, "draft" | "snooze" | "followup" | null>>({});
    const [poRiskError, setPoRiskError] = useState<Record<string, string | null>>({});
    const [poRiskDraft, setPoRiskDraft] = useState<Record<string, { subject: string; body: string; vendorEmail: string }>>({});

    const handlePOAction = useCallback(async (logId: string, action: "draft" | "snooze" | "followup") => {
        setPoRiskBusy(b => ({ ...b, [logId]: action }));
        setPoRiskError(e => ({ ...e, [logId]: null }));
        try {
            const route =
                action === "draft" ? "/api/dashboard/po-risk/compose-draft" :
                action === "snooze" ? "/api/dashboard/po-risk/snooze" :
                "/api/dashboard/po-risk/followed-up";
            const res = await fetch(route, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ activityId: logId, ...(action === "snooze" ? { hours: 48 } : {}) }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error ?? "Action failed");

            if (action === "draft") {
                setPoRiskDraft(d => ({
                    ...d,
                    [logId]: { subject: data.subject ?? "", body: data.body ?? "", vendorEmail: data.vendorEmail ?? "" },
                }));
            } else {
                // Snooze / followup: optimistically mark reviewed.
                setLogs(current => current.map(log => log.id === logId ? {
                    ...log,
                    reviewed_at: new Date().toISOString(),
                    reviewed_action: action === "snooze" ? "paused" : "followed_up",
                } : log));
            }
        } catch (err: any) {
            setPoRiskError(e => ({ ...e, [logId]: err?.message ?? "Action failed" }));
        } finally {
            setPoRiskBusy(b => ({ ...b, [logId]: null }));
        }
    }, []);

    // Handle reconciliation actions from the card buttons
    const handleAction = useCallback(async (logId: string, action: string, extra?: any) => {
        const res = await fetch("/api/dashboard/reconciliation-action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, activityLogId: logId, ...extra }),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || data.message || "Action failed");
        }

        // Optimistically update local state while waiting for realtime
        setLogs(current =>
            current.map(log => {
                if (log.id !== logId) return log;
                return {
                    ...log,
                    reviewed_at: new Date().toISOString(),
                    reviewed_action: action === "dismiss" ? "dismissed" : action === "rematch" ? null : action === "pause" ? "paused" : "approved",
                    action_taken: data.message || log.action_taken,
                    dismiss_reason: extra?.dismissReason || log.dismiss_reason,
                };
            })
        );
    }, []);

    if (loading) {
        return (
            <div className="space-y-4 px-4 py-6">
                {[1, 2, 3].map(i => (
                    <div key={i} className="p-4 rounded-xl border border-zinc-800/60 space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full skeleton-shimmer shrink-0" />
                            <div className="skeleton-shimmer h-3" style={{ width: `${50 + i * 10}%` }} />
                            <div className="skeleton-shimmer h-2.5 w-12 ml-auto" />
                        </div>
                        <div className="skeleton-shimmer h-4" style={{ width: `${60 + i * 8}%` }} />
                        <div className="skeleton-shimmer h-3" style={{ width: `${40 + i * 12}%` }} />
                    </div>
                ))}
            </div>
        );
    }

    // DECISION(2026-03-10): Filter out junk/advertisement entries from the feed.
    // Only actionable items (invoices, reconciliations, errors, items needing review)
    // are shown. User requested: "Only want to see actionable, clickable information
    // that needs human attention."
    const actionableLogs = logs.filter(log => {
        const isJunk = log.intent === "ADVERTISEMENT" || (
            log.action_taken.toLowerCase().includes("archived") &&
            !log.action_taken.toLowerCase().includes("review") &&
            !log.action_taken.toLowerCase().includes("flagged") &&
            !log.action_taken.toLowerCase().includes("error") &&
            !log.action_taken.toLowerCase().includes("failed")
        );
        return !isJunk;
    });
    const hiddenCount = logs.length - actionableLogs.length;

    return (
        <div className="space-y-4 px-4 py-2">
            {/* ── Auto-Apply Summary Banner ── */}
            {summary && (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800/60">
                    <CalendarDays className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider shrink-0">Auto-Apply (24h)</span>
                    {summary.autoApplied > 0 && (
                        <span className="text-[10px] font-mono text-emerald-400">{summary.autoApplied} applied</span>
                    )}
                    {summary.blocked > 0 && (
                        <span className="text-[10px] font-mono text-amber-400">{summary.blocked} blocked</span>
                    )}
                    {summary.errors > 0 && (
                        <span className="text-[10px] font-mono text-rose-400">{summary.errors} error{summary.errors !== 1 ? 's' : ''}</span>
                    )}
                    {summary.emailed > 0 && (
                        <span className="text-[10px] font-mono text-cyan-400">{summary.emailed} emailed</span>
                    )}
                    {summary.escalated > 0 && (
                        <span className="text-[10px] font-mono text-rose-300 font-semibold">{summary.escalated} escalated</span>
                    )}
                    {summary.total === 0 && (
                        <span className="text-[10px] font-mono text-zinc-600">no events</span>
                    )}
                    <div className="flex-1" />
                    <RefreshCw className="w-3 h-3 text-zinc-600 hover:text-zinc-400 cursor-pointer transition-colors"
                        onClick={() => {
                            fetch("/api/dashboard/activity-summary")
                                .then(r => r.json())
                                .then(setSummary)
                                .catch(() => {});
                        }} />
                </div>
            )}

            {/* ── Filter Pills ── */}
            <div className="flex items-center gap-1.5 px-1">
                {[
                    { key: "all", label: "All" },
                    { key: "needs_review", label: "Needs Review" },
                    { key: "auto_applied", label: "Auto-Applied" },
                    { key: "blocked", label: "Blocked" },
                    { key: "errors", label: "Errors" },
                ].map(f => (
                    <button key={f.key}
                        onClick={() => setActiveFilter(f.key)}
                        className={`text-[10px] font-mono px-2 py-1 rounded-full border transition-colors ${
                            activeFilter === f.key
                                ? "bg-zinc-700/50 text-zinc-200 border-zinc-600"
                                : "bg-transparent text-zinc-600 border-zinc-800 hover:text-zinc-400 hover:border-zinc-700"
                        }`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* ── Timeline ── */}
            <div className="space-y-6 relative before:absolute before:inset-0 before:ml-4 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-zinc-800 before:to-transparent">
            {hiddenCount > 0 && (
                <div className="text-center">
                    <span className="text-[10px] font-mono text-zinc-600 bg-zinc-900/50 px-2 py-0.5 rounded-full">
                        {hiddenCount} auto-archived hidden
                    </span>
                </div>
            )}
            {actionableLogs.map((log) => {
                // Determine styling based on intent and action
                let dotColor = "bg-zinc-700 ring-zinc-900";
                let Icon = BotMessageSquare;

                const isError = log.intent === "RECONCILIATION_ERROR" || log.action_taken.toLowerCase().includes("failed") || log.action_taken.toLowerCase().includes("error");
                const isAutoApplied = log.intent === "RECONCILIATION_AUTO_APPLIED";
                const isBlocked = log.intent === "RECONCILIATION_BLOCKED";
                const isEmailed = log.intent === "VENDOR_QTY_DISCREPANCY_EMAILED";
                const isResolved = log.intent === "VENDOR_QTY_DISCREPANCY_RESOLVED";
                const isEscalated = log.intent === "VENDOR_QTY_DISCREPANCY_ESCALATED";
                const isAutoApplyIntent = isAutoApplied || isBlocked || isError || isEmailed || isResolved || isEscalated;
                const needsReview = log.action_taken.toLowerCase().includes("review") || log.action_taken.toLowerCase().includes("flagged") || isBlocked || isEscalated;
                const isSuccess = isAutoApplied || isResolved || log.action_taken.toLowerCase().includes("applied") || (log.intent === "RECONCILIATION" && !needsReview);
                const isJunk = log.intent === "ADVERTISEMENT" || log.action_taken.toLowerCase().includes("archived");
                const isReviewed = !!log.reviewed_at && log.reviewed_action !== "paused";
                const isPaused = log.reviewed_action === "paused";
                const isDismissed = log.reviewed_action === "dismissed";
                const isRecon = log.intent === "RECONCILIATION";
                const isPOAtRisk = log.intent === "PO_ARRIVAL_AT_RISK";
                const poSeverity: "at_risk" | "soon_at_risk" = log.metadata?.severity === "soon_at_risk" ? "soon_at_risk" : "at_risk";
                const isPOSoon = isPOAtRisk && poSeverity === "soon_at_risk";
                const isExpanded = expandedId === log.id;

                // ── Filter by active filter ──
                if (activeFilter === "needs_review" && !(isBlocked || isEscalated || needsReview)) return null;
                if (activeFilter === "auto_applied" && !isAutoApplied) return null;
                if (activeFilter === "blocked" && !isBlocked) return null;
                if (activeFilter === "errors" && !isError) return null;

                if (isPOAtRisk && !isPOSoon) {
                    dotColor = "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.7)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isPOSoon) {
                    dotColor = "bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.6)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isAutoApplied) {
                    dotColor = "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] ring-zinc-900";
                    Icon = CheckCircle2;
                } else if (isBlocked) {
                    dotColor = "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isEmailed) {
                    dotColor = "bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)] ring-zinc-900";
                    Icon = Send;
                } else if (isResolved) {
                    dotColor = "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] ring-zinc-900";
                    Icon = CheckCircle2;
                } else if (isEscalated) {
                    dotColor = "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.7)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isError) {
                    dotColor = "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isPaused) {
                    dotColor = "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)] ring-zinc-900";
                    Icon = Pause;
                } else if (needsReview) {
                    dotColor = "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isSuccess || isReviewed) {
                    dotColor = "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] ring-zinc-900";
                    Icon = CheckCircle2;
                } else if (isJunk) {
                    dotColor = "bg-zinc-600 ring-zinc-900 opacity-50";
                    Icon = Trash2;
                } else {
                    dotColor = "bg-neon-blue shadow-[0_0_10px_rgba(59,130,246,0.5)] ring-zinc-900";
                    Icon = Webhook;
                }

                return (
                    <div key={log.id} className={`relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group transition-all duration-300 ${isReviewed && !isPaused ? "opacity-60" : ""} ${isDismissed ? "opacity-40" : ""}`}>
                        {/* Timeline Dot */}
                        <div className="flex items-center justify-center w-8 h-8 rounded-full border-4 border-[#09090b] bg-zinc-800 absolute left-0 md:left-1/2 -translate-x-1/2 shrink-0 shadow-lg z-10 transition-transform group-hover:scale-110">
                            <div className={`w-2 h-2 rounded-full ${dotColor}`} />
                        </div>

                        {/* Content Card */}
                        <div className={`w-[calc(100%-3rem)] md:w-[calc(50%-2rem)] ${isJunk ? "opacity-60" : ""}`}>
                            <div className={`p-4 rounded-xl bg-zinc-900/40 backdrop-blur-sm border transition-all duration-300 ${isPOAtRisk && !isPOSoon
                                ? "border-rose-500/40 hover:border-rose-500/60 bg-rose-500/[.05] border-l-2"
                                : isPOSoon
                                ? "border-amber-500/40 hover:border-amber-500/60 bg-amber-500/[.04] border-l-2"
                                : isPaused
                                    ? "border-amber-500/30 hover:border-amber-500/50 bg-amber-500/[.03]"
                                    : isReviewed
                                        ? "border-zinc-800/40 hover:border-zinc-700"
                                        : needsReview && isRecon
                                            ? "border-amber-500/20 hover:border-amber-500/40 border-l-2"
                                            : "border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/60"
                                }`}>
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2">
                                        <Icon className={`w-4 h-4 ${isError ? "text-rose-400" : isPaused ? "text-amber-300" : needsReview ? "text-amber-400" : isSuccess ? "text-emerald-400" : isJunk ? "text-zinc-500" : "text-neon-blue"}`} />
                                        <span className="text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">{log.intent}</span>
                                                                                {/* Classification badge: dropship flow-through vs real invoice */}
                                                                                {log.metadata?.classification === 'dropship_flow_through' && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                                                                                        ⟳ FLOW-THROUGH
                                                                                    </span>
                                                                                )}
                                                                                {log.metadata?.classification === 'real_invoice' && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                                                                        🔍 NEEDS ANALYSIS
                                                                                    </span>
                                                                                )}
                                                                                {/* Auto-apply intent badges */}
                                                                                {isAutoApplied && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                                                        ✅ AUTO-APPLIED
                                                                                    </span>
                                                                                )}
                                                                                {isBlocked && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                                                                                        ⚠️ BLOCKED
                                                                                    </span>
                                                                                )}
                                                                                {isEmailed && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                                                                                        📧 VENDOR EMAILED
                                                                                    </span>
                                                                                )}
                                                                                {isResolved && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                                                        ✅ RESOLVED
                                                                                    </span>
                                                                                )}
                                                                                {isEscalated && (
                                                                                    <span className="text-[10px] font-mono px-1 py-px rounded bg-rose-500/10 text-rose-300 border border-rose-500/20">
                                                                                        🚨 ESCALATED
                                                                                    </span>
                                                                                )}
                                                                                {/* Review status badges */}
                                        {isReviewed && !isDismissed && (
                                            <span className="text-[10px] font-mono px-1 py-px rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                ✓ {log.reviewed_action}
                                            </span>
                                        )}
                                        {isPaused && (
                                            <span className="text-[10px] font-mono px-1 py-px rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 animate-pulse">
                                                ⏸ PAUSED
                                            </span>
                                        )}
                                        {isDismissed && (
                                            <span className="text-[10px] font-mono px-1 py-px rounded bg-zinc-700/30 text-zinc-500 border border-zinc-700/30">
                                                ⏭ {log.dismiss_reason || "dismissed"}
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-xs font-mono text-[var(--dash-ts)]">{fmtTime(log.created_at)}</span>
                                </div>

                                <h3 className="text-sm font-semibold text-zinc-200 mb-1 leading-snug">{log.action_taken}</h3>
                                <p className="text-xs text-zinc-400 truncate" title={log.email_subject}>{log.email_subject}</p>

                                {/* PO_ARRIVAL_AT_RISK: structured detail block. The intent-specific
                                    rendering matches the spine-first routing rule — Activity is the
                                    surface, no separate panel needed. */}
                                {isPOAtRisk && log.metadata && (() => {
                                    const accent = isPOSoon ? "text-amber-300" : "text-rose-300";
                                    const accentSoft = isPOSoon ? "text-amber-200" : "text-rose-200";
                                    const accentDim = isPOSoon ? "text-amber-300/80" : "text-rose-300/80";
                                    const dotBg = isPOSoon ? "bg-amber-400/70" : "bg-rose-500/70";
                                    const busyAction = poRiskBusy[log.id] ?? null;
                                    const errText = poRiskError[log.id] ?? null;
                                    const draftPreview = poRiskDraft[log.id];
                                    const isDoneAction = !!log.reviewed_at;
                                    return (
                                        <div className="mt-3 space-y-1 text-[11px] font-mono">
                                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                                                <span className="text-zinc-500">PO</span>
                                                {log.metadata.poId && (
                                                    <a
                                                        href={buildFinaleUrl(log.metadata.poId)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className={`${accent} hover:opacity-80 font-semibold`}
                                                    >#{log.metadata.poId}</a>
                                                )}
                                                <span className="text-zinc-500">·</span>
                                                <span className="text-zinc-300">{log.metadata.vendorName}</span>
                                                <span className="text-zinc-500">·</span>
                                                <span className={accent}>{String(log.metadata.commState ?? "").replace(/_/g, " ")}</span>
                                                <span className="text-zinc-500">·</span>
                                                <span className={accentSoft}>arrives {log.metadata.expectedArrival}</span>
                                                {isPOSoon && (
                                                    <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/40">SOON</span>
                                                )}
                                            </div>
                                            {Array.isArray(log.metadata.atRiskItems) && log.metadata.atRiskItems.length > 0 && (
                                                <div className="mt-1 space-y-0.5">
                                                    {log.metadata.atRiskItems.slice(0, 5).map((it: any) => (
                                                        <div key={it.sku} className="flex items-center gap-2 text-zinc-400">
                                                            <span className={`w-1 h-1 rounded-full ${dotBg} shrink-0`} />
                                                            <span className="text-zinc-200 font-semibold">{it.sku}</span>
                                                            {it.productName && (
                                                                <span className="text-zinc-500 truncate max-w-[260px]" title={it.productName}>· {it.productName}</span>
                                                            )}
                                                            <span className={`${accentDim} ml-auto shrink-0`}>
                                                                {it.daysShort >= 0 ? `${it.daysShort}d short` : `${Math.abs(it.daysShort)}d buffer`}
                                                            </span>
                                                        </div>
                                                    ))}
                                                    {log.metadata.atRiskItems.length > 5 && (
                                                        <div className="text-zinc-600 pl-3">+ {log.metadata.atRiskItems.length - 5} more</div>
                                                    )}
                                                </div>
                                            )}

                                            {/* Action row */}
                                            {!isDoneAction && (
                                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                                    <button
                                                        onClick={() => handlePOAction(log.id, "draft")}
                                                        disabled={!!busyAction}
                                                        className="inline-flex items-center gap-1 text-[10px] font-mono font-medium uppercase tracking-wider px-2.5 py-1 rounded-md bg-neon-blue/10 text-neon-blue border border-neon-blue/30 hover:bg-neon-blue/20 disabled:opacity-40 disabled:cursor-wait transition-colors"
                                                    >
                                                        {busyAction === "draft" ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Drafting…</>
                                                        ) : draftPreview ? (
                                                            <><Sparkles className="w-3 h-3" /> Redraft</>
                                                        ) : (
                                                            <><Sparkles className="w-3 h-3" /> Compose ETA Draft</>
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() => handlePOAction(log.id, "snooze")}
                                                        disabled={!!busyAction}
                                                        className="inline-flex items-center gap-1 text-[10px] font-mono font-medium uppercase tracking-wider px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-wait transition-colors"
                                                    >
                                                        {busyAction === "snooze" ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Snoozing…</>
                                                        ) : (
                                                            <><Pause className="w-3 h-3" /> Snooze 48h</>
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() => handlePOAction(log.id, "followup")}
                                                        disabled={!!busyAction}
                                                        className="inline-flex items-center gap-1 text-[10px] font-mono font-medium uppercase tracking-wider px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-wait transition-colors"
                                                    >
                                                        {busyAction === "followup" ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Marking…</>
                                                        ) : (
                                                            <><Check className="w-3 h-3" /> Followed Up</>
                                                        )}
                                                    </button>
                                                    {errText && (
                                                        <span className="text-[10px] font-mono text-rose-400 ml-1" title={errText}>⚠ {errText.slice(0, 40)}</span>
                                                    )}
                                                </div>
                                            )}

                                            {/* Draft preview drawer — appears after Compose ETA Draft succeeds. */}
                                            {draftPreview && (
                                                <div className="mt-3 rounded-md bg-zinc-950/70 border border-zinc-800 p-3 text-[11px] font-mono">
                                                    <div className="flex items-center gap-2 text-zinc-400 mb-1.5">
                                                        <Sparkles className="w-3 h-3 text-neon-blue" />
                                                        <span>Draft saved to Gmail Drafts{draftPreview.vendorEmail ? ` (to ${draftPreview.vendorEmail})` : " — vendor email TBD"}</span>
                                                        <a
                                                            href="https://mail.google.com/mail/u/0/#drafts"
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="ml-auto text-neon-blue hover:text-blue-300"
                                                        >open ↗</a>
                                                    </div>
                                                    <div className="text-zinc-300"><span className="text-zinc-500">Subject:</span> {draftPreview.subject}</div>
                                                    <pre className="mt-1 whitespace-pre-wrap text-zinc-300 leading-relaxed">{draftPreview.body}</pre>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}

                                {/* Actionable Ghost Buttons — PO link + INV toggle */}
                                {log.metadata && (
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        {log.metadata.orderId && (
                                            <a
                                                href={buildFinaleUrl(log.metadata.orderId)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-neon-blue/10 text-neon-blue border border-neon-blue/20 hover:bg-neon-blue/20 transition-colors"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                                PO {log.metadata.orderId}
                                            </a>
                                        )}
                                        {log.metadata.invoiceNumber && (
                                            <button
                                                onClick={() => setExpandedId(isExpanded ? null : log.id)}
                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md border transition-colors ${isExpanded
                                                    ? "bg-neon-purple/20 text-neon-purple border-neon-purple/30"
                                                    : "bg-neon-purple/10 text-neon-purple border-neon-purple/20 hover:bg-neon-purple/20"
                                                    }`}
                                            >
                                                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                                INV {log.metadata.invoiceNumber}
                                            </button>
                                        )}
                                        {needsReview && !isRecon && (
                                            <button className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/20 transition-colors">
                                                Verify Variance
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Expanded reconciliation details */}
                                {isExpanded && isRecon && (
                                    <ReconciliationDetail metadata={log.metadata} />
                                )}

                                {/* Expanded auto-apply details */}
                                {isExpanded && isAutoApplyIntent && (
                                    <AutoApplyDetail intent={log.intent} metadata={log.metadata} />
                                )}

                                {/* Action buttons for RECONCILIATION entries — skip auto-apply intents */}
                                <ReconciliationActions log={log} onAction={handleAction} />
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
        </div>
    );
}
