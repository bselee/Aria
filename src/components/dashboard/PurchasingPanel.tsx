"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown, ExternalLink, Zap, Eye, ShoppingCart } from "lucide-react";

// ── types ──────────────────────────────────────────────────────────────────
type PurchasingItem = {
    productId: string; productName: string; supplierName: string; supplierPartyId: string;
    unitPrice: number; stockOnHand: number; stockOnOrder: number;
    purchaseVelocity: number; salesVelocity: number; demandVelocity: number; dailyRate: number;
    runwayDays: number; adjustedRunwayDays: number; leadTimeDays: number; leadTimeProvenance: string;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    urgency: "critical" | "warning" | "watch" | "ok";
    explanation: string; suggestedQty: number;
    orderIncrementQty: number | null; isBulkDelivery: boolean;
    finaleReorderQty: number | null; finaleStockoutDays: number | null; finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;
};
type PurchasingGroup = {
    vendorName: string; vendorPartyId: string;
    urgency: "critical" | "warning" | "watch" | "ok";
    items: PurchasingItem[];
};
type AssessmentData = { groups: PurchasingGroup[]; cachedAt: string };
type POResult = { orderId: string; finaleUrl: string };
type CommitReview = {
    sendId: string;
    review: {
        orderId: string; vendorName: string; total: number; orderDate: string;
        items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }>;
        finaleUrl: string;
    };
    email: string;
    emailSource: string;
};
type SnoozeEntry = { until: number | "forever" };
type SnoozeMap = Record<string, SnoozeEntry>;
type UlineOrderResult = { success: boolean; itemsAdded: number; message: string; errors?: string[] };

// ── constants ──────────────────────────────────────────────────────────────
const SNOOZE_LS = "aria-dash-purchasing-snooze";
const URGENCY_RANK = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
// DECISION(2026-03-10): Badge hierarchy reform — only CRIT gets a filled pill.
// WARN = amber text only (no pill).  WATCH/OK = invisible badge.
// This prevents badge blindness when most rows are critical.
const URGENCY = {
    critical: { badge: "bg-red-500/20 text-red-300 border-red-500/40", badgeOutline: "bg-transparent text-red-400 border-red-500/30", dot: "bg-red-500", label: "CRIT", tab: "border-red-500 text-red-300" },
    warning: { badge: "text-amber-400", badgeOutline: "text-amber-400", dot: "bg-amber-400", label: "WARN", tab: "border-amber-400 text-amber-300" },
    watch: { badge: "text-zinc-500", badgeOutline: "text-zinc-500", dot: "bg-emerald-500", label: "WTCH", tab: "border-emerald-500 text-emerald-300" },
    ok: { badge: "", badgeOutline: "", dot: "bg-zinc-600", label: "", tab: "border-zinc-600 text-zinc-500" },
} as const;

function runwayColor(days: number) {
    if (days < 14) return "text-red-400 font-semibold";
    if (days < 45) return "text-yellow-400 font-semibold";
    if (days < 90) return "text-green-400";
    return "text-zinc-500";
}
function timeAgo(iso: string) {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// ── component ──────────────────────────────────────────────────────────────
export default function PurchasingPanel() {
    const [data, setData] = useState<AssessmentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [scanning, setScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [vendorTab, setVendorTab] = useState<string>("all");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [checked, setChecked] = useState<Record<string, Record<string, boolean>>>({});
    const [qtys, setQtys] = useState<Record<string, Record<string, number>>>({});
    const [creatingPO, setCreatingPO] = useState<Set<string>>(new Set());
    const [createdPOs, setCreatedPOs] = useState<Record<string, POResult>>({});

    // commit & send modal
    const [commitModal, setCommitModal] = useState<CommitReview | null>(null);
    const [commitLoading, setCommitLoading] = useState<string | null>(null); // orderId being reviewed
    const [sendingPO, setSendingPO] = useState(false);
    const [sentPOs, setSentPOs] = useState<Set<string>>(new Set()); // orderId → sent

    // snooze
    const [snooze, setSnooze] = useState<SnoozeMap>({});
    const [showSnoozed, setShowSnoozed] = useState(false);
    const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null);

    // ULINE direct ordering
    const [ulineOrdering, setUlineOrdering] = useState(false);
    const [ulineResult, setUlineResult] = useState<UlineOrderResult | null>(null);

    // collapse + resize
    const [isCollapsed, setIsCollapsed] = useState(false);
    useEffect(() => { if (localStorage.getItem("aria-dash-purchasing-collapsed") === "true") setIsCollapsed(true); }, []);
    useEffect(() => { localStorage.setItem("aria-dash-purchasing-collapsed", String(isCollapsed)); }, [isCollapsed]);

    const [bodyHeight, setBodyHeight] = useState(340);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-purchasing-h");
        if (s) setBodyHeight(Math.max(120, Math.min(700, parseInt(s))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-purchasing-h", String(bodyHeight)); }, [bodyHeight]);

    // Load snooze state from localStorage; purge expired entries on mount
    useEffect(() => {
        const raw = localStorage.getItem(SNOOZE_LS);
        if (!raw) return;
        try {
            const parsed: SnoozeMap = JSON.parse(raw);
            const now = Date.now();
            const cleaned: SnoozeMap = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (v.until === "forever" || (typeof v.until === "number" && v.until > now)) {
                    cleaned[k] = v;
                }
            }
            setSnooze(cleaned);
            localStorage.setItem(SNOOZE_LS, JSON.stringify(cleaned));
        } catch { }
    }, []);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(120, Math.min(700, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => { dragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [bodyHeight]);

    // ── snooze helpers ─────────────────────────────────────────────────────
    function isSnoozed(key: string): boolean {
        const e = snooze[key];
        if (!e) return false;
        return e.until === "forever" || (typeof e.until === "number" && Date.now() < e.until);
    }
    function doSnooze(key: string, days: number | "forever") {
        const entry: SnoozeEntry = days === "forever"
            ? { until: "forever" }
            : { until: Date.now() + (days as number) * 86400000 };
        const updated = { ...snooze, [key]: entry };
        setSnooze(updated);
        localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
        setSnoozeMenu(null);
    }
    function doUnsnooze(key: string) {
        const updated = { ...snooze };
        delete updated[key];
        setSnooze(updated);
        localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
        setSnoozeMenu(null);
    }
    function snoozeLabel(key: string): string {
        const e = snooze[key];
        if (!e) return "";
        if (e.until === "forever") return "always skip";
        const days = Math.ceil(((e.until as number) - Date.now()) / 86400000);
        return `snoozed ${days}d`;
    }
    // Vendor is effectively hidden if vendor-level snoozed OR every item is individually snoozed
    function vendorSnoozed(g: PurchasingGroup): boolean {
        return isSnoozed(`v:${g.vendorPartyId}`) || g.items.every(i => isSnoozed(i.productId));
    }
    // Inline dropdown — rendered as JSX, not a React component, to avoid closure issues
    function renderSnoozeMenu(k: string) {
        const snoozed = isSnoozed(k);
        return (
            <div className="absolute right-0 top-full mt-0.5 z-50 bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1 min-w-[110px]">
                {snoozed ? (
                    <button onClick={() => doUnsnooze(k)}
                        className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-emerald-400 hover:bg-zinc-800">
                        ↩ Unsnooze
                    </button>
                ) : (
                    <>
                        <div className="px-3 py-0.5 text-[9px] font-mono text-zinc-600 uppercase tracking-wider border-b border-zinc-800 mb-0.5">
                            Skip for
                        </div>
                        <button onClick={() => doSnooze(k, 30)}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                            30 days
                        </button>
                        <button onClick={() => doSnooze(k, 90)}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                            90 days
                        </button>
                        <button onClick={() => doSnooze(k, "forever")}
                            className="w-full text-left px-3 py-1 text-[10px] font-mono text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 border-t border-zinc-800 mt-0.5">
                            Always skip
                        </button>
                    </>
                )}
            </div>
        );
    }

    // ── data load ──────────────────────────────────────────────────────────
    async function load(bust = false) {
        bust ? setScanning(true) : setLoading(true);
        setError(null);
        try {
            const res = await fetch(bust ? "/api/dashboard/purchasing?bust=1" : "/api/dashboard/purchasing");
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || "Failed");
            setData(json);
            const ic: Record<string, Record<string, boolean>> = {};
            const iq: Record<string, Record<string, number>> = {};
            for (const g of json.groups as PurchasingGroup[]) {
                ic[g.vendorPartyId] = {};
                iq[g.vendorPartyId] = {};
                for (const item of g.items) {
                    ic[g.vendorPartyId][item.productId] = item.urgency === "critical" || item.urgency === "warning";
                    iq[g.vendorPartyId][item.productId] = item.suggestedQty;
                }
            }
            setChecked(ic);
            setQtys(iq);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
            setScanning(false);
        }
    }
    useEffect(() => { load(); }, []);

    function toggleExpand(id: string) {
        setExpanded(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    }
    function toggleItem(pid: string, itemId: string) {
        setChecked(p => ({ ...p, [pid]: { ...p[pid], [itemId]: !p[pid]?.[itemId] } }));
    }
    function setQty(pid: string, itemId: string, v: number) {
        setQtys(p => ({ ...p, [pid]: { ...p[pid], [itemId]: Math.max(1, v) } }));
    }
    function selectAll(group: PurchasingGroup, val: boolean) {
        setChecked(p => {
            const n = { ...p[group.vendorPartyId] };
            // only select/deselect non-snoozed items
            group.items.filter(i => !isSnoozed(i.productId)).forEach(i => { n[i.productId] = val; });
            return { ...p, [group.vendorPartyId]: n };
        });
    }

    async function createVendorPO(group: PurchasingGroup): Promise<POResult | null> {
        const pid = group.vendorPartyId;
        const items = group.items
            .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId])
            .map(i => ({ productId: i.productId, quantity: qtys[pid]?.[i.productId] ?? i.suggestedQty, unitPrice: i.unitPrice, orderIncrementQty: i.orderIncrementQty ?? null, isBulkDelivery: i.isBulkDelivery ?? false }));
        if (items.length === 0) return null;
        const res = await fetch("/api/dashboard/purchasing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vendorPartyId: pid, items, memo: "Purchasing Intelligence draft — review and commit in Finale" }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        return json as POResult;
    }

    async function handleCreateOne(group: PurchasingGroup) {
        const pid = group.vendorPartyId;
        setCreatingPO(p => new Set(p).add(pid));
        try {
            const result = await createVendorPO(group);
            if (result) setCreatedPOs(p => ({ ...p, [pid]: result }));
        } catch (e: any) {
            setError(`PO failed for ${group.vendorName}: ${e.message}`);
        } finally {
            setCreatingPO(p => { const n = new Set(p); n.delete(pid); return n; });
        }
    }

    async function handleCreateAll() {
        const groups = visibleGroups.filter(g =>
            !vendorSnoozed(g) &&
            !createdPOs[g.vendorPartyId] &&
            g.items.some(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId])
        );
        if (groups.length === 0) return;
        setCreatingPO(new Set(groups.map(g => g.vendorPartyId)));
        const results = await Promise.allSettled(groups.map(g => createVendorPO(g)));
        const updates: Record<string, POResult> = {};
        const errs: string[] = [];
        results.forEach((r, idx) => {
            if (r.status === "fulfilled" && r.value) updates[groups[idx].vendorPartyId] = r.value;
            else if (r.status === "rejected") errs.push(`${groups[idx].vendorName}: ${r.reason?.message ?? "failed"}`);
        });
        if (Object.keys(updates).length) setCreatedPOs(p => ({ ...p, ...updates }));
        if (errs.length) setError(errs.join(" | "));
        setCreatingPO(new Set());
    }

    async function handleReviewAndSend(orderId: string) {
        setCommitLoading(orderId);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'review', orderId }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Failed to fetch PO review'); return; }
            setCommitModal({ sendId: json.sendId, review: json.review, email: json.email, emailSource: json.emailSource });
        } catch (e: any) {
            setError(`Review failed: ${e.message}`);
        } finally {
            setCommitLoading(null);
        }
    }

    async function handleConfirmSend(skipEmail: boolean = false) {
        if (!commitModal?.sendId) return;
        setSendingPO(true);
        try {
            const res = await fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', sendId: commitModal.sendId, skipEmail }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Send failed'); return; }
            setSentPOs(p => new Set(p).add(commitModal.review.orderId));
            setCommitModal(null);
        } catch (e: any) {
            setError(`Send failed: ${e.message}`);
        } finally {
            setSendingPO(false);
        }
    }

    async function handleCancelCommit() {
        if (commitModal?.sendId) {
            fetch('/api/dashboard/purchasing/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'cancel', sendId: commitModal.sendId }),
            }).catch(() => { });
        }
        setCommitModal(null);
    }

    // ── ULINE direct ordering ──────────────────────────────────────────────
    function isUlineVendor(vendorName: string): boolean {
        return vendorName.toLowerCase().includes('uline');
    }

    async function handleOrderOnUline(group: PurchasingGroup) {
        const pid = group.vendorPartyId;
        const items = group.items
            .filter(i => !isSnoozed(i.productId) && checked[pid]?.[i.productId])
            .map(i => ({
                productId: i.productId,
                quantity: qtys[pid]?.[i.productId] ?? i.suggestedQty,
            }));

        if (items.length === 0) return;

        setUlineOrdering(true);
        setUlineResult(null);
        try {
            const res = await fetch('/api/dashboard/purchasing/uline-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });
            const result: UlineOrderResult = await res.json();
            setUlineResult(result);
        } catch (e: any) {
            setUlineResult({ success: false, itemsAdded: 0, message: e.message });
        } finally {
            setUlineOrdering(false);
        }
    }

    // ── derived state ──────────────────────────────────────────────────────
    const allGroups = data?.groups ?? [];
    const sortedGroups = [...allGroups].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
    const activeGroups = sortedGroups.filter(g => !vendorSnoozed(g));
    const displayGroups = showSnoozed ? sortedGroups : activeGroups;
    const visibleGroups = vendorTab === "all" ? displayGroups : displayGroups.filter(g => g.vendorPartyId === vendorTab);

    // Total hidden items across all snoozed vendors + individually snoozed items
    const hiddenItemCount = sortedGroups.reduce((n, g) => {
        if (isSnoozed(`v:${g.vendorPartyId}`)) return n + g.items.length;
        return n + g.items.filter(i => isSnoozed(i.productId)).length;
    }, 0);

    const critCount = activeGroups.filter(g => g.urgency === "critical").length;
    const warnCount = activeGroups.filter(g => g.urgency === "warning").length;
    const actionableVendors = activeGroups.filter(g =>
        !createdPOs[g.vendorPartyId] &&
        g.items.some(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId])
    );
    const isLoading = loading || scanning;
    const anyCreating = creatingPO.size > 0;

    // ── render ─────────────────────────────────────────────────────────────
    return (
        <div className="border-b border-zinc-800 shrink-0">
            {/* Commit & Send modal */}
            {commitModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
                        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                            <span className="text-sm font-mono font-semibold text-zinc-200">Commit & Send PO #{commitModal.review.orderId}</span>
                            <div className="flex-1" />
                            <span className="text-[10px] font-mono text-zinc-600">{commitModal.review.vendorName}</span>
                        </div>
                        <div className="px-4 py-3 space-y-1 max-h-60 overflow-y-auto">
                            {commitModal.review.items.map(item => (
                                <div key={item.productId} className="flex items-center gap-2 text-[11px] font-mono">
                                    <span className="text-zinc-500 w-36 truncate shrink-0">{item.productId}</span>
                                    <span className="text-zinc-400 flex-1 truncate">{item.productName}</span>
                                    <span className="text-zinc-500 shrink-0">×{item.quantity}</span>
                                    <span className="text-zinc-400 shrink-0">${item.unitPrice.toFixed(2)}</span>
                                    <span className="text-zinc-300 shrink-0 w-20 text-right">${item.lineTotal.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                        <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-between text-[11px] font-mono">
                            <span className="text-zinc-500">Total</span>
                            <span className="text-zinc-200 font-semibold">${commitModal.review.total.toFixed(2)}</span>
                        </div>
                        <div className="px-4 py-2 border-t border-zinc-800/60 text-[11px] font-mono">
                            {commitModal.email ? (
                                <span className="text-zinc-400">To: <span className="text-zinc-200">{commitModal.email}</span> <span className="text-zinc-600">({commitModal.emailSource})</span></span>
                            ) : (
                                <span className="text-amber-400">⚠ No vendor email on file. You can still commit the PO to Finale.</span>
                            )}
                        </div>
                        {commitModal.email && (
                            <div className="px-4 py-2 text-[10px] font-mono text-amber-500/80 border-t border-zinc-800/40 bg-amber-500/10">
                                ⚠ This will commit the PO in Finale AND email the vendor.
                            </div>
                        )}
                        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
                            <button onClick={handleCancelCommit}
                                className="text-[11px] font-mono px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={() => handleConfirmSend(true)}
                                disabled={sendingPO}
                                className="text-[11px] font-mono px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-40"
                            >
                                Commit Only
                            </button>
                            {commitModal.email && (
                                <button
                                    onClick={() => handleConfirmSend(false)}
                                    disabled={sendingPO}
                                    className="text-[11px] font-mono px-4 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-600 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                                >
                                    {sendingPO && <div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />}
                                    {sendingPO ? 'Sending…' : '✅ Commit & Email Vendor'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Backdrop — closes any open snooze dropdown */}
            {snoozeMenu && (
                <div className="fixed inset-0 z-40" onClick={() => setSnoozeMenu(null)} />
            )}

            {/* ── Header ── */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Ordering</span>
                {data && !scanning && <span className="text-[10px] text-[var(--dash-ts)] ml-auto mr-0 font-mono">{timeAgo(data.cachedAt)}</span>}
                {scanning && <span className="text-xs text-zinc-600 font-mono">scanning…</span>}
                <div className="flex-1" />

                {critCount > 0 && (
                    <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-red-500/20 text-red-300 border-red-500/40">
                        {critCount} CRIT
                    </span>
                )}
                {warnCount > 0 && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-yellow-500/20 text-yellow-300 border-yellow-500/40">
                        {warnCount} WARN
                    </span>
                )}

                {/* Snoozed badge — toggles reveal */}
                {hiddenItemCount > 0 && (
                    <button
                        onClick={() => setShowSnoozed(s => !s)}
                        className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${showSnoozed
                            ? "bg-zinc-700 text-zinc-300 border-zinc-600"
                            : "bg-transparent text-zinc-600 border-zinc-800 hover:text-zinc-400 hover:border-zinc-700"
                            }`}
                        title={showSnoozed ? "Hide snoozed" : "Show snoozed items"}
                    >
                        <Eye className="w-2.5 h-2.5" />
                        {hiddenItemCount} snoozed
                    </button>
                )}

                {!isLoading && activeGroups.length === 0 && hiddenItemCount === 0 && (
                    <span className="text-xs font-mono text-zinc-600">all clear</span>
                )}

                {actionableVendors.length > 1 && !anyCreating && (
                    <button onClick={handleCreateAll}
                        className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors"
                        title={`Create draft POs for all ${actionableVendors.length} selected vendors at once`}
                    >
                        <Zap className="w-2.5 h-2.5" />
                        {actionableVendors.length} POs
                    </button>
                )}
                {anyCreating && (
                    <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
                        <div className="w-2 h-2 border border-zinc-600 border-t-transparent rounded-full animate-spin" />
                        creating…
                    </span>
                )}
                <button onClick={() => load(true)} disabled={isLoading}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                    title="Re-scan Finale">
                    <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
                </button>
                <button onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors">
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {!isCollapsed && (
                <>
                    {/* ── Vendor tabs ── active vendors + snoozed (greyed) when showSnoozed */}
                    {displayGroups.length > 0 && (
                        <div className="flex items-center border-b border-zinc-800/60 bg-zinc-950/30 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            <button
                                onClick={() => setVendorTab("all")}
                                className={`px-3 py-1.5 text-[11px] font-mono whitespace-nowrap border-b-2 transition-colors shrink-0 ${vendorTab === "all"
                                    ? "border-zinc-400 text-zinc-300 bg-zinc-800/30"
                                    : "border-transparent text-zinc-600 hover:text-zinc-400"
                                    }`}
                            >
                                All <span className="opacity-60">{activeGroups.length}</span>
                            </button>

                            {displayGroups.map(g => {
                                const vSnoozed = vendorSnoozed(g);
                                const cfg = URGENCY[g.urgency];
                                const isActive = vendorTab === g.vendorPartyId;
                                const hasPO = !!createdPOs[g.vendorPartyId];
                                const checkedCount = g.items.filter(i => !isSnoozed(i.productId) && checked[g.vendorPartyId]?.[i.productId]).length;
                                return (
                                    <button key={g.vendorPartyId}
                                        onClick={() => setVendorTab(g.vendorPartyId)}
                                        className={`px-3 py-1.5 text-[11px] font-mono whitespace-nowrap border-b-2 transition-colors shrink-0 flex items-center gap-1 ${vSnoozed
                                            ? "border-transparent text-zinc-700 hover:text-zinc-500"
                                            : isActive
                                                ? `${cfg.tab} bg-zinc-800/30`
                                                : "border-transparent text-zinc-600 hover:text-zinc-400"
                                            }`}
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                        <span className={vSnoozed ? "line-through" : ""}>
                                            {g.vendorName.length > 14 ? g.vendorName.slice(0, 12) + "…" : g.vendorName}
                                        </span>
                                        {!vSnoozed && (hasPO
                                            ? <span className="text-emerald-500 ml-0.5">✓</span>
                                            : checkedCount > 0
                                                ? <span className="text-zinc-500 ml-0.5">{checkedCount}</span>
                                                : null
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {isLoading && !data && (
                        <div className="px-4 py-2 space-y-2.5">
                            {[1, 2, 3, 4].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-2 h-2 rounded-full skeleton-shimmer shrink-0" />
                                    <div className="skeleton-shimmer h-3.5" style={{ width: `${50 + i * 12}%` }} />
                                    <div className="skeleton-shimmer h-3 w-10 ml-auto" />
                                </div>
                            ))}
                        </div>
                    )}
                    {error && (
                        <div className="px-4 py-2 border-t border-zinc-800/60 text-xs font-mono text-rose-400/80">{error}</div>
                    )}

                    {data && visibleGroups.length > 0 && (
                        <>
                            <div
                                className="overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full"
                                style={{ height: bodyHeight }}
                            >
                                {visibleGroups.map(group => {
                                    const cfg = URGENCY[group.urgency];
                                    const pid = group.vendorPartyId;
                                    const vSnoozeKey = `v:${pid}`;
                                    const vSnoozed = vendorSnoozed(group);
                                    const isExpanded = !vSnoozed && (expanded.has(pid) || vendorTab === pid);
                                    const isCreatingThis = creatingPO.has(pid);
                                    const po = createdPOs[pid];
                                    const groupChecked = checked[pid] ?? {};
                                    const groupQtys = qtys[pid] ?? {};
                                    const activeItems = group.items.filter(i => !isSnoozed(i.productId));
                                    const selectedCount = activeItems.filter(i => groupChecked[i.productId]).length;
                                    const allCheckedFlag = activeItems.length > 0 && activeItems.every(i => groupChecked[i.productId]);
                                    const hasActionable = activeItems.some(i => i.urgency === "critical" || i.urgency === "warning");

                                    return (
                                        <div key={pid} className={`border-b border-zinc-800/40 ${vSnoozed ? "opacity-40" : ""}`}>
                                            {/* ── Vendor header ── */}
                                            <div className="flex items-center gap-2 px-4 py-2 hover:bg-zinc-800/20 transition-colors">
                                                <span className={`w-2 h-2 rounded-full shrink-0 ${vSnoozed ? "bg-zinc-700" : cfg.dot}`} />
                                                <button
                                                    onClick={() => !vSnoozed && toggleExpand(pid)}
                                                    className="flex-1 text-left flex items-center gap-2 min-w-0"
                                                >
                                                    <span className={`text-sm font-mono font-semibold truncate ${vSnoozed ? "line-through text-zinc-600" : "text-zinc-100"}`}>
                                                        {group.vendorName}
                                                    </span>
                                                    <span className="text-[11px] font-mono text-[var(--dash-l2)] shrink-0">
                                                        {vSnoozed
                                                            ? (isSnoozed(vSnoozeKey) ? snoozeLabel(vSnoozeKey) : "all skipped")
                                                            : `${activeItems.length} SKU${activeItems.length !== 1 ? "s" : ""}`}
                                                    </span>
                                                </button>

                                                {!vSnoozed && cfg.label && (
                                                    <span className={`text-[10px] font-mono shrink-0 ${group.urgency === "critical"
                                                            ? (po ? `px-1 py-0.5 rounded border ${cfg.badgeOutline}` : `px-1 py-0.5 rounded border ${cfg.badge}`)
                                                            : cfg.badge
                                                        }`}>
                                                        {cfg.label}
                                                    </span>
                                                )}

                                                {vSnoozed ? (
                                                    /* Restore entire snoozed vendor */
                                                    <button
                                                        onClick={() => {
                                                            const updated = { ...snooze };
                                                            delete updated[vSnoozeKey];
                                                            group.items.forEach(i => delete updated[i.productId]);
                                                            setSnooze(updated);
                                                            localStorage.setItem(SNOOZE_LS, JSON.stringify(updated));
                                                        }}
                                                        className="text-[10px] font-mono text-zinc-600 hover:text-emerald-400 shrink-0 transition-colors"
                                                    >
                                                        ↩ restore
                                                    </button>
                                                ) : (
                                                    <>
                                                        {po ? (
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <a href={po.finaleUrl} target="_blank" rel="noreferrer"
                                                                    className="flex items-center gap-1 text-[10px] font-mono text-emerald-400 hover:text-emerald-300">
                                                                    PO #{po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                                                </a>
                                                                {sentPOs.has(po.orderId) ? (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                ) : (
                                                                    <button
                                                                        onClick={() => handleReviewAndSend(po.orderId)}
                                                                        disabled={commitLoading === po.orderId}
                                                                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-600 transition-colors disabled:opacity-40"
                                                                        title="Commit in Finale and email vendor"
                                                                    >
                                                                        {commitLoading === po.orderId ? '…' : 'Commit & Send'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <button
                                                                    onClick={() => selectedCount > 0 ? handleCreateOne(group) : toggleExpand(pid)}
                                                                    disabled={anyCreating}
                                                                    className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors disabled:opacity-40 shrink-0 ${selectedCount > 0
                                                                        ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 border-zinc-700"
                                                                        : "bg-transparent text-zinc-600 border-zinc-800"
                                                                        }`}
                                                                >
                                                                    {isCreatingThis && <div className="w-2 h-2 border border-zinc-600 border-t-transparent rounded-full animate-spin" />}
                                                                    {selectedCount > 0 ? `Draft PO (${selectedCount})` : "Draft PO"}
                                                                </button>
                                                                {/* ULINE: Order Now button — fires items directly to ULINE cart */}
                                                                {isUlineVendor(group.vendorName) && selectedCount > 0 && (
                                                                    <button
                                                                        onClick={() => handleOrderOnUline(group)}
                                                                        disabled={ulineOrdering}
                                                                        className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-700/80 hover:bg-amber-600 text-amber-100 border-amber-600 transition-colors disabled:opacity-40 shrink-0"
                                                                        title="Add selected items to ULINE cart via Quick Order"
                                                                    >
                                                                        {ulineOrdering
                                                                            ? <div className="w-2 h-2 border border-amber-300 border-t-transparent rounded-full animate-spin" />
                                                                            : <ShoppingCart className="w-2.5 h-2.5" />}
                                                                        {ulineOrdering ? 'Ordering…' : 'Order on ULINE'}
                                                                    </button>
                                                                )}
                                                            </>
                                                        )}
                                                        {/* Vendor-level snooze menu */}
                                                        <div className="relative shrink-0">
                                                            <button
                                                                onClick={e => { e.stopPropagation(); setSnoozeMenu(snoozeMenu === vSnoozeKey ? null : vSnoozeKey); }}
                                                                className="px-1 py-0.5 text-[11px] font-mono text-zinc-700 hover:text-zinc-400 transition-colors"
                                                                title="Snooze this vendor"
                                                            >···</button>
                                                            {snoozeMenu === vSnoozeKey && renderSnoozeMenu(vSnoozeKey)}
                                                        </div>
                                                        <ChevronDown
                                                            onClick={() => toggleExpand(pid)}
                                                            className={`w-3.5 h-3.5 text-zinc-700 transition-transform shrink-0 cursor-pointer ${isExpanded ? "" : "-rotate-90"}`}
                                                        />
                                                    </>
                                                )}
                                            </div>

                                            {/* ── Item rows ── */}
                                            {isExpanded && (
                                                <div className="bg-zinc-950/40 border-t border-zinc-800/30">
                                                    {/* Select-all bar */}
                                                    <div className="flex items-center gap-2 px-4 py-1 border-b border-zinc-800/20">
                                                        <input type="checkbox" checked={allCheckedFlag}
                                                            onChange={e => selectAll(group, e.target.checked)}
                                                            className="w-3 h-3 rounded accent-zinc-400 shrink-0" />
                                                        <span className="text-[10px] font-mono text-zinc-600">
                                                            {allCheckedFlag ? "Deselect all" : "Select all"}
                                                        </span>
                                                        <div className="flex-1" />
                                                        {po ? (
                                                            <div className="flex items-center gap-2">
                                                                <a href={po.finaleUrl} target="_blank" rel="noreferrer"
                                                                    className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                                                                    ✓ PO #{po.orderId} <ExternalLink className="w-2.5 h-2.5" />
                                                                </a>
                                                                {sentPOs.has(po.orderId) ? (
                                                                    <span className="text-[10px] font-mono text-emerald-500">✓ sent</span>
                                                                ) : (
                                                                    <button
                                                                        onClick={() => handleReviewAndSend(po.orderId)}
                                                                        disabled={commitLoading === po.orderId}
                                                                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors disabled:opacity-40"
                                                                    >
                                                                        {commitLoading === po.orderId ? 'Loading…' : 'Commit & Send'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : selectedCount > 0 ? (
                                                            <div className="flex items-center gap-1.5">
                                                                <button onClick={() => handleCreateOne(group)} disabled={anyCreating}
                                                                    className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 border border-zinc-600 transition-colors disabled:opacity-40">
                                                                    {isCreatingThis ? "Creating…" : `→ Draft PO (${selectedCount} item${selectedCount !== 1 ? "s" : ""})`}
                                                                </button>
                                                                {isUlineVendor(group.vendorName) && (
                                                                    <button
                                                                        onClick={() => handleOrderOnUline(group)}
                                                                        disabled={ulineOrdering}
                                                                        className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-700/80 hover:bg-amber-600 text-amber-100 border border-amber-600 transition-colors disabled:opacity-40"
                                                                    >
                                                                        {ulineOrdering
                                                                            ? <div className="w-2 h-2 border border-amber-300 border-t-transparent rounded-full animate-spin" />
                                                                            : <ShoppingCart className="w-2.5 h-2.5" />}
                                                                        {ulineOrdering ? 'Ordering…' : 'Order on ULINE'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : null}
                                                    </div>

                                                    {[...group.items]
                                                        .sort((a, b) =>
                                                            URGENCY_RANK[a.urgency] !== URGENCY_RANK[b.urgency]
                                                                ? URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
                                                                : a.runwayDays - b.runwayDays
                                                        )
                                                        .filter(item => showSnoozed || !isSnoozed(item.productId))
                                                        .map(item => {
                                                            const itemSnoozed = isSnoozed(item.productId);
                                                            const isChecked = !itemSnoozed && (groupChecked[item.productId] ?? false);
                                                            const qty = groupQtys[item.productId] ?? item.suggestedQty;
                                                            const rc = runwayColor(item.runwayDays);
                                                            const isBundle = !itemSnoozed && item.urgency === "watch" && hasActionable;
                                                            const iKey = item.productId;

                                                            return (
                                                                <div key={iKey}
                                                                    className={`px-4 py-3 border-b border-zinc-800/20 last:border-0 ${itemSnoozed ? "opacity-35" : isChecked ? "" : "opacity-50"
                                                                        }`}>
                                                                    <div className="flex items-start gap-3">
                                                                        {!itemSnoozed && (
                                                                            <input type="checkbox" checked={isChecked}
                                                                                onChange={() => toggleItem(pid, iKey)}
                                                                                className={`mt-1 flex-shrink-0 w-3.5 h-3.5 rounded ${item.urgency === "critical" ? "accent-red-500"
                                                                                    : item.urgency === "warning" ? "accent-yellow-400"
                                                                                        : "accent-zinc-400"
                                                                                    }`} />
                                                                        )}
                                                                        {itemSnoozed && <div className="mt-1 w-3.5 h-3.5" />}

                                                                        <div className="flex-1 min-w-0">
                                                                            {/* Row 1: Dot · SKU · Badges · Runway · Snooze */}
                                                                            <div className="flex items-center gap-2">
                                                                                <span className={`w-2 h-2 rounded-full shrink-0 ${itemSnoozed ? "bg-zinc-700" : URGENCY[item.urgency].dot}`} />
                                                                                <span className={`text-sm font-mono font-bold truncate ${itemSnoozed ? "line-through text-zinc-600" : "text-zinc-100"}`}>
                                                                                    {item.productId}
                                                                                </span>

                                                                                {itemSnoozed && (
                                                                                    <span className="text-[9px] font-mono text-zinc-600 shrink-0">
                                                                                        {snoozeLabel(iKey)}
                                                                                    </span>
                                                                                )}
                                                                                {isBundle && (
                                                                                    <span className="text-[9px] font-mono text-blue-500/70 border border-blue-500/20 rounded px-1 shrink-0">
                                                                                        bundle?
                                                                                    </span>
                                                                                )}

                                                                                <div className="flex-1" />

                                                                                {!itemSnoozed && (
                                                                                    <span className={`text-[11px] font-mono shrink-0 ${rc}`}>
                                                                                        Out in {Math.round(item.runwayDays)}d
                                                                                        {item.stockOnOrder > 0 && (
                                                                                            <span className="text-zinc-600 font-normal text-[10px]">
                                                                                                {" "}→{Math.round(item.adjustedRunwayDays)}d
                                                                                            </span>
                                                                                        )}
                                                                                    </span>
                                                                                )}

                                                                                <div className="relative shrink-0 ml-1">
                                                                                    <button
                                                                                        onClick={e => { e.stopPropagation(); setSnoozeMenu(snoozeMenu === iKey ? null : iKey); }}
                                                                                        className={`text-[11px] font-mono transition-colors ${itemSnoozed
                                                                                            ? "text-zinc-600 hover:text-emerald-400"
                                                                                            : "text-zinc-700 hover:text-zinc-400"
                                                                                            }`}
                                                                                        title={itemSnoozed ? "Unsnooze" : "Snooze this item"}
                                                                                    >{itemSnoozed ? "↩" : "···"}</button>
                                                                                    {snoozeMenu === iKey && renderSnoozeMenu(iKey)}
                                                                                </div>
                                                                            </div>

                                                                            {/* Row 2: Description & Amount */}
                                                                            {!itemSnoozed && (
                                                                                <div className="flex items-center gap-2 mt-1">
                                                                                    <span className="text-[11px] font-mono text-[var(--dash-l2)] flex-1 truncate">{item.productName}</span>
                                                                                    {item.unitPrice > 0 ? (
                                                                                        <span className="text-[11px] font-mono text-emerald-400 font-semibold shrink-0">
                                                                                            ${item.unitPrice.toFixed(2)}/ea
                                                                                        </span>
                                                                                    ) : (
                                                                                        <span className="text-[11px] font-mono text-zinc-600 shrink-0">
                                                                                            $0.00
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                            )}

                                                                            {/* Row 3: Details & Qty */}
                                                                            {!itemSnoozed && (
                                                                                <div className="flex items-center justify-between gap-2 mt-2">
                                                                                    <div className="flex flex-col gap-1">
                                                                                        <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--dash-l3)]">
                                                                                            <span>{item.dailyRate.toFixed(1)}/day</span>
                                                                                            <span>·</span>
                                                                                            <span>{Math.round(item.stockOnHand)} on hand</span>
                                                                                        </div>
                                                                                        {(item.finaleReorderQty ?? 0) > 0 && (
                                                                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                                                                <Zap className="w-3 h-3 text-cyan-500" />
                                                                                                <span className="text-[10px] font-mono text-cyan-500/80 italic">
                                                                                                    Finale Reorder: {item.finaleReorderQty}
                                                                                                </span>
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className="flex items-center gap-2">
                                                                                        <label className="flex items-center gap-1.5 shrink-0">
                                                                                            <span className="text-[10px] font-mono text-zinc-500">qty</span>
                                                                                            <input
                                                                                                type="number" min={1} value={qty}
                                                                                                onChange={e => setQty(pid, iKey, parseInt(e.target.value) || 1)}
                                                                                                onClick={e => e.stopPropagation()}
                                                                                                className="w-16 px-1.5 py-0.5 text-[11px] font-mono bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded text-zinc-200 focus:outline-none focus:border-emerald-500 text-right transition-colors"
                                                                                            />
                                                                                        </label>
                                                                                        {item.unitPrice > 0 && (
                                                                                            <span className="text-[11px] font-mono text-zinc-300 font-semibold shrink-0 w-16 text-right">
                                                                                                = ${(qty * item.unitPrice).toFixed(0)}
                                                                                            </span>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                            )}

                                                                            {/* Row 4: Explanation */}
                                                                            {!itemSnoozed && (
                                                                                <div className="mt-1.5 text-[10px] font-mono text-zinc-600 italic">
                                                                                    {item.explanation}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>

                            {/* ULINE order result banner */}
                            {ulineResult && (
                                <div className={`px-4 py-2 text-[11px] font-mono flex items-center gap-2 border-t ${
                                    ulineResult.success
                                        ? 'bg-emerald-900/20 border-emerald-800/40 text-emerald-400'
                                        : 'bg-rose-900/20 border-rose-800/40 text-rose-400'
                                }`}>
                                    <span>{ulineResult.success ? '✅' : '⚠️'}</span>
                                    <span className="flex-1">{ulineResult.message}</span>
                                    <button
                                        onClick={() => setUlineResult(null)}
                                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                                    >✕</button>
                                </div>
                            )}

                            <div onMouseDown={startResize}
                                className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
                                title="Drag to resize" />
                        </>
                    )}

                    {/* Empty states */}
                    {!isLoading && activeGroups.length === 0 && hiddenItemCount === 0 && (
                        <div className="px-4 py-3 border-t border-zinc-800/60 text-xs font-mono text-zinc-600">
                            All purchased items have adequate runway.
                        </div>
                    )}
                    {!isLoading && activeGroups.length === 0 && hiddenItemCount > 0 && !showSnoozed && (
                        <div className="px-4 py-3 border-t border-zinc-800/60 text-xs font-mono text-zinc-600">
                            All active items covered.{" "}
                            <button onClick={() => setShowSnoozed(true)}
                                className="text-zinc-500 hover:text-zinc-300 underline transition-colors">
                                {hiddenItemCount} snoozed
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
