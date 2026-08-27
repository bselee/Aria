"use client";

/**
 * @file    ReceivedItemsPanel.tsx
 * @purpose One-column expandable Receivings panel (Bill 2026-08-11):
 *          - ONE actionable list, sorted action-first: review → ready → match.
 *            No split-panel InvoicePOMatcher, no "▶ Received POs" secondary toggle.
 *          - Complete PO gives visible feedback: green success toast, block toast
 *            on 3-way gate 409, red toast on error; button shows "Completing…".
 *          - Invoice PDF link + hover preview (iframe) on discrepancy rows only,
 *            gated to the Receivings PDF vendor allowlist (list B) + file on disk.
 *          - Expand bodies: review = variance items + money row + Finale link +
 *            Apply & Complete; ready = Complete on the row; match = candidates +
 *            manual PO input.
 * @author  Aria Dashboard
 * @created 2026-08-11
 * @deps    react, lucide-react, PurchasingLifecycleContext, receivings-pdf-vendors
 */

import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package, RefreshCw, ChevronDown } from "lucide-react";
import { usePurchasingLifecycle } from "@/components/dashboard/command-board/PurchasingLifecycleContext";
import { isReceivingsPdfVendor } from "@/config/receivings-pdf-vendors";

// ── Types ─────────────────────────────────────────────────────────────────

/** Matched invoice as forwarded by /api/dashboard/receivings GET. */
type MatchedInvoice = {
    id?: string;
    invoice_number: string;
    vendor_name?: string;
    subtotal: number;
    freight: number;
    tax: number;
    total: number;
    status: string;
    pdf_storage_path?: string | null;
    pdfAvailable?: boolean;
    source_ref?: string | null;
};

/** One classified difference between PO and invoice (mirrors receivings-enrichment). */
type VarianceItem = {
    kind: string;
    label: string;
    poAmount: number | null;
    invoiceAmount: number | null;
    delta: number;
    blocking: boolean;
    message: string;
};

/** Roll-up of all variance items (mirrors receivings-enrichment). */
type VarianceSummary = {
    netDelta: number;
    byKind: Record<string, number>;
    clean: boolean;
    hasBlocking: boolean;
    headline: string;
    items: VarianceItem[];
};

type ReceivedPO = {
    orderId: string;
    orderDate: string;
    receiveDate: string;
    receiveDateTime?: string;
    receivedBy?: string | null;
    receiptStatus?: "full" | "partial" | "received";
    supplier: string;
    total: number;
    subtotal?: number;
    items: Array<{
        productId: string;
        quantity: number;
        orderedQuantity?: number;
        receivedQuantity?: number;
        receivedInWindow?: number;
        openQuantity?: number;
    }>;
    receiptHistory?: Array<{
        shipmentId: string;
        receiveDate: string;
        receiveDateTime: string;
        receivedBy?: string | null;
        items: Array<{ productId: string; quantity: number }>;
    }>;
    finaleUrl: string;
    _reconciliation?: {
        invoices: Array<{ invoice_number: string; subtotal: number; freight: number; tax: number; total: number; status: string }>;
        outcomes: Array<{ outcome: string; created_at: string; resolved_at: string | null }>;
        hasPendingApproval: boolean;
        hasAutoApplied: boolean;
        matchedInvoice: MatchedInvoice | null;
        matchStatus?: "match" | "possible_match" | "no_match";
        threeWayMatch?: { canApprove?: boolean; summary?: string } | null;
        chargesComparison?: {
            po?: { subtotal?: number; freight?: number; tax?: number; tariffs?: number; total?: number };
            invoice?: { subtotal?: number; freight?: number; tax?: number; tariffs?: number; total?: number };
            diffs?: Record<string, number>;
        } | null;
        variance?: VarianceSummary | null;
    };
};

type MatchCandidate = {
    orderId: string;
    vendorName: string;
    orderDate: string;
    total: number;
    status: string;
    score: number;
    reasons: string[];
    isOpen: boolean;
    /** PO line items from the local purchase_orders cache (educated match). */
    items?: Array<{ productId?: string; sku?: string; quantity?: number | string; unitPrice?: number | string; description?: string }>;
};

type MatchSuggestion = {
    invoiceId: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceTotal: number;
    invoiceDate?: string;
    pdfStoragePath?: string | null;
    pdfAvailable?: boolean;
    candidates: MatchCandidate[];
    autoApplyReady: boolean;
    fromCache?: boolean;
    timedOut?: boolean;
    /** OCR line items from the invoice (SKU × qty) — the other half of the educated match. */
    invoiceLineItems?: Array<{ sku?: string; qty?: number | string; description?: string }> | null;
};

/**
 * One row = one decision in the Receivings column.
 * review: variance to resolve (Apply & Complete after expand).
 * ready:  clean 3-way match — Complete right on the row.
 * match:  unmatched invoice with PO candidates (or manual input).
 */
type ActionRow =
    | { kind: "review"; key: string; po: ReceivedPO; inv: MatchedInvoice; variance: VarianceSummary | null }
    | { kind: "ready"; key: string; po: ReceivedPO; inv: MatchedInvoice }
    | { kind: "match"; key: string; suggestion: MatchSuggestion };

type TrackingTodaySummary = {
    headline: string;
    lines: string[];
} | null;

/** Complete-feedback toast. */
type ActionToast = { kind: "ok" | "err" | "block"; text: string } | null;

// ── Helpers ───────────────────────────────────────────────────────────────

function parseDenverDate(s: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(s: string): string {
    const d = parseDenverDate(s);
    if (!d) return s || '—';
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'America/Denver' };
    const isDateOnly = !s.includes(':');
    const datePart = d.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' });
    if (isDateOnly) return datePart;
    const timePart = d.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
}

function fmtDollars(n: number): string {
    if (!n || n <= 1) return '';   // skip $0 and $1 placeholder totals
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtQty(n: number | null | undefined): string {
    return Number(n || 0).toLocaleString();
}

function getDynamicReceiptStatus(po: ReceivedPO): "full" | "partial" | "received" {
    if (!po.items || po.items.length === 0) {
        return po.receiptStatus || "received";
    }
    const hasDetails = po.items.some(i => i.receivedQuantity !== undefined);
    if (!hasDetails) {
        return po.receiptStatus || "received";
    }
    const isFull = po.items.every(i => {
        const ordered = i.orderedQuantity ?? i.quantity;
        const received = i.receivedQuantity ?? 0;
        return received >= ordered;
    });
    return isFull ? "full" : "partial";
}

function receiptBadge(po: ReceivedPO): { label: string; cls: string } | null {
    const status = getDynamicReceiptStatus(po);
    if (status === "full") {
        return { label: "FULL", cls: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" };
    }
    if (status === "partial") {
        return { label: "PARTIAL", cls: "text-amber-300 border-amber-500/30 bg-amber-500/10" };
    }
    return null;
}

function receiveSortValue(po: ReceivedPO): number {
    const parsed = parseDenverDate(po.receiveDate || po.receiveDateTime);
    return parsed?.getTime() ?? 0;
}

function partialDiscrepancy(po: ReceivedPO): string | null {
    const status = getDynamicReceiptStatus(po);
    if (status !== "partial" || po.items.length === 0) return null;

    const shortItems = po.items
        .filter(item => item.openQuantity == null || item.openQuantity > 0);

    if (shortItems.length === 0) return "partial receipt";

    const details = shortItems.slice(0, 2).map(item => {
        const ordered = item.orderedQuantity ?? item.quantity;
        const open = item.openQuantity;
        if (open !== undefined && open > 0) {
            return `${item.productId} short ${fmtQty(open)} of ${fmtQty(ordered)}`;
        }
        return `${item.productId} ×${fmtQty(ordered)}`;
    });

    let result = details.join(", ");
    if (shortItems.length > 2) result += ` +${shortItems.length - 2} more`;
    return result;
}

/** Per-kind visual language — which variance bucket moved, at a glance.
 *  `hint` is a short resolution guidance shown on the expanded variance row. */
const KIND_UI: Record<string, { label: string; cls: string; hint: string }> = {
    freight:       { label: "Freight",      cls: "text-sky-300 border-sky-500/30 bg-sky-500/10",    hint: "PO has no freight charge — add freight to PO or remove from invoice" },
    tax:           { label: "Tax",          cls: "text-violet-300 border-violet-500/30 bg-violet-500/10", hint: "Tax on invoice differs from PO — verify tax status with vendor" },
    tariff:        { label: "Tariff",       cls: "text-violet-300 border-violet-500/30 bg-violet-500/10", hint: "Tariff charge on invoice not on PO — add to PO or dispute with vendor" },
    fee:           { label: "Fees",         cls: "text-orange-300 border-orange-500/30 bg-orange-500/10", hint: "Fee on invoice not on PO — verify fee type (handling, fuel surcharge, etc.)" },
    product_price: { label: "Price",        cls: "text-amber-300 border-amber-500/30 bg-amber-500/10", hint: "Unit price differs — check for recent price increase or promo discount" },
    product_qty:   { label: "Qty",          cls: "text-amber-300 border-amber-500/30 bg-amber-500/10", hint: "Quantity mismatch — verify received qty against PO and invoice" },
    sku_unknown:   { label: "Unknown SKU",  cls: "text-rose-300 border-rose-500/30 bg-rose-500/10",   hint: "Invoice SKU not on PO — verify correct PO or check for substitute item" },
    sku_missing:   { label: "Not invoiced", cls: "text-zinc-400 border-zinc-600/30 bg-zinc-700/10",   hint: "PO line item not on invoice — may ship separately or be backordered" },
    unexplained:   { label: "Unexplained",  cls: "text-zinc-300 border-zinc-500/30 bg-zinc-600/10",   hint: "Compare PO line items to invoice — check for freight allocation or SKU mismatch" },
};

const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

/** Days since a date string (receiveDate or orderDate). Returns null if unparseable. */
function daysSince(dateStr: string | undefined): number | null {
    if (!dateStr) return null;
    const d = parseDenverDate(dateStr);
    if (!d) return null;
    return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/** Aging badge: "3d" / "2w" / "1mo" with color coding. */
function agingBadge(days: number | null): { text: string; cls: string } | null {
    if (days == null || days < 1) return null;
    if (days < 7) return { text: `${days}d`, cls: "text-zinc-500" };
    if (days < 14) return { text: days < 10 ? `${days}d` : `${Math.round(days / 7)}w`, cls: "text-amber-400" };
    const weeks = Math.round(days / 7);
    return { text: weeks < 8 ? `${weeks}w` : `${Math.round(days / 30)}mo`, cls: "text-rose-400" };
}

/** Safe error-message extraction for catch blocks. */
function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * PDF route URL for a matched invoice — ONLY when the invoice is on an
 * allowlisted vendor (list B) AND a file is on disk. Returns null otherwise
 * so no dead link is ever rendered.
 */
function invoicePdfUrl(inv: MatchedInvoice): string | null {
    if (!inv?.id) return null;
    const allowed = inv.pdfAvailable || !!(inv.pdf_storage_path && isReceivingsPdfVendor(inv.vendor_name));
    if (!allowed) return null;
    return `/api/storage/invoice-pdf?id=${encodeURIComponent(inv.id)}`;
}

/** Same gate for match suggestions (id + allowlist + path). */
function suggestionPdfUrl(s: MatchSuggestion): string | null {
    if (!s?.invoiceId) return null;
    const allowed = s.pdfAvailable || !!(s.pdfStoragePath && isReceivingsPdfVendor(s.vendorName));
    if (!allowed) return null;
    return `/api/storage/invoice-pdf?id=${encodeURIComponent(s.invoiceId)}`;
}

/**
 * PDF link control. Click opens the full PDF in a new tab. When `withHover`
 * is set (discrepancy rows only), hovering mounts a lightweight iframe preview
 * — the iframe is ONLY rendered while hovered so N rows never open N PDFs.
 */
function InvoicePdfLink({ id, number, withHover = false, hovered = false, onHoverChange }: {
    id: string;
    number?: string;
    withHover?: boolean;
    hovered?: boolean;
    onHoverChange?: (id: string | null) => void;
}) {
    const href = `/api/storage/invoice-pdf?id=${encodeURIComponent(id)}`;
    const link = (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            title={`Invoice ${number ?? ""} PDF (opens in new tab)`}
            className="text-[10px] font-mono text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-500/30 shrink-0"
        >
            PDF
        </a>
    );
    if (!withHover) return link;
    return (
        <span
            className="relative inline-flex shrink-0"
            onMouseEnter={() => onHoverChange?.(id)}
            onMouseLeave={() => onHoverChange?.(null)}
        >
            {link}
            {hovered && (
                <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 rounded border border-zinc-700 shadow-xl bg-zinc-950 overflow-hidden">
                    <iframe
                        src={`${href}#page=1`}
                        className="w-[280px] h-[360px] border-0"
                        title={`Invoice ${number ?? ""} PDF preview`}
                    />
                </span>
            )}
        </span>
    );
}

const ACTION_ORDER: Record<ActionRow["kind"], number> = { review: 0, match: 1, ready: 2 };

/**
 * Build the ONE actionable list from the payload, sorted workflow-first:
 * 1. review — variance blocking first, then by |net delta| desc (biggest $ first)
 * 2. match — unmatched invoices that need a PO linked
 * 3. ready — clean match (twm.canApprove / variance.clean), newest receipt first
 * POs with no matched invoice are excluded — they land in the settled dump.
 */
function buildActionRows(pos: ReceivedPO[], suggestions: MatchSuggestion[]): ActionRow[] {
    const rows: ActionRow[] = [];
    for (const po of pos) {
        const rec = po._reconciliation;
        const inv = rec?.matchedInvoice ?? null;
        if (!inv) continue; // no invoice → no in-panel decision (settled dump)
        const variance = rec?.variance ?? null;
        const twm = rec?.threeWayMatch;
        const clean = !!variance && variance.clean;
        if (clean || twm?.canApprove) {
            rows.push({ kind: "ready", key: `ready-${po.orderId}`, po, inv });
        } else {
            rows.push({ kind: "review", key: `review-${po.orderId}`, po, inv, variance });
        }
    }
    for (const s of suggestions) {
        rows.push({ kind: "match", key: `match-${s.invoiceId}`, suggestion: s });
    }
    rows.sort((a, b) => {
        const ao = ACTION_ORDER[a.kind];
        const bo = ACTION_ORDER[b.kind];
        if (ao !== bo) return ao - bo;
        if (a.kind === "review" && b.kind === "review") {
            const abl = a.variance?.hasBlocking ?? false;
            const bbl = b.variance?.hasBlocking ?? false;
            if (abl !== bbl) return abl ? -1 : 1;
            return Math.abs(b.variance?.netDelta ?? 0) - Math.abs(a.variance?.netDelta ?? 0);
        }
        if (a.kind === "match" && b.kind === "match") {
            return (b.suggestion.candidates[0]?.score ?? 0) - (a.suggestion.candidates[0]?.score ?? 0);
        }
        if (a.kind === "ready" && b.kind === "ready") {
            return receiveSortValue(b.po) - receiveSortValue(a.po);
        }
        return 0;
    });
    return rows;
}

/** Received POs without invoices — awaiting invoice from vendor. */
function buildAwaitingInvoice(pos: ReceivedPO[]): ReceivedPO[] {
    return pos.filter(po => {
        const inv = po._reconciliation?.matchedInvoice;
        return !inv;
    }).sort((a, b) => receiveSortValue(b) - receiveSortValue(a));
}

// ── Component ─────────────────────────────────────────────────────────────

export type ReceivedItemsPanelProps = {
    /** Lifecycle column mode: fill height, no card collapse/resize. */
    embedded?: boolean;
};

export default function ReceivedItemsPanel({ embedded = false }: ReceivedItemsPanelProps = {}) {
    const lifecycle = usePurchasingLifecycle();
    const [pos, setPos] = useState<ReceivedPO[]>([]);
    const [matchSuggestions, setMatchSuggestions] = useState<MatchSuggestion[]>([]);
    /** True unmatched backlog (30d, PO-matchable) — NOT the scored slice. */
    const [unmatchedTotal, setUnmatchedTotal] = useState(0);
    const [unmatchedDollars, setUnmatchedDollars] = useState(0);
    const [todaySummary, setTodaySummary] = useState<TrackingTodaySummary>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Complete feedback toast — sticky at top of the panel body. */
    const [actionToast, setActionToast] = useState<ActionToast>(null);
    /** PO currently completing — button shows "Completing…" while in flight. */
    const [completingId, setCompletingId] = useState<string | null>(null);
    /** PO currently unmatching — the Unmatch button shows "Unmatching…" while in flight. */
    const [unmatchingId, setUnmatchingId] = useState<string | null>(null);
    /** Which ActionRow is expanded (single-expand accordion). */
    const [expandedRow, setExpandedRow] = useState<string | null>(null);
    /** Invoice id being hovered for the PDF preview iframe (null = none mounted). */
    const [hoverPdfId, setHoverPdfId] = useState<string | null>(null);
    /** 3-way gate refusal per PO — set when complete_po returns 409. */
    const [gateBlockReason, setGateBlockReason] = useState<Map<string, string>>(new Map());
    /** Manual match state: invoiceId → manual PO input. */
    const [manuallyMatching, setManuallyMatching] = useState<Map<string, { poNumber: string; loading: boolean }>>(new Map());
    /** Settled dump toggle — not the default path. */
    const [showAllReceived, setShowAllReceived] = useState(false);
    /** Awaiting invoice section toggle — collapsed by default. */
    const [showAwaitingInvoice, setShowAwaitingInvoice] = useState(false);
    /** Active filter tab — "action" (all) is default; others narrow the list. */
    const [filterTab, setFilterTab] = useState<"action" | "ready" | "review" | "match" | "settled">("action");
    /**
     * POs completed this session. Finale still lists completed POs in the
     * 30-day received window, so a plain refetch would resurrect them —
     * defeating the "row disappears" feedback. These stay hidden for the
     * session even after refetch (backend exclusion is a separate task).
     */
    const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
    /** Match suggestions resolved this session — same refetch-resurrection guard. */
    const [matchedInvoiceIds, setMatchedInvoiceIds] = useState<Set<string>>(new Set());
    const [recentAutoCompletions, setRecentAutoCompletions] = useState<Array<{
        intent: string; poNumber?: string; invoiceNumber?: string; vendorName?: string; createdAt: string;
    }>>([]);

    /** Tracks known receipt orderIds so new arrivals can bust Ordering cache. */
    const knownReceiptIdsRef = useRef<Set<string>>(new Set());
    /** Keep last-painted rows so silent refresh never blanks the panel. */
    const posRef = useRef<ReceivedPO[]>([]);
    posRef.current = pos;
    /**
     * HERMIA(2026-07-28): lifecycle context value changes on every hover/focus
     * event (focus is in the useMemo deps). If fetchReceivings closes over
     * `lifecycle`, its identity churns → the mount effect re-fires →
     * setLoading(true) → skeleton blank. Hold notifyReceipt in a ref instead.
     */
    const notifyReceiptRef = useRef(lifecycle.notifyReceipt);
    notifyReceiptRef.current = lifecycle.notifyReceipt;

    // Resizable height — persisted
    const containerRef = useRef<HTMLDivElement>(null);
    const [bodyHeight, setBodyHeight] = useState(220);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-recv-h");
        if (s) setBodyHeight(Math.max(80, Math.min(600, parseInt(s))));
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-recv-h", String(bodyHeight)); }, [bodyHeight]);

    // Collapse state — persisted to localStorage
    const [isCollapsed, setIsCollapsed] = useState(false);
    const effectivelyCollapsed = embedded ? false : isCollapsed;
    useEffect(() => {
        const s = localStorage.getItem("aria-dash-recv-collapsed");
        if (s === "true") setIsCollapsed(true);
    }, []);
    useEffect(() => { localStorage.setItem("aria-dash-recv-collapsed", String(isCollapsed)); }, [isCollapsed]);

    // ── Delivered awaiting receipt bridge ──────────────────────────────────
    // Shows POs delivered by carrier but not yet received in Finale.
    // Bridges Active Purchases → Receivings so the user sees the handoff.
    const [deliveredAwaiting, setDeliveredAwaiting] = useState<Array<{
        orderId: string;
        vendorName: string;
        deliveredAt: string | null;
        hoursSinceDelivered: number | null;
        trackingNumber: string | null;
        trackingUrl: string | null;
    }>>([]);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/dashboard/active-purchases");
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                const delivered = (data.purchases || [])
                    .filter((po: any) => {
                        const m = po.movement;
                        return m && (m.status === "delivered" || m.receiptLag === "escalate" || m.receiptLag === "flag") && !po.isReceived;
                    })
                    .map((po: any) => ({
                        orderId: po.orderId,
                        vendorName: po.vendorName,
                        deliveredAt: po.movement?.deliveredAt || null,
                        hoursSinceDelivered: po.movement?.hoursSinceDelivered || null,
                        trackingNumber: po.movement?.trackingNumbers?.[0] || null,
                        trackingUrl: po.movement?.primaryUrl || null,
                    }));
                setDeliveredAwaiting(delivered);
            } catch { /* best-effort */ }
        })();
        return () => { cancelled = true; };
    }, []);

    const startResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startY: e.clientY, startH: bodyHeight };
        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setBodyHeight(Math.max(80, Math.min(600, dragRef.current.startH + ev.clientY - dragRef.current.startY)));
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [bodyHeight]);

    /** Auto-clear the complete toast after 5s. */
    useEffect(() => {
        if (!actionToast) return;
        const t = setTimeout(() => setActionToast(null), 5000);
        return () => clearTimeout(t);
    }, [actionToast]);

    const fetchReceivings = useCallback(async (silent = false) => {
        // HERMIA(2026-07-28): Never blank painted rows. Skeleton only on first paint
        // (no rows yet). Background / interval / post-action reloads use the spinner
        // flag only — previous POs stay visible until the new payload lands.
        const hasRows = posRef.current.length > 0;
        if (silent || hasRows) setRefreshing(true);
        else setLoading(true);
        setError(null);
        try {
            // HERMIA(2026-08-06): Abort after 18s so the panel cannot spin forever.
            const ctrl = new AbortController();
            const kill = setTimeout(() => ctrl.abort(), 18_000);
            let receivingsRes: Response;
            let trackingRes: Response | null = null;
            try {
                [receivingsRes, trackingRes] = await Promise.all([
                    fetch('/api/dashboard/receivings', { signal: ctrl.signal }),
                    fetch('/api/dashboard/tracking', { signal: ctrl.signal }).catch(() => null),
                ]);
            } finally {
                clearTimeout(kill);
            }

            if (!receivingsRes.ok) throw new Error(`HTTP ${receivingsRes.status}`);
            const data = await receivingsRes.json();
            if (data.error && !(data.received?.length)) throw new Error(data.error);
            const sorted = [...(data.received || [])].sort((a, b) => receiveSortValue(b) - receiveSortValue(a));

            // Notify Ordering when new receipt IDs appear so purchasing cache busts.
            const nextIds = sorted.map((p: ReceivedPO) => String(p.orderId)).filter(Boolean);
            const prev = knownReceiptIdsRef.current;
            if (prev.size > 0) {
                const fresh = nextIds.filter((id: string) => !prev.has(id));
                if (fresh.length > 0) {
                    notifyReceiptRef.current(fresh);
                }
            }
            knownReceiptIdsRef.current = new Set(nextIds);
            setPos(sorted);
            setMatchSuggestions(data.matchSuggestions || []);
            setRecentAutoCompletions(data.recentAutoCompletions || []);
            // True unmatched backlog (30d, PO-matchable, after no-PO/junk filter).
            // Bill (2026-08-27): the panel must show the real count, not the
            // paint-budget-scored slice — so the header can say "37 unmatched".
            setUnmatchedTotal(Number(data.unmatchedTotal ?? 0));
            setUnmatchedDollars(Number(data.unmatchedDollars ?? 0));

            if (trackingRes && trackingRes.ok) {
                const trackingData = await trackingRes.json();
                setTodaySummary(trackingData.todaySummary || null);
            } else if (!hasRows) {
                setTodaySummary(null);
            }
        } catch (e: unknown) {
            // Keep painted rows on timeout/abort — only surface error when empty
            if (!posRef.current.length) {
                const aborted = e instanceof Error && e.name === 'AbortError';
                const msg = aborted ? 'Receivings timed out — retry' : errMsg(e);
                setError(msg);
            }
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchReceivings();
        const t = setInterval(() => fetchReceivings(true), 30 * 60 * 1000);
        return () => clearInterval(t);
    }, [fetchReceivings]);

    /** Match an invoice to a PO from a suggestion (row-level Match button). */
    async function handleMatchInvoice(invoiceId: string, poNumber: string) {
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "match_invoice", invoiceId, poNumber }),
            });
            if (res.ok) {
                setMatchSuggestions(prev => prev.filter(s => s.invoiceId !== invoiceId));
                setMatchedInvoiceIds(prev => new Set(prev).add(invoiceId));
                fetchReceivings(true);
            } else {
                const err = await res.text();
                setActionToast({ kind: "err", text: `Match failed: ${err.slice(0, 160)}` });
            }
        } catch (e: unknown) {
            setActionToast({ kind: "err", text: `Match failed: ${errMsg(e)}` });
        }
    }

    /** Manual PO input change for a match suggestion. */
    function handleManualInputChange(invoiceId: string, value: string) {
        setManuallyMatching(prev => {
            const next = new Map(prev);
            const existing = next.get(invoiceId);
            next.set(invoiceId, { poNumber: value, loading: existing?.loading ?? false });
            return next;
        });
    }

    /** Manual match: bind an invoice to a PO typed by the operator. */
    async function handleManualMatch(invoiceId: string) {
        const state = manuallyMatching.get(invoiceId);
        if (!state || !state.poNumber.trim()) return;
        setManuallyMatching(prev => {
            const next = new Map(prev);
            next.set(invoiceId, { ...state, loading: true });
            return next;
        });
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "match_invoice", invoiceId, poNumber: state.poNumber.trim() }),
            });
            if (res.ok) {
                setManuallyMatching(prev => { const next = new Map(prev); next.delete(invoiceId); return next; });
                setMatchSuggestions(prev => prev.filter(s => s.invoiceId !== invoiceId));
                setMatchedInvoiceIds(prev => new Set(prev).add(invoiceId));
                setActionToast({ kind: "ok", text: `Invoice matched to PO ${state.poNumber.trim()}` });
                fetchReceivings(true);
            } else {
                const err = await res.text();
                setActionToast({ kind: "err", text: `Match failed: ${err.slice(0, 160)}` });
                setManuallyMatching(prev => {
                    const next = new Map(prev);
                    next.set(invoiceId, { ...manuallyMatching.get(invoiceId)!, loading: false });
                    return next;
                });
            }
        } catch (e: unknown) {
            setActionToast({ kind: "err", text: `Match failed: ${errMsg(e)}` });
            setManuallyMatching(prev => {
                const next = new Map(prev);
                next.set(invoiceId, { ...manuallyMatching.get(invoiceId)!, loading: false });
                return next;
            });
        }
    }

    /**
     * Complete a PO through the gate-checked API. Every outcome is visible:
     * success → green toast + optimistic remove + refresh,
     * 409 gate → block toast with the gate's detail (persistent row banner too),
     * other error → red toast. Button shows "Completing…" while in flight.
     */
    async function handleCompletePO(orderId: string, vendorName: string) {
        setCompletingId(orderId);
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "complete_po", orderId, vendorName }),
            });
            const json = await res.json();
            if (res.ok) {
                // Clear any previous gate refusal for this PO
                setGateBlockReason(prev => { const next = new Map(prev); next.delete(orderId); return next; });
                // Optimistic remove — the PO left the actionable list. Also record
                // it so the follow-up refetch cannot resurrect it (Finale still
                // lists completed POs inside the 30-day received window).
                setPos(prev => prev.filter(p => p.orderId !== orderId));
                setCompletedIds(prev => new Set(prev).add(orderId));
                setActionToast({ kind: "ok", text: `PO ${orderId} completed in Finale` });
                fetchReceivings(true);
            } else if (res.status === 409 && json.detail) {
                // Gate refused — block toast with the 3-way match summary
                setGateBlockReason(prev => { const next = new Map(prev); next.set(orderId, String(json.detail)); return next; });
                setActionToast({ kind: "block", text: String(json.detail) });
            } else {
                throw new Error(json.error || `HTTP ${res.status}`);
            }
        } catch (e: unknown) {
            setActionToast({ kind: "err", text: errMsg(e) || "Complete failed" });
        } finally {
            setCompletingId(null);
        }
    }

    async function handleUnmatchInvoice(invoiceId: string, poNumber: string) {
        setUnmatchingId(poNumber);
        try {
            const res = await fetch("/api/dashboard/receivings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "unmatch_invoice", invoiceId }),
            });
            const json = await res.json();
            if (res.ok) {
                setActionToast({ kind: "ok", text: `Invoice unlinked from PO ${poNumber} — back in the Match list` });
                fetchReceivings(true);
            } else if (res.status === 409 && json.error) {
                setActionToast({ kind: "block", text: json.error });
            } else {
                throw new Error(json.error || `HTTP ${res.status}`);
            }
        } catch (e: unknown) {
            setActionToast({ kind: "err", text: errMsg(e) || "Unmatch failed" });
        } finally {
            setUnmatchingId(null);
        }
    }

    // ── Derived: the ONE actionable list + counts ──────────────────────────
    const filteredSuggestions = useMemo(
        () => matchSuggestions.filter(s =>
            s.candidates.every(c => !/DropshipPO/i.test(String(c.orderId || "")))
        ),
        [matchSuggestions],
    );
    /** Rows hidden by actions taken this session (completed POs / matched invoices). */
    const visiblePos = useMemo(
        () => pos.filter(p => !completedIds.has(p.orderId)),
        [pos, completedIds],
    );
    const visibleSuggestions = useMemo(
        () => filteredSuggestions.filter(s => !matchedInvoiceIds.has(s.invoiceId)),
        [filteredSuggestions, matchedInvoiceIds],
    );
    const actionRows = useMemo(() => buildActionRows(visiblePos, visibleSuggestions), [visiblePos, visibleSuggestions]);
    const reviewCount = actionRows.filter(r => r.kind === "review").length;
    const readyCount = actionRows.filter(r => r.kind === "ready").length;
    const matchCount = visibleSuggestions.length;
    const actionPoIds = useMemo(
        () => new Set(actionRows.filter(r => r.kind !== "match").map(r => r.po.orderId)),
        [actionRows],
    );
    const settledPos = visiblePos.filter(p => !actionPoIds.has(p.orderId));

    /** Rows visible under the active filter tab. */
    const visibleActionRows = useMemo(() => {
        if (filterTab === "action") return actionRows;
        if (filterTab === "settled") return actionRows; // settled handled separately below
        return actionRows.filter(r => r.kind === filterTab);
    }, [actionRows, filterTab]);
    /** Oldest age among action rows — drives the one-line context strip. */
    const oldestActionDays = useMemo(() => {
        let max = 0;
        for (const r of actionRows) {
            const days = r.kind === "match"
                ? daysSince(r.suggestion.invoiceDate)
                : daysSince(r.po.receiveDate || r.po.receiveDateTime);
            if (days != null && days > max) max = days;
        }
        return max;
    }, [actionRows]);

    // ── Row renderers (inside component for state access) ──────────────────

    const toggleExpand = (key: string) => setExpandedRow(prev => (prev === key ? null : key));

    /** Review row — collapsed: BLOCKED/REVIEW label + aging + kind chips + PDF + Review button; expanded: variance body. */
    function renderReviewRow(row: Extract<ActionRow, { kind: "review" }>) {
        const expanded = expandedRow === row.key;
        const variance = row.variance;
        const hasBlocking = variance?.hasBlocking ?? false;
        const pdfUrl = invoicePdfUrl(row.inv);
        const poProductIds = row.po.items.map(item => item.productId);
        const cc = row.po._reconciliation?.chargesComparison;
        const items = variance?.items || [];
        const gateReason = gateBlockReason.get(row.po.orderId);
        const completing = completingId === row.po.orderId;
        const age = agingBadge(daysSince(row.po.receiveDate || row.po.receiveDateTime));

        return (
            <div key={row.key} className={`border-b border-zinc-800/40 ${hasBlocking ? "bg-rose-500/[0.03]" : "bg-amber-500/[0.02]"}`}>
                {/* Collapsed header — click to expand */}
                <div
                    role="button"
                    tabIndex={0}
                    onClick={e => {
                        const t = e.target as HTMLElement;
                        if (t.closest("a") || t.closest("button") || t.closest("input")) return;
                        toggleExpand(row.key);
                        lifecycle.setLockedFocus({ source: "rcv", vendorName: row.po.supplier, orderId: row.po.orderId, productIds: poProductIds });
                    }}
                    onKeyDown={e => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleExpand(row.key);
                        }
                    }}
                    className="w-full px-4 py-2.5 text-left cursor-pointer hover:bg-zinc-800/20 transition-colors"
                >
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-zinc-500 shrink-0">{expanded ? "▾" : "▸"}</span>
                        <span className={`text-[11px] font-mono font-semibold shrink-0 ${hasBlocking ? "text-rose-400" : "text-amber-400"}`}>{hasBlocking ? "BLOCKED" : "REVIEW"}</span>
                        <span className="text-[11px] font-mono font-semibold text-zinc-100 shrink-0">PO {row.po.orderId}</span>
                        <span className="text-[10px] font-mono text-zinc-500 truncate hidden sm:inline">{row.po.supplier}</span>
                        <span className="text-[11px] font-mono text-zinc-400 shrink-0">Inv #{row.inv.invoice_number || "—"}</span>
                        {variance && Math.abs(variance.netDelta) > 0.01 && (
                            <span className={`text-[11px] font-mono font-bold shrink-0 ${variance.netDelta > 0 ? "text-rose-300" : "text-emerald-300"}`}>
                                {money(variance.netDelta)}
                            </span>
                        )}
                        {age && <span className={`text-[9px] font-mono shrink-0 ${age.cls}`} title={`Received ${fmtDateTime(row.po.receiveDate || row.po.receiveDateTime)}`}>{age.text}</span>}
                        <div className="flex-1" />
                        {pdfUrl && (
                            <InvoicePdfLink
                                id={row.inv.id!}
                                number={row.inv.invoice_number}
                                withHover
                                hovered={hoverPdfId === row.inv.id}
                                onHoverChange={setHoverPdfId}
                            />
                        )}
                        {/* Inline Review button — the action is visible without expanding */}
                        <button
                            onClick={e => {
                                e.stopPropagation();
                                if (!expanded) {
                                    toggleExpand(row.key);
                                    lifecycle.setLockedFocus({ source: "rcv", vendorName: row.po.supplier, orderId: row.po.orderId, productIds: poProductIds });
                                }
                            }}
                            className={`shrink-0 px-2.5 py-1 rounded text-[10px] font-mono font-semibold border transition-colors cursor-pointer ${
                                expanded
                                    ? "border-zinc-700/50 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60"
                                    : hasBlocking
                                    ? "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                                    : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                            }`}
                        >
                            {expanded ? "Close" : hasBlocking ? "Resolve" : "Review"}
                        </button>
                    </div>
                    {/* Per-kind chips — WHICH bucket moved, without expanding */}
                    {variance && Object.keys(variance.byKind).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-[18px]">
                            {Object.entries(variance.byKind).map(([kind, amt]) => {
                                const ui = KIND_UI[kind] || KIND_UI.unexplained;
                                return (
                                    <span key={kind} className={`px-1.5 py-0.5 rounded border text-[9px] font-mono ${ui.cls}`}>
                                        {ui.label} {Math.abs(amt as number) > 0.01 ? money(amt as number) : ""}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Expanded — variance breakdown + actions */}
                {expanded && (
                    <div className="border-t border-zinc-800/40 bg-zinc-950/40">
                        {/* Money row */}
                        {cc && (
                            <div className="px-3 py-1.5 border-b border-zinc-800/40 bg-zinc-950/50 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono">
                                <span className="text-zinc-500">PO goods <span className="text-zinc-200">${(cc.po?.subtotal || cc.po?.total || 0).toFixed(2)}</span></span>
                                <span className="text-zinc-500">Invoice <span className="text-zinc-200">${(cc.invoice?.total || cc.invoice?.subtotal || 0).toFixed(2)}</span></span>
                                {cc.invoice?.freight > 0 && <span className="text-sky-400/80">Freight ${cc.invoice.freight.toFixed(2)}</span>}
                                {cc.invoice?.tax > 0 && <span className="text-violet-400/80">Tax ${cc.invoice.tax.toFixed(2)}</span>}
                                {cc.po?.tariffs > 0 && <span className="text-violet-400/80">Tariff ${cc.po.tariffs.toFixed(2)}</span>}
                            </div>
                        )}

                        {/* One row per classified difference — each with a resolution hint */}
                        {items.length > 0 ? (
                            <div className="border-b border-zinc-800/40 bg-zinc-950/30 divide-y divide-zinc-800/30">
                                {items.map((it, i) => {
                                    const ui = KIND_UI[it.kind] || KIND_UI.unexplained;
                                    return (
                                        <div key={i} className="px-3 py-1.5">
                                            <div className="flex items-start gap-2">
                                                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-mono ${ui.cls}`}>
                                                    {ui.label}
                                                </span>
                                                <span className="text-[10px] font-mono text-zinc-300 font-semibold truncate min-w-0" title={it.label}>
                                                    {it.label}
                                                </span>
                                                <div className="flex-1" />
                                                {it.poAmount != null && it.invoiceAmount != null && (
                                                    <span className="text-[9px] font-mono text-zinc-500 shrink-0">
                                                        {it.poAmount} → {it.invoiceAmount}
                                                    </span>
                                                )}
                                                {Math.abs(it.delta) > 0.01 && (
                                                    <span className={`text-[10px] font-mono font-semibold shrink-0 ${it.delta > 0 ? "text-rose-300" : "text-emerald-300"}`}>
                                                        {money(it.delta)}
                                                    </span>
                                                )}
                                                {it.blocking && <span className="text-[9px] font-mono text-rose-400 shrink-0">BLOCK</span>}
                                            </div>
                                            <div className="mt-0.5 text-[9px] font-mono text-zinc-500 leading-relaxed pl-1">
                                                {it.message}
                                            </div>
                                            {/* Resolution hint — tells the human WHAT to do about this variance */}
                                            <div className="mt-0.5 text-[9px] font-mono text-zinc-600 leading-relaxed pl-1 italic">
                                                {ui.hint}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            !variance && (
                                <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 border-b border-zinc-800/40">
                                    No variance breakdown available — review totals in Finale before completing.
                                </div>
                            )
                        )}

                        {/* BLOCKED resolution checklist — the human's path out of BLOCKED */}
                        {hasBlocking && (
                            <div className="px-3 py-2 border-b border-rose-500/20 bg-rose-950/10">
                                <div className="text-[9px] font-mono uppercase tracking-wider text-rose-400/80 mb-1">How to resolve</div>
                                <ol className="pl-4 text-[9px] font-mono text-rose-200/70 leading-relaxed list-decimal space-y-0.5">
                                    <li>Open the invoice PDF and compare line items to the PO.</li>
                                    <li>Fix what's wrong: match the correct PO, add the missing SKU, or confirm the charge with the vendor.</li>
                                    <li>Click Apply Invoice &amp; Complete — the gate re-checks automatically.</li>
                                </ol>
                            </div>
                        )}

                        {/* 3-way gate refusal banner (persistent per-row detail) */}
                        {gateReason && (
                            <div className="mx-3 mt-2 px-3 py-2.5 border border-rose-500/30 bg-rose-950/15 rounded flex items-start gap-2">
                                <span className="text-rose-400 text-[11px] mt-0.5 shrink-0 font-mono font-semibold">BLOCKED</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[10px] font-mono text-rose-400 font-semibold uppercase tracking-wider mb-0.5">3-Way Match Gate Refused</div>
                                    <div className="text-[11px] font-mono text-rose-200/90 leading-relaxed">{gateReason}</div>
                                </div>
                                <button
                                    onClick={() => setGateBlockReason(prev => { const next = new Map(prev); next.delete(row.po.orderId); return next; })}
                                    className="text-rose-400/40 hover:text-rose-300 shrink-0 text-[11px]"
                                >✕</button>
                            </div>
                        )}

                        {/* Footer: full-width Apply & Complete — no Finale link (context switch) */}
                        <div className="px-3 py-2 bg-zinc-950/60 border-t border-zinc-800/40">
                            <button
                                onClick={() => handleCompletePO(row.po.orderId, row.po.supplier)}
                                disabled={completing}
                                title="Complete: run the 3-way gate (PO vs invoice vs receipt), then close the PO in Finale. This is the final step."
                                className={`w-full px-3 py-2 rounded text-[11px] font-mono font-semibold transition-colors ${
                                    completing
                                        ? "bg-zinc-700/20 text-zinc-500 border border-zinc-700/40 cursor-wait"
                                        : hasBlocking
                                        ? "bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                                        : "bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 cursor-pointer"
                                }`}
                            >
                                {completing ? "Completing…" : `Apply Invoice & Complete PO ${row.po.orderId}`}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    /** Ready row — one green line, Complete right on the row (no expand needed). */
    function renderReadyRow(row: Extract<ActionRow, { kind: "ready" }>) {
        const pdfUrl = invoicePdfUrl(row.inv);
        const completing = completingId === row.po.orderId;
        const age = agingBadge(daysSince(row.po.receiveDate || row.po.receiveDateTime));
        return (
            <div key={row.key} className="px-4 py-2.5 border-b border-zinc-800/40 flex items-center gap-2 hover:bg-zinc-800/10 transition-colors">
                <span className="text-[11px] font-mono font-semibold text-emerald-400 shrink-0">READY</span>
                <span className="text-[11px] font-mono text-emerald-200/90 flex-1 min-w-0 truncate">
                    PO {row.po.orderId} <span className="text-zinc-500">{row.po.supplier}</span> matched Inv #{row.inv.invoice_number || "—"} — ready
                </span>
                {Number(row.inv.total) > 0 && Number(row.po.total) > 0 && (
                    <span
                        className={`text-[10px] font-mono shrink-0 ${Math.abs(Number(row.inv.total) - Number(row.po.total)) < 0.01 ? "text-emerald-400/80" : "text-amber-400/90"}`}
                        title="Verify reception matches amount: invoice total vs PO total (the 3-way gate re-checks SKU-level qty at Complete)"
                    >
                        {fmtDollars(row.inv.total)} vs {fmtDollars(row.po.total)}
                    </span>
                )}
                {age && <span className={`text-[9px] font-mono shrink-0 ${age.cls}`} title={`Received ${fmtDateTime(row.po.receiveDate || row.po.receiveDateTime)}`}>{age.text}</span>}
                {pdfUrl && <InvoicePdfLink id={row.inv.id!} number={row.inv.invoice_number} />}
                <button
                    onClick={() => row.inv.id && handleUnmatchInvoice(row.inv.id, row.po.orderId)}
                    disabled={!row.inv.id || unmatchingId === row.po.orderId}
                    title="Unmatch: undo the link if this invoice belongs to a different PO. The invoice returns to the Match list; the PO goes back to awaiting-invoice."
                    className="shrink-0 px-2 py-1 rounded text-[10px] font-mono border border-zinc-700/50 bg-zinc-800/30 text-zinc-400 hover:bg-zinc-700/40 hover:text-zinc-200 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-wait"
                >
                    {unmatchingId === row.po.orderId ? "Unmatching…" : "Unmatch"}
                </button>
                <button
                    onClick={() => handleCompletePO(row.po.orderId, row.po.supplier)}
                    disabled={completing}
                    title="Complete: run the 3-way gate (PO vs invoice vs receipt), then close the PO in Finale. This is the final step."
                    className="shrink-0 px-3 py-1 rounded text-[10px] font-mono font-semibold bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-wait"
                >
                    {completing ? "Completing…" : "Complete"}
                </button>
            </div>
        );
    }

    /** Match row — collapsed: top candidate + Match; expanded: all candidates + manual input. */
    function renderMatchRow(row: Extract<ActionRow, { kind: "match" }>) {
        const expanded = expandedRow === row.key;
        const s = row.suggestion;
        const best = s.candidates[0];
        const pdfUrl = suggestionPdfUrl(s);
        const manual = manuallyMatching.get(s.invoiceId);
        const age = agingBadge(daysSince(s.invoiceDate));

        return (
            <div key={row.key} className="border-b border-zinc-800/40">
                {/* Collapsed header — click to expand */}
                <div
                    role="button"
                    tabIndex={0}
                    onClick={e => {
                        const t = e.target as HTMLElement;
                        if (t.closest("a") || t.closest("button") || t.closest("input")) return;
                        toggleExpand(row.key);
                    }}
                    onKeyDown={e => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleExpand(row.key);
                        }
                    }}
                    className="w-full px-4 py-2.5 text-left cursor-pointer hover:bg-zinc-800/20 transition-colors"
                >
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-zinc-500 shrink-0">{expanded ? "▾" : "▸"}</span>
                        <span className="text-[11px] font-mono font-semibold text-blue-400 shrink-0">MATCH</span>
                        <span className="text-[11px] font-mono font-semibold text-zinc-100 shrink-0">Inv {s.invoiceNumber || "—"}</span>
                        <span className="text-[10px] font-mono text-zinc-500 truncate hidden sm:inline">{s.vendorName}</span>
                        {s.invoiceTotal > 0 ? (
                            <span className="text-[10px] font-mono text-zinc-400 shrink-0">{fmtDollars(s.invoiceTotal)}</span>
                        ) : (
                            <span className="text-[9px] font-mono text-amber-500/60 shrink-0" title="OCR could not read invoice total">$?</span>
                        )}
                        {best && (
                            <span className="text-[10px] font-mono text-zinc-500 shrink-0">→ {best.orderId}</span>
                        )}
                        {age && <span className={`text-[9px] font-mono shrink-0 ${age.cls}`} title={`Invoice ${s.invoiceDate || ""}`}>{age.text}</span>}
                        <div className="flex-1" />
                        {pdfUrl && <InvoicePdfLink id={s.invoiceId} number={s.invoiceNumber} />}
                        {best && (
                            <button
                                onClick={e => { e.stopPropagation(); handleMatchInvoice(s.invoiceId, best.orderId); }}
                                title="Match: link this invoice to the PO. Does NOT complete the PO — Complete is the final step."
                                className="shrink-0 px-2.5 py-1 rounded text-[10px] font-mono font-semibold border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 cursor-pointer transition-colors"
                            >
                                Match
                            </button>
                        )}
                    </div>
                </div>

                {/* Expanded — invoice items vs PO items, candidates + manual PO input */}
                {expanded && (
                    <div className="px-4 py-2 border-t border-zinc-800/40 bg-zinc-950/40 space-y-1.5">
                        {/* ── Educated match: invoice line items vs candidate PO items ──
                            Bill (2026-08-27): "still do not understand how to make an
                            educated match between received PO items and invoice."
                            Show what the invoice billed (SKU × qty) and what each
                            candidate PO contains; highlight SKUs present on both. */}
                        {s.invoiceLineItems && s.invoiceLineItems.length > 0 && (
                            <div>
                                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600">
                                    Invoice items ({s.invoiceLineItems.length})
                                </div>
                                {s.invoiceLineItems.map((li, i) => (
                                    <div key={i} className="flex items-baseline gap-1.5 text-[10px] font-mono text-zinc-300">
                                        <span className="font-semibold text-amber-300 shrink-0">{li.sku || "—"}</span>
                                        <span className="text-zinc-500 shrink-0">×{li.qty ?? ""}</span>
                                        {li.description && (
                                            <span className="text-zinc-600 truncate">{li.description}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {s.candidates.length > 0 && (
                            <div className="pt-1">
                                <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600">Candidates</div>
                                {s.candidates.slice(0, 3).map(c => {
                                    const invSkus = new Set(
                                        (s.invoiceLineItems || []).map(li => String(li.sku || "").trim().toUpperCase()).filter(Boolean),
                                    );
                                    const poSkus = (c.items || []).map((it: any) => String(it.productId || it.sku || "").trim().toUpperCase()).filter(Boolean);
                                    const overlap = poSkus.filter(sku => invSkus.has(sku)).length;
                                    return (
                                        <div key={c.orderId} className="border-b border-zinc-800/30 last:border-0 py-1">
                                            <div className="flex items-center gap-2 text-[10px] font-mono">
                                                <span className="text-zinc-200 font-semibold shrink-0">{c.orderId}</span>
                                                <span className="text-zinc-500 truncate hidden sm:inline">{c.vendorName}</span>
                                                <span className="text-zinc-400 shrink-0">{fmtDollars(c.total)}</span>
                                                <span className={`shrink-0 ${c.score >= 70 ? "text-emerald-400" : c.score >= 50 ? "text-amber-300" : "text-zinc-500"}`}>
                                                    {c.score}%
                                                </span>
                                                {c.items && c.items.length > 0 && (
                                                    <span className={`shrink-0 ${overlap > 0 ? "text-emerald-400" : "text-zinc-600"}`}>
                                                        {overlap}/{c.items.length} SKU match
                                                    </span>
                                                )}
                                                {c.reasons?.[0] && (
                                                    <span className="text-zinc-600 truncate hidden md:inline">{c.reasons[0]}</span>
                                                )}
                                                <button
                                                    onClick={() => handleMatchInvoice(s.invoiceId, c.orderId)}
                                                    title="Match: link this invoice to the PO. Does NOT complete the PO — Complete is the final step."
                                                    className="ml-auto shrink-0 px-2 py-0.5 rounded text-[9px] font-mono border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 cursor-pointer transition-colors"
                                                >
                                                    Match
                                                </button>
                                            </div>
                                            {/* PO line items with overlap highlighting */}
                                            {c.items && c.items.length > 0 && (
                                                <div className="mt-0.5 pl-1 space-y-0.5">
                                                    {c.items.map((it: any, i: number) => {
                                                        const sku = String(it.productId || it.sku || "").trim().toUpperCase();
                                                        const onInvoice = !!sku && invSkus.has(sku);
                                                        return (
                                                            <div key={i} className="flex items-baseline gap-1.5 text-[9px] font-mono">
                                                                <span className={`shrink-0 font-semibold ${onInvoice ? "text-emerald-400" : "text-zinc-500"}`}>
                                                                    {onInvoice ? "✓" : ""}{it.productId || it.sku || "—"}
                                                                </span>
                                                                <span className="text-zinc-500 shrink-0">×{it.quantity ?? ""}</span>
                                                                {it.unitPrice != null && Number(it.unitPrice) > 0 && (
                                                                    <span className="text-zinc-600 shrink-0">{fmtDollars(Number(it.unitPrice))}</span>
                                                                )}
                                                                <span className={`shrink-0 ${onInvoice ? "text-emerald-500" : "text-zinc-600"}`}>
                                                                    {onInvoice ? "on invoice" : "not on invoice"}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {/* No candidates — honest no-PO state (Bill 2026-08-27).
                            Some vendors legitimately have no PO (service/freight);
                            those were filtered upstream. For the rest, either the
                            PO is archived or the vendor name differs — manual entry
                            below is the path. */}
                        {s.candidates.length === 0 && (
                            <div className="text-[10px] font-mono text-zinc-500 py-0.5">
                                No PO match found{s.vendorName ? ` for ${s.vendorName}` : ""} — enter the PO # below, or this may be a non-PO invoice (routes to Bill.com without a match)
                            </div>
                        )}
                        {/* Manual PO input — one line under expand */}
                        <div className="flex items-center gap-1.5 pt-1.5 border-t border-zinc-800/30">
                            <span className="text-[9px] font-mono text-zinc-600 shrink-0">Manual:</span>
                            <input
                                type="text"
                                placeholder="PO #"
                                value={manual?.poNumber ?? ""}
                                onChange={e => handleManualInputChange(s.invoiceId, e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") handleManualMatch(s.invoiceId); }}
                                className="w-24 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 placeholder-zinc-600"
                            />
                            <button
                                onClick={() => handleManualMatch(s.invoiceId)}
                                disabled={!manual?.poNumber?.trim() || !!manual?.loading}
                                className="text-[10px] font-mono px-2 py-0.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {manual?.loading ? "Matching…" : "Go"}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    function renderActionRow(row: ActionRow) {
        if (row.kind === "review") return renderReviewRow(row);
        if (row.kind === "ready") return renderReadyRow(row);
        return renderMatchRow(row);
    }

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <div
            className={embedded
                ? "h-full min-h-0 flex flex-col overflow-hidden"
                : "border-b border-zinc-800 shrink-0"
            }
            ref={containerRef}
        >
            {/* Header */}
            <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/40">
                <Package className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Receivings</span>
                {actionRows.length > 0 && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        {actionRows.length} action
                    </span>
                )}
                {(() => {
                    const awaiting = buildAwaitingInvoice(visiblePos);
                    return awaiting.length > 0 ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-zinc-800/40 text-zinc-400 border border-zinc-700/30">
                            {awaiting.length} awaiting invoice
                        </span>
                    ) : null;
                })()}
                <div className="flex-1" />
                {!loading && visiblePos.length > 0 && (
                    <span className="text-xs font-mono text-zinc-500">{visiblePos.length} POs</span>
                )}
                <button onClick={() => fetchReceivings(true)} disabled={refreshing}
                    className="ml-2 text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className={`p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1 ${embedded ? "hidden" : ""}`}
                >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
                </button>
            </div>

            {/* Delivered awaiting receipt — bridge from Active Purchases */}
            {!effectivelyCollapsed && !loading && deliveredAwaiting.length > 0 && (
                <div className="px-3 py-1.5 border-b border-zinc-800/50 bg-rose-500/[0.04]">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-rose-400/80 mb-1">
                        Delivered · awaiting receipt ({deliveredAwaiting.length})
                    </div>
                    {deliveredAwaiting.map(po => (
                        <div key={po.orderId} className="flex items-center gap-2 text-[10px] font-mono py-0.5">
                            <span className="text-rose-300 font-semibold">{po.orderId}</span>
                            <span className="text-zinc-500 truncate">{po.vendorName}</span>
                            {po.hoursSinceDelivered != null && (
                                <span className={po.hoursSinceDelivered > 48 ? "text-rose-400" : po.hoursSinceDelivered > 24 ? "text-amber-400" : "text-zinc-500"}>
                                    {po.hoursSinceDelivered}h
                                </span>
                            )}
                            {po.trackingUrl && (
                                <a
                                    href={po.trackingUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-500 hover:text-cyan-400"
                                    title={po.trackingNumber || "tracking"}
                                >
                                    track
                                </a>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* One-line context — replaces the redundant AP stats strip */}
            {!effectivelyCollapsed && !loading && actionRows.length > 0 && (
                <div className="px-3 py-1 border-b border-zinc-800/50 bg-zinc-950/60 flex items-center gap-1.5 text-[10px] font-mono text-zinc-400">
                    <span className="text-zinc-500">{actionRows.length} item{actionRows.length === 1 ? "" : "s"} need attention</span>
                    {oldestActionDays > 0 && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span className={oldestActionDays >= 14 ? "text-rose-400" : oldestActionDays >= 7 ? "text-amber-400" : "text-zinc-500"}>
                                oldest {oldestActionDays >= 14 ? `${Math.round(oldestActionDays / 7)}w` : `${oldestActionDays}d`}
                            </span>
                        </>
                    )}
                    {/* True unmatched backlog — Bill (2026-08-27): the panel must
                        show the real count of PO-matchable unmatched invoices, not
                        the paint-budget slice (was capped at 6). */}
                    {unmatchedTotal > 0 && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span className="text-amber-400/90">
                                {unmatchedTotal} unmatched · {fmtDollars(unmatchedDollars)}
                            </span>
                        </>
                    )}
                </div>
            )}

            {!effectivelyCollapsed && (
                <div className={embedded ? "flex-1 min-h-0 flex flex-col overflow-hidden" : undefined}>
                    {/* Filter tabs — active one is FILLED, inactive are outline */}
                    {!loading && !error && visiblePos.length > 0 && (
                        <div className="px-4 py-1.5 flex flex-wrap items-center gap-1.5 border-b border-zinc-800/40 bg-zinc-900/30">
                            <button
                                onClick={() => setFilterTab("action")}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                    filterTab === "action"
                                        ? "bg-zinc-200 text-zinc-900 border-zinc-200 font-semibold"
                                        : "bg-transparent border-zinc-700/50 text-zinc-400 hover:bg-zinc-800/60"
                                }`}
                            >
                                {actionRows.length} Action
                            </button>
                            {readyCount > 0 && (
                                <button
                                    onClick={() => setFilterTab("ready")}
                                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                        filterTab === "ready"
                                            ? "bg-emerald-400 text-zinc-950 border-emerald-400 font-semibold"
                                            : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                                    }`}
                                >
                                    {readyCount} Ready
                                </button>
                            )}
                            {reviewCount > 0 && (
                                <button
                                    onClick={() => setFilterTab("review")}
                                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                        filterTab === "review"
                                            ? "bg-rose-400 text-zinc-950 border-rose-400 font-semibold"
                                            : "bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
                                    }`}
                                >
                                    {reviewCount} Review
                                </button>
                            )}
                            {matchCount > 0 && (
                                <button
                                    onClick={() => setFilterTab("match")}
                                    title={unmatchedTotal > matchCount
                                        ? `${unmatchedTotal} unmatched in the last 30 days — showing the ${matchCount} newest scored`
                                        : "Invoices waiting to be linked to their PO"}
                                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                        filterTab === "match"
                                            ? "bg-amber-400 text-zinc-950 border-amber-400 font-semibold"
                                            : "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
                                    }`}
                                >
                                    {unmatchedTotal > matchCount ? `${unmatchedTotal} Match` : `${matchCount} Match`}
                                </button>
                            )}
                            {settledPos.length > 0 && (
                                <button
                                    onClick={() => {
                                        setFilterTab("settled");
                                        setShowAllReceived(true);
                                    }}
                                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                                        filterTab === "settled"
                                            ? "bg-zinc-500 text-zinc-950 border-zinc-500 font-semibold"
                                            : "bg-transparent border-zinc-700/50 text-zinc-500 hover:bg-zinc-800/60"
                                    }`}
                                >
                                    {settledPos.length} Settled
                                </button>
                            )}
                        </div>
                    )}

                    {/* Complete feedback toast — always visible (also when the
                        optimistic remove briefly empties the list) */}
                    {actionToast && (
                        <div className={`sticky top-0 z-30 px-4 py-2 border-b text-[11px] font-mono flex items-center gap-2 ${
                            actionToast.kind === "ok"
                                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                                : actionToast.kind === "block"
                                ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                                : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                        }`}>
                            <span className={`font-mono font-semibold text-[11px] ${actionToast.kind === "ok" ? "text-emerald-400" : actionToast.kind === "block" ? "text-rose-400" : "text-red-400"}`}>{actionToast.kind === "ok" ? "DONE" : actionToast.kind === "block" ? "BLOCKED" : "ERROR"}</span>
                            <span className="flex-1 min-w-0">{actionToast.text}</span>
                            <button onClick={() => setActionToast(null)} className="shrink-0 opacity-60 hover:opacity-100">✕</button>
                        </div>
                    )}

                    {loading ? (
                        <div className="px-4 py-3 space-y-2.5">
                            <div className="text-[10px] font-mono text-zinc-600 mb-1.5 animate-pulse">Loading received POs...</div>
                            {[1, 2, 3].map(i => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="skeleton-shimmer h-3" style={{ width: `${20 + i * 8}%` }} />
                                    <div className="skeleton-shimmer h-3 w-12 ml-auto" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-rose-400">{error}</span></div>
                    ) : visiblePos.length === 0 && matchCount === 0 ? (
                        <div className="px-4 py-2"><span className="text-xs font-mono text-zinc-500">No receipts in the last 30 days — all received POs have been processed</span></div>
                    ) : (
                        <div
                            className={`overflow-y-auto border-t border-zinc-800/60 ${embedded ? "flex-1 min-h-0" : ""}`}
                            style={embedded ? undefined : { height: bodyHeight }}
                        >
                            {todaySummary && (
                                <div className="px-4 py-3 border-b border-cyan-500/20 bg-cyan-500/5">
                                    <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-300/80">
                                        Shipping Today
                                    </div>
                                    <div className="mt-1 text-sm font-semibold text-cyan-100">
                                        {todaySummary.headline}
                                    </div>
                                    <div className="mt-2 space-y-1">
                                        {todaySummary.lines.map((line) => {
                                            const isValidated = line.includes('✓ validated');
                                            return (
                                                <div key={line} className={`text-[11px] font-mono ${isValidated ? 'text-emerald-300' : 'text-cyan-200/85'}`}>
                                                    {line}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* ── ONE actionable list (filtered by tab) ── */}
                            {filterTab !== "settled" && (visibleActionRows.length > 0 ? (
                                <div>
                                    {visibleActionRows.map(row => renderActionRow(row))}
                                </div>
                            ) : (
                                <div className="px-4 py-6 text-center">
                                    <span className="text-xs font-mono text-emerald-400/70">
                                        {actionRows.length > 0 ? `No ${filterTab} items — switch tabs to see the rest` : "All invoices matched — nothing needs attention"}
                                    </span>
                                </div>
                            ))}

                            {/* ── Awaiting invoice — received but no invoice yet ── */}
                            {filterTab !== "settled" && (() => {
                                const awaiting = buildAwaitingInvoice(visiblePos);
                                if (awaiting.length === 0) return null;
                                return (
                                    <div className="border-b border-zinc-800/40">
                                        <button
                                            onClick={() => setShowAwaitingInvoice(!showAwaitingInvoice)}
                                            className="w-full px-4 py-1.5 bg-zinc-950/40 flex items-center gap-2 text-left hover:bg-zinc-900/40 transition-colors"
                                        >
                                            <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                                                {showAwaitingInvoice ? "▾" : "▸"} Awaiting invoice ({awaiting.length})
                                            </span>
                                            <span className="ml-auto text-[9px] font-mono text-zinc-600">
                                                {(() => {
                                                    const stale = awaiting.filter(po => (daysSince(po.receiveDate || po.receiveDateTime) ?? 0) >= 14).length;
                                                    return stale > 0 ? `${stale} stale ≥14d` : "";
                                                })()}
                                            </span>
                                        </button>
                                        {showAwaitingInvoice && awaiting.map(po => {
                                            const age = agingBadge(daysSince(po.receiveDate || po.receiveDateTime));
                                            return (
                                                <div key={po.orderId} className="px-4 py-1.5 flex items-center gap-2 text-[10px] font-mono border-b border-zinc-800/20">
                                                    <span className="text-zinc-400">{po.orderId}</span>
                                                    <span className="text-zinc-600 truncate">{po.supplier}</span>
                                                    {age && (
                                                        <span className={`text-[9px] font-mono shrink-0 ${age.cls}`} title={`Received ${fmtDateTime(po.receiveDate)}`}>
                                                            {age.text}
                                                        </span>
                                                    )}
                                                    <span className="text-zinc-500 ml-auto shrink-0">Rcvd {fmtDateTime(po.receiveDate)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })()}

                            {/* ── Auto-processed summary — full trail in Activity tab ── */}
                            {recentAutoCompletions.length > 0 && filterTab !== "settled" && (
                                <div className="px-4 py-1.5 border-b border-zinc-800/30 flex items-center gap-2">
                                    <span className="text-[10px] font-mono text-emerald-500/50">-</span>
                                    <span className="text-[10px] font-mono text-zinc-600">
                                        {recentAutoCompletions.length} auto-completed
                                    </span>
                                    <button
                                        onClick={() => (document.querySelector('[role="tab"][aria-label="Activity"]') as HTMLElement | null)?.click()}
                                        className="text-[9px] font-mono text-blue-500/50 hover:text-blue-400 underline underline-offset-2 decoration-blue-500/20 transition-colors"
                                    >
                                        view in Activity
                                    </button>
                                </div>
                            )}

                            {/* ── Settled dump — only under the Settled tab ── */}
                            {filterTab === "settled" && settledPos.length > 0 && (
                                <div>
                                    <button
                                        onClick={() => setShowAllReceived(!showAllReceived)}
                                        className="w-full px-4 py-1 text-[10px] font-mono text-zinc-600 hover:text-zinc-400 border-b border-zinc-800/40 transition-colors text-left flex items-center gap-1"
                                    >
                                        {showAllReceived ? "−" : "+"}
                                        <span>{showAllReceived ? "Hide settled POs" : `Show all ${settledPos.length} settled POs`}</span>
                                    </button>
                                    {showAllReceived && settledPos.map(po => {
                                        const discrepancy = partialDiscrepancy(po);
                                        const badge = receiptBadge(po);
                                        return (
                                            <div key={po.orderId} className="border-b border-zinc-800/30">
                                                <div className="px-4 py-1.5 flex items-center gap-2 text-[10px] font-mono hover:bg-zinc-800/10 transition-colors">
                                                    <span className="text-zinc-500 shrink-0">{fmtDateTime(po.receiveDateTime || po.receiveDate)}</span>
                                                    <a href={po.finaleUrl} target="_blank" rel="noopener noreferrer"
                                                        className="text-blue-500 hover:text-blue-300 shrink-0 font-semibold">
                                                        {po.orderId}
                                                    </a>
                                                    <span className="text-zinc-300 truncate">{po.supplier}</span>
                                                    {badge && (
                                                        <span className={`text-[9px] font-mono px-1 py-px rounded border shrink-0 ${badge.cls}`}>
                                                            {badge.label}
                                                        </span>
                                                    )}
                                                    <span className="text-zinc-500 shrink-0 ml-auto">{fmtDollars(po.total)}</span>
                                                </div>
                                                {discrepancy && (
                                                    <div className="px-4 pb-1.5 text-[10px] font-mono text-amber-300/80 -mt-0.5">
                                                        {discrepancy}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {filterTab === "settled" && settledPos.length === 0 && (
                                <div className="px-4 py-6 text-center">
                                    <span className="text-xs font-mono text-zinc-500">No settled POs in this window</span>
                                </div>
                            )}
                        </div>
                    )}

                    {!embedded && !loading && !error && visiblePos.length > 0 && (
                        <div onMouseDown={startResize}
                            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60" />
                    )}
                </div>
            )}
        </div>
    );
}
