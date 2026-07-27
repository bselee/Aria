"use client";

import React from "react";
import { useEffect, useState, useCallback, useRef } from "react";
import { Receipt, ChevronDown, ChevronRight, Check, X, AlertCircle, Loader2 } from "lucide-react";
import type { InvoiceQueueItem, InvoiceQueueStats, InvoiceQueueResponse } from "@/app/api/dashboard/invoice-queue/route";

/** Threshold in days: pending items older than this are considered stale */
const STALE_THRESHOLD_DAYS = 7;

function daysOld(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

type StatusKey = "auto_approved" | "needs_approval" | "rejected" | "duplicate" | "unmatched" | "short_shipment_hold" | "matched_unreconciled";

const STATUS_CFG: Record<StatusKey, { dot: string; label: string; pulse: boolean }> = {
  auto_approved: { dot: "bg-emerald-500", label: "AUTO", pulse: false },
  needs_approval: { dot: "bg-amber-400", label: "PENDING", pulse: true },
  rejected: { dot: "bg-red-500", label: "REJECT", pulse: false },
  duplicate: { dot: "bg-zinc-600", label: "DUP", pulse: false },
  unmatched: { dot: "bg-rose-500", label: "NO PO", pulse: false },
  short_shipment_hold: { dot: "bg-orange-500", label: "SHORT SHIP", pulse: true },
  matched_unreconciled: { dot: "bg-cyan-500", label: "MATCHED", pulse: false },
};

function statusCfg(status: string) {
  return STATUS_CFG[status as StatusKey] ?? { dot: "bg-zinc-600", label: status.toUpperCase(), pulse: false };
}

// ── Reconciliation Detail (copied from ActivityFeed.tsx) ──────────────────────

function fmtDollars(n: number): string {
    return "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ReconciliationDetail({ metadata }: { metadata: Record<string, unknown> | null }) {
    if (!metadata) return null;

    const priceChanges = (metadata.priceChanges as any[]) || [];
    const feeChanges = (metadata.feeChanges as any[]) || [];
    const tracking = metadata.tracking as any;
    const totalImpact = (metadata.totalDollarImpact ?? metadata.totalImpact ?? 0) as number;
    const verdict = metadata.verdict as string | undefined;

    const shortShipmentImpact = priceChanges
        .filter((pc: any) => pc.verdict === "short_shipment_hold")
        .reduce((acc: number, pc: any) => {
            const gap = pc.receivingGap ?? Math.max(0, pc.quantity - (pc.receivedQty ?? 0));
            return acc + gap * (pc.invoicePrice ?? 0);
        }, 0);

    const meaningfulPrices = priceChanges.filter(
        (pc: any) => pc.verdict !== "no_change" && pc.verdict !== "no_match" && pc.verdict !== "short_shipment_hold"
    );

    if (meaningfulPrices.length === 0 && feeChanges.length === 0 && !tracking && shortShipmentImpact === 0) {
        return null;
    }

    return (
        <div className="mt-3 space-y-2 font-mono text-xs border-t border-zinc-700/40 pt-2">
            {verdict && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                        verdict === "auto_approve" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                            : verdict === "needs_approval" ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                            : verdict === "short_shipment_hold" ? "text-orange-400 bg-orange-500/10 border-orange-500/20 animate-pulse"
                            : verdict === "rejected" ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
                            : "text-zinc-400 bg-zinc-700/20 border-zinc-700/30"
                    }`}>
                        {verdict.replace(/_/g, " ")}
                    </span>
                    <span className="text-zinc-500">
                        Impact: <span className={totalImpact > 0 ? "text-amber-400" : "text-zinc-400"}>{fmtDollars(totalImpact)}</span>
                    </span>
                    {shortShipmentImpact > 0 && (
                        <span className="text-zinc-500">
                            | Short Qty Impact: <span className="text-orange-400 font-semibold">{fmtDollars(shortShipmentImpact)}</span>
                        </span>
                    )}
                </div>
            )}

            {/* Dedicated Short Shipments Section */}
            {priceChanges.some((pc: any) => pc.verdict === "short_shipment_hold") && (
                <div className="space-y-1">
                    <div className="text-orange-400 uppercase tracking-wider text-[10px] mb-1 font-semibold flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                        Quantity Discrepancies (Short Shipments)
                    </div>
                    <div className="space-y-1">
                        {priceChanges
                            .filter((pc: any) => pc.verdict === "short_shipment_hold")
                            .map((pc: any, i: number) => {
                                const gap = pc.receivingGap ?? Math.max(0, pc.quantity - (pc.receivedQty ?? 0));
                                const costImpact = gap * (pc.invoicePrice ?? 0);
                                return (
                                    <div key={i} className="flex flex-col gap-0.5 bg-orange-500/5 border border-orange-500/10 rounded p-1.5">
                                        <div className="flex items-center justify-between text-zinc-200">
                                            <span className="font-semibold text-orange-300 truncate max-w-[180px]" title={pc.description || pc.productId}>
                                                {pc.productId}
                                            </span>
                                            <span className="text-rose-400 font-medium">
                                                -{gap} unit{gap !== 1 ? "s" : ""}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-[10px] text-zinc-400">
                                            <span>
                                                Invoiced: {pc.quantity} units | Received: {pc.receivedQty ?? 0}
                                            </span>
                                            <span>
                                                Unit: {fmtDollars(pc.invoicePrice ?? 0)} | Impact: <span className="text-orange-400 font-semibold">{fmtDollars(costImpact)}</span>
                                            </span>
                                        </div>
                                        {pc.reason && (
                                            <div className="text-[10px] text-zinc-500 italic mt-0.5">
                                                {pc.reason.replace(/^[\s|]*SHORT SHIPMENT:\s*/i, "").replace(/^[\s|]*SHORT\s*SHIPMENT\s*HOLD:\s*/i, "")}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                    </div>
                </div>
            )}

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
                                    {pc.description || pc.productId}
                                </span>
                                <span className="text-zinc-600">{fmtDollars(pc.from ?? 0)}</span>
                                <span className="text-zinc-600">→</span>
                                <span className="text-zinc-200">{fmtDollars(pc.to ?? 0)}</span>
                                <span className={`text-[10px] ${(pc.pct ?? 0) > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                                    {(pc.pct ?? 0) > 0 ? "+" : ""}{(pc.pct ?? 0).toFixed(1)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {feeChanges.length > 0 && (
                <div>
                    <div className="text-zinc-500 uppercase tracking-wider text-[10px] mb-1">Fee / Charge Updates</div>
                    <div className="space-y-0.5">
                        {feeChanges.map((fc: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                                <span className={`text-[10px] ${fc.verdict === "auto_approve" ? "text-emerald-500" : fc.verdict === "amber" || fc.verdict === "needs_approval" ? "text-amber-500" : "text-zinc-400"}`}>
                                    {fc.verdict === "auto_approve" ? "✅" : "⚠️"}
                                </span>
                                <span className="text-zinc-300 truncate max-w-[120px]">{fc.description || fc.type}</span>
                                {(fc.from ?? 0) > 0 && (
                                    <>
                                        <span className="text-zinc-600">{fmtDollars(fc.from)}</span>
                                        <span className="text-zinc-600">→</span>
                                    </>
                                )}
                                <span className="text-zinc-200">{fmtDollars(fc.to ?? 0)}</span>
                                {(fc.from ?? 0) === 0 && <span className="text-[10px] text-blue-400 uppercase">New</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

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

// ── Guidance ──────────────────────────────────────────────────────────────────

function pendingGuidance(inv: InvoiceQueueItem): { text: string; suggestion: "approve" | "dismiss" | "review" } {
  const v = inv.vendorName.toLowerCase();
  const num = (inv.invoiceNumber ?? "").toLowerCase();
  const impact = Math.abs(inv.dollarImpact ?? 0);

  // Short shipment case
  if (inv.status === "short_shipment_hold") {
    const priceChanges = (inv.metadata?.priceChanges as any[]) || [];
    const shortLines = priceChanges.filter((pc: any) => pc.verdict === "short_shipment_hold");
    const gapSum = shortLines.reduce((acc: number, pc: any) => {
      const gap = pc.receivingGap ?? Math.max(0, pc.quantity - (pc.receivedQty ?? 0));
      return acc + gap;
    }, 0);
    return {
      text: `⚠️ SHORT SHIPMENT: ${shortLines.length} item(s) short by ${gapSum} units total. Hold for credit memo or manual override.`,
      suggestion: "review",
    };
  }

  // OCR failure — nothing to reconcile
  if (v === "error" || v === "unknown" || num === "error" || num === "") {
    return { text: "OCR failed — couldn't read this document. Dismiss it.", suggestion: "dismiss" };
  }
  // No PO match
  if (!inv.poNumber) {
    return { text: "No PO matched. Could be a statement or duplicate.", suggestion: "review" };
  }
  // Tiny variance — rounding or minor price diff
  if (impact > 0 && impact < 1) {
    return { text: `$${impact.toFixed(2)} rounding difference — safe to approve.`, suggestion: "approve" };
  }
  // Freight-heavy invoice
  if (inv.freight && inv.freight > 0 && impact > 0) {
    return { text: `Includes $${inv.freight.toFixed(0)} freight. Approve if freight is expected.`, suggestion: "approve" };
  }
  // Larger gap
  if (impact > 5) {
    return { text: `$${impact.toFixed(2)} variance — review line items before approving.`, suggestion: "review" };
  }
  // Balance warning from reconciler
  if (inv.balanceWarning) {
    return { text: inv.balanceWarning, suggestion: "review" };
  }
  // Default
  return { text: "Price or fee changes detected — review and approve.", suggestion: "review" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InvoiceQueuePanel() {
  const [invoices, setInvoices] = useState<InvoiceQueueItem[]>([]);
  const [stats, setStats] = useState<InvoiceQueueStats | null>(null);
  const [needsEyes, setNeedsEyes] = useState({ missingPdf: 0, humanInteraction: 0 });
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [bulkDismissing, setBulkDismissing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  // Per-invoice selected disregard reason for unmatched rows
  const [disregardReason, setDisregardReason] = useState<Record<string, string>>({});
  // Sort toggle: false = chronological (default), true = by total DESC
  const [sortByDollar, setSortByDollar] = useState(false);
  const sortByDollarRef = useRef(sortByDollar);

  // Keep ref in sync so fetchData (used in intervals) always reads latest sort
  const toggleSort = useCallback(() => {
    setSortByDollar(prev => {
      const next = !prev;
      sortByDollarRef.current = next;
      return next;
    });
  }, []);

  // Handle approve/dismiss actions
  const handleAction = useCallback(async (id: string, action: "approve" | "dismiss") => {
    setActingOn(id);
    setToast(null);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityLogId: id, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data.error || "Action failed", type: "error" });
      } else {
        setToast({ message: data.message || `${action} applied`, type: "success" });
        setExpandedId(null);
      }
    } catch (err) {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setActingOn(null);
      fetchData(true);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // Bulk-dismiss all stale pending items
  const handleDismissAllStale = useCallback(async (staleItems: InvoiceQueueItem[]) => {
    setBulkDismissing(true);
    const ids = staleItems.map(i => i.activityLogId).filter(Boolean) as string[];
    for (const id of ids) {
      try {
        await fetch("/api/dashboard/reconciliation-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ activityLogId: id, action: "dismiss" }),
        });
      } catch { /* continue with rest */ }
    }
    setBulkDismissing(false);
    fetchData(true);
  }, []);

  // Handle "Approve" for matched_unreconciled invoices — confirms the PO match
  // Keyed on invoice id (vendor_invoices.id UUID), NOT activityLogId, because
  // matched_unreconciled invoices have no activity log entry.
  const handleApproveUnreconciled = useCallback(async (invoiceId: string, poNumber: string) => {
    setActingOn(invoiceId);
    setToast(null);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_unreconciled", invoiceId, poNumber, markedBy: "dashboard" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data.error || "Action failed", type: "error" });
      } else {
        setToast({ message: data.message || "Approved", type: "success" });
        setExpandedId(null);
      }
    } catch (err) {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setActingOn(null);
      fetchData(true);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // Handle "Disregard" for matched_unreconciled invoices — marks as not a PO purchase
  // and updates vendor profile for learning. Same keying pattern as approve_unreconciled.
  const handleDisregardUnreconciled = useCallback(async (invoiceId: string, poNumber: string) => {
    setActingOn(invoiceId);
    setToast(null);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disregard_unreconciled", invoiceId, poNumber, markedBy: "dashboard" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data.error || "Action failed", type: "error" });
      } else {
        setToast({ message: data.message || "Disregarded", type: "success" });
        setExpandedId(null);
      }
    } catch (err) {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setActingOn(null);
      fetchData(true);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // Handle "not a PO purchase" disregard for unmatched invoices
  // Keyed on invoice id (vendor_invoices.id UUID), NOT activityLogId, because
  // unmatched invoices have no activity log entry.
  const handleDisregard = useCallback(async (invoiceId: string, reason?: string) => {
    setActingOn(invoiceId);
    setToast(null);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disregard", invoiceId, reason, markedBy: "dashboard" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data.error || "Action failed", type: "error" });
      } else {
        setToast({ message: data.message || "Disregarded", type: "success" });
        setExpandedId(null);
      }
    } catch (err) {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setActingOn(null);
      fetchData(true);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // Bulk-disregard ALL unmatched invoices from a vendor at once
  const handleDisregardVendor = useCallback(async (vendorName: string, alsoMarkVendor: boolean = false) => {
    setActingOn(`vendor:${vendorName}`);
    setToast(null);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "disregard_vendor",
          vendorName,
          reason: "vendor_no_po_required",
          markedBy: "dashboard",
          alsoMarkVendor,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data.error || "Action failed", type: "error" });
      } else {
        setToast({ message: data.message || "Disregarded all", type: "success" });
      }
    } catch (err) {
      setToast({ message: "Network error", type: "error" });
    } finally {
      setActingOn(null);
      fetchData(true);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // Collapse state — persisted to localStorage
  const [isCollapsed, setIsCollapsed] = useState(false);
  useEffect(() => {
    const s = localStorage.getItem("aria-dash-invoice-collapsed");
    if (s === "true") setIsCollapsed(true);
  }, []);
  useEffect(() => {
    localStorage.setItem("aria-dash-invoice-collapsed", String(isCollapsed));
  }, [isCollapsed]);

  // Fetch from API route
  const fetchData = useCallback((bust = false) => {
    const params = new URLSearchParams();
    if (bust) params.set("bust", "1");
    if (sortByDollarRef.current) params.set("sort", "dollar");
    const qs = params.toString();
    const url = qs ? `/api/dashboard/invoice-queue?${qs}` : "/api/dashboard/invoice-queue";
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then((data: InvoiceQueueResponse | null) => {
        if (data) {
          setInvoices(data.invoices);
          setStats(data.stats);
          setNeedsEyes(data.needsEyes ?? { missingPdf: 0, humanInteraction: 0 });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(), 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Partition into pending vs rest
  const pending = invoices.filter(i => i.status === "needs_approval" || i.status === "short_shipment_hold");
  const rest = invoices.filter(i => i.status !== "needs_approval" && i.status !== "short_shipment_hold");

  // Identify stale pending items (older than threshold)
  const stalePending = pending.filter(i => daysOld(i.processedAt) > STALE_THRESHOLD_DAYS);
  const freshPending = pending.filter(i => daysOld(i.processedAt) <= STALE_THRESHOLD_DAYS);
  const needsEyesTotal = needsEyes.missingPdf + needsEyes.humanInteraction;
  const needsEyesParts: string[] = [];
  if (needsEyes.missingPdf > 0) needsEyesParts.push(`${needsEyes.missingPdf} PDF`);
  if (needsEyes.humanInteraction > 0) needsEyesParts.push(`${needsEyes.humanInteraction} HUMAN`);

  return (
    <div className="border-b border-zinc-800 shrink-0">
      {/* Header */}
      <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
        <Receipt className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">
          AP / Invoices
        </span>
        <div className="flex-1" />

        {/* Focused review page — full-width side-by-side invoice/PO comparison */}
        {!isCollapsed && pending.length > 0 && (
          <a
            href="/dashboard/invoice-review"
            className="text-[10px] font-mono text-amber-400 hover:text-amber-300 transition-colors mr-1 underline"
          >
            review →
          </a>
        )}

        {/* CSV export — only when expanded */}
        {!isCollapsed && (
          <button
            onClick={() => window.open("/api/dashboard/invoice-queue?export=1", "_blank")}
            className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors mr-1"
          >
            export
          </button>
        )}

        {/* Sort toggle — chronological (default) vs by dollar amount */}
        {!isCollapsed && (
          <button
            onClick={() => { toggleSort(); fetchData(true); }}
            className={`text-[10px] font-mono transition-colors mr-1 ${
              sortByDollar
                ? "text-amber-400 hover:text-amber-300"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
            title={sortByDollar ? "Sorted by $ — click for chronological" : "Sorted by time — click for by $"}
          >
            {sortByDollar ? "sort by time" : "sort by $"}
          </button>
        )}

        {/* Pending badge — only count fresh pending */}
        {freshPending.length > 0 && (
          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40">
            {freshPending.length} PENDING
          </span>
        )}
        {stalePending.length > 0 && (
          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-zinc-600/30 text-zinc-500 border-zinc-600/40">
            {stalePending.length} STALE
          </span>
        )}
        {needsEyesTotal > 0 && (
          <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-200 border-amber-500/30">
            Needs Eyes {needsEyesParts.join(" ")}
          </span>
        )}
        {!loading && pending.length === 0 && (
          <span className="text-xs font-mono text-zinc-600">all clear</span>
        )}

        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
        </button>
      </div>

      {!isCollapsed && (
        <>
          {/* Stats bar */}
          {stats && (
            <div className="px-4 py-1.5 border-b border-zinc-800/40 flex items-center gap-3 flex-wrap">
              <span className="text-[10px] font-mono text-zinc-500">
                today: <span className="text-zinc-400">{stats.totalToday}</span>
              </span>
              <span className="text-[10px] font-mono text-zinc-600">|</span>
              <span className="text-[10px] font-mono text-zinc-500">
                auto: <span className="text-emerald-400">{stats.autoApproved}</span>
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                pending: <span className="text-amber-300">{freshPending.length}</span>
              </span>
              {stalePending.length > 0 && (
                <span className="text-[10px] font-mono text-zinc-600">
                  stale: <span className="text-zinc-500">{stalePending.length}</span>
                </span>
              )}
              <span className="text-[10px] font-mono text-zinc-500">
                unmatched: <span className="text-rose-400">{stats.unmatched}</span>
              </span>
              {stats.totalDollarImpact !== 0 && (
                <>
                  <span className="text-[10px] font-mono text-zinc-600">|</span>
                  <span className="text-[10px] font-mono text-zinc-500">
                    impact:{" "}
                    <span className={stats.totalDollarImpact >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {stats.totalDollarImpact >= 0 ? "+" : ""}${Math.abs(stats.totalDollarImpact).toFixed(2)}
                    </span>
                  </span>
                </>
              )}
            </div>
          )}

          {/* Toast notification */}
          {toast && (
            <div className={`mx-4 my-2 px-3 py-2 rounded-md text-xs font-mono border animate-in fade-in slide-in-from-top-1 ${toast.type === "success"
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}>
              {toast.message}
            </div>
          )}

          {/* Skeleton loading */}
          {loading && (
            <div className="px-4 py-2 space-y-2.5">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full skeleton-shimmer shrink-0" />
                  <div className="skeleton-shimmer h-3.5" style={{ width: `${40 + i * 15}%` }} />
                  <div className="skeleton-shimmer h-3 w-8 ml-auto" />
                </div>
              ))}
            </div>
          )}

          {/* Stale pending — collapsed with bulk dismiss */}
          {stalePending.length > 0 && (
            <div className="border-b border-zinc-700/30 bg-zinc-800/20">
              <div className="flex items-center gap-2 px-4 py-1.5">
                <AlertCircle className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="text-[10px] font-mono text-zinc-500">
                  {stalePending.length} stale item{stalePending.length !== 1 ? "s" : ""} ({stalePending.map(i => `${i.vendorName}`).join(", ")}) — {stalePending[0] && daysOld(stalePending[0].processedAt)}+ days old
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => handleDismissAllStale(stalePending)}
                  disabled={bulkDismissing}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-700/50 text-zinc-400 border border-zinc-600/30 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                >
                  <X className="w-3 h-3" />
                  {bulkDismissing ? "Dismissing..." : "Dismiss All Stale"}
                </button>
              </div>
            </div>
          )}

          {/* Fresh pending invoices — highlighted row */}
          {freshPending.map(inv => {
            const cfg = statusCfg(inv.status);
            const isExpanded = expandedId === inv.id;
            const hasDetail = inv.metadata && (
              ((inv.metadata as any).priceChanges?.length > 0) ||
              ((inv.metadata as any).feeChanges?.length > 0) ||
              (inv.metadata as any).tracking
            );
            const isShortShip = inv.status === "short_shipment_hold";
            const borderLeftColor = isShortShip ? "rgb(249 115 22)" : "var(--dash-accent-pending)";
            const rowBgClass = isShortShip ? "border-b border-orange-500/10 bg-orange-500/5 border-l-2" : "border-b border-amber-500/10 bg-amber-500/5 border-l-2";

            return (
              <div
                key={inv.id}
                className={rowBgClass}
                style={{ borderLeftColor }}
              >
                <div className="flex items-start gap-2.5 px-4 py-2">
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} animate-pulse`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-mono font-semibold text-zinc-100 truncate">
                        {inv.vendorName}
                      </span>
                      {/* source_inbox badge */}
                      {(() => {
                        const src = (inv as any).source_inbox as string | null | undefined;
                        if (!src || src === 'default') return null;
                        const isAp = src === 'ap';
                        return (
                          <span className={`text-[9px] font-mono font-semibold px-1 py-0.5 rounded shrink-0 ${
                            isAp
                              ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                              : 'bg-zinc-600/30 text-zinc-400 border border-zinc-600/40'
                          }`}>
                            @{isAp ? 'ap' : src.split('@')[0]}
                          </span>
                        );
                      })()}
                      {inv.invoiceNumber && (
                        <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                          #{inv.invoiceNumber}
                        </span>
                      )}
                      {inv.poNumber && (
                        <span className="text-xs font-mono text-blue-400 shrink-0">
                          → PO {inv.poNumber}
                        </span>
                      )}
                      {inv.dollarImpact !== null && inv.dollarImpact !== 0 && (
                        <span
                          className={`text-[10px] font-mono shrink-0 ${inv.dollarImpact >= 0 ? "text-emerald-400" : "text-red-400"}`}
                          title={inv.balanceWarning ?? undefined}
                        >
                          {inv.dollarImpact >= 0 ? "+" : ""}${Math.abs(inv.dollarImpact).toFixed(2)}
                          {inv.balanceWarning && <span className="ml-0.5 text-amber-300">⚠</span>}
                        </span>
                      )}
                      <span className="text-[10px] font-mono text-[var(--dash-ts)] shrink-0 ml-auto">
                        {timeAgo(inv.processedAt)}
                      </span>
                    </div>
                    {inv.classificationReason && (
                      <div className="text-[10px] font-mono text-zinc-500 truncate mt-0.5 leading-tight">
                        {inv.classificationReason}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {(() => {
                        const g = pendingGuidance(inv);
                        return (
                          <span className={`text-[10px] font-mono truncate ${g.suggestion === "dismiss" ? "text-zinc-500" :
                              g.suggestion === "approve" ? "text-emerald-400/70" :
                                "text-amber-300/70"
                            }`}>
                            {g.suggestion === "approve" ? "✓ " : g.suggestion === "dismiss" ? "⊘ " : "⚠ "}
                            {g.text}
                          </span>
                        );
                      })()}
                      <div className="flex-1" />
                      {hasDetail && (
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
                        >
                          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          {isExpanded ? "Hide" : "Details"}
                        </button>
                      )}
                      {inv.activityLogId && (
                        <>
                          <button
                            onClick={() => handleAction(inv.activityLogId!, "approve")}
                            disabled={actingOn === inv.activityLogId}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                          >
                            {actingOn === inv.activityLogId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            {actingOn === inv.activityLogId ? "..." : "Approve"}
                          </button>
                          <button
                            onClick={() => handleAction(inv.activityLogId!, "dismiss")}
                            disabled={actingOn === inv.activityLogId}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-700/50 text-zinc-400 border border-zinc-600/30 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                          >
                            <X className="w-3 h-3" />
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {isExpanded && inv.metadata && (
                  <div className="px-4 pb-3">
                    <ReconciliationDetail metadata={inv.metadata as Record<string, unknown>} />
                  </div>
                )}
              </div>
            );
          })}

          {/* Unmatched invoices — no PO match; offer disregard action */}
          {rest.filter(i => i.status === "unmatched").length > 0 && (
            <div className="border-t border-rose-500/10">
              <div className="px-4 py-1.5 flex items-center gap-2 bg-rose-500/5">
                <span className="text-[10px] font-mono text-rose-400 uppercase tracking-wider font-semibold">
                  Unmatched — No PO
                </span>
                <span className="ml-auto text-[10px] font-mono text-rose-400/60">
                  {rest.filter(i => i.status === "unmatched").length} invoice{rest.filter(i => i.status === "unmatched").length !== 1 ? "s" : ""}
                </span>
              </div>
              {(() => {
                // Group unmatched invoices by vendor name for bulk actions
                const unmatched = rest.filter(i => i.status === "unmatched");
                const byVendor = new Map<string, typeof unmatched>();
                for (const inv of unmatched) {
                  const key = inv.vendorName;
                  if (!byVendor.has(key)) byVendor.set(key, []);
                  byVendor.get(key)!.push(inv);
                }
                const vendorEntries = [...byVendor.entries()];
                // Sort vendor groups by total dollar amount (descending) for priority
                vendorEntries.sort((a, b) => {
                  const sumA = a[1].reduce((s, i) => s + Number(i.total ?? 0), 0);
                  const sumB = b[1].reduce((s, i) => s + Number(i.total ?? 0), 0);
                  return sumB - sumA;
                });
                return vendorEntries.flatMap(([vendorName, vendorInvs]) => {
                  const vendorTotal = vendorInvs.reduce((s, i) => s + Number(i.total ?? 0), 0);
                  const isActingOnVendor = actingOn === `vendor:${vendorName}`;
                  const isAlsoMarkingKey = `alsoMark:${vendorName}`;
                  const alsoMarking = disregardReason[isAlsoMarkingKey] === "true";

                  return [
                    <div key={`vendor-group-${vendorName}`} className="border-t border-rose-500/20">
                      {/* Vendor group header with bulk action */}
                      <div className="px-4 py-1 flex items-center gap-2 bg-rose-500/[0.03]">
                        <span className="text-[11px] font-mono font-semibold text-rose-300 truncate max-w-[200px]">
                          {vendorName}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                          {vendorInvs.length} × ${vendorTotal.toFixed(2)}
                        </span>
                        <div className="flex-1" />
                        {vendorInvs.length >= 2 && (
                          <>
                            <label className="flex items-center gap-1 text-[9px] font-mono text-zinc-500 cursor-pointer shrink-0">
                              <input
                                type="checkbox"
                                checked={alsoMarking}
                                onChange={() => setDisregardReason(prev => ({
                                  ...prev,
                                  [isAlsoMarkingKey]: alsoMarking ? "" : "true",
                                }))}
                                className="w-2.5 h-2.5 rounded border-zinc-600 bg-zinc-800 accent-rose-500"
                              />
                              Also mark vendor profile
                            </label>
                            <button
                              onClick={() => handleDisregardVendor(vendorName, alsoMarking)}
                              disabled={isActingOnVendor}
                              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 disabled:opacity-40 transition-colors shrink-0"
                              title={`Disregard all ${vendorInvs.length} unmatched invoices from ${vendorName}`}
                            >
                              {isActingOnVendor ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              {isActingOnVendor ? "..." : "This vendor never needs a PO"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>,
                    ...vendorInvs.map(inv => {
                      const isActing = actingOn === inv.id;
                      const selReason = disregardReason[inv.id] || "";
                      return (
                        <div key={inv.id} className="flex items-start gap-2.5 px-4 py-2 border-b border-rose-500/5 hover:bg-rose-500/[0.02] transition-colors">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-rose-500" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              {vendorInvs.length === 1 && (
                                <span className="text-sm font-mono font-semibold text-zinc-100 truncate">
                                  {inv.vendorName}
                                </span>
                              )}
                              {/* source_inbox badge */}
                              {(() => {
                                const src = (inv as any).source_inbox as string | null | undefined;
                                if (!src || src === 'default') return null;
                                const isAp = src === 'ap';
                                return (
                                  <span className={`text-[9px] font-mono font-semibold px-1 py-0.5 rounded shrink-0 ${
                                    isAp
                                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                      : 'bg-zinc-600/30 text-zinc-400 border border-zinc-600/40'
                                  }`}>
                                    @{isAp ? 'ap' : src.split('@')[0]}
                                  </span>
                                );
                              })()}
                              {inv.invoiceNumber && (
                                <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                                  #{inv.invoiceNumber}
                                </span>
                              )}
                              {inv.total !== 0 && (
                                <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                                  ${Number(inv.total).toFixed(2)}
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-[var(--dash-ts)] shrink-0 ml-auto">
                                {timeAgo(inv.processedAt)}
                              </span>
                            </div>
                            {inv.classificationReason && (
                              <div className="text-[10px] font-mono text-zinc-500 truncate mt-0.5 leading-tight">
                                {inv.classificationReason}
                              </div>
                            )}
                            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                              {/* Reason selector — compact inline buttons */}
                              {(["credit_card", "service_no_po", "not_ours", "other"] as const).map(r => (
                                <button
                                  key={r}
                                  onClick={() => setDisregardReason(prev => ({ ...prev, [inv.id]: selReason === r ? "" : r }))}
                                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-medium border transition-colors ${
                                    selReason === r
                                      ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                                      : "bg-zinc-800/50 text-zinc-500 border-zinc-700/40 hover:text-zinc-300 hover:border-zinc-600/50"
                                  }`}
                                >
                                  {r === "credit_card" ? "💳 Credit Card" : r === "service_no_po" ? "🔧 Service" : r === "not_ours" ? "✋ Not Ours" : "📋 Other"}
                                </button>
                              ))}
                              <div className="flex-1" />
                              {vendorInvs.length === 1 && (
                                <button
                                  onClick={() => handleDisregard(inv.id, selReason || undefined)}
                                  disabled={isActing}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/25 hover:bg-rose-500/25 disabled:opacity-40 transition-colors"
                                  title="Mark as not a PO purchase — removes from queue"
                                >
                                  {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                  {isActing ? "..." : "Not a PO purchase"}
                                </button>
                              )}
                              {vendorInvs.length >= 2 && (
                                <button
                                  onClick={() => handleDisregard(inv.id, selReason || undefined)}
                                  disabled={isActing}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-800/50 text-zinc-500 border border-zinc-700/40 hover:text-zinc-300 hover:bg-zinc-700/50 disabled:opacity-40 transition-colors"
                                  title="Disregard this single invoice"
                                >
                                  {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                  {isActing ? "..." : "Single"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }),
                  ];
                });
              })()}
            </div>
          )}

          {/* Matched but unreconciled — has PO but no activity log; offer approve + disregard */}
          {rest.filter(i => i.status === "matched_unreconciled").length > 0 && (
            <div className="border-t border-cyan-500/10">
              <div className="px-4 py-1.5 flex items-center gap-2 bg-cyan-500/5">
                <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-wider font-semibold">
                  Matched — Awaiting Confirmation
                </span>
                <span className="ml-auto text-[10px] font-mono text-cyan-400/60">
                  {rest.filter(i => i.status === "matched_unreconciled").length} invoice{rest.filter(i => i.status === "matched_unreconciled").length !== 1 ? "s" : ""}
                </span>
              </div>
              {rest.filter(i => i.status === "matched_unreconciled").map(inv => {
                const isActing = actingOn === inv.id;
                return (
                  <div key={inv.id} className="flex items-start gap-2.5 px-4 py-2 border-b border-cyan-500/5 hover:bg-cyan-500/[0.02] transition-colors">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 bg-cyan-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-mono font-semibold text-zinc-100 truncate">
                          {inv.vendorName}
                        </span>
                        {inv.invoiceNumber && (
                          <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                            #{inv.invoiceNumber}
                          </span>
                        )}
                        {inv.poNumber && (
                          <span className="text-xs font-mono text-blue-400 shrink-0">
                            → PO {inv.poNumber}
                          </span>
                        )}
                        {inv.total !== 0 && (
                          <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                            ${Number(inv.total).toFixed(2)}
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-[var(--dash-ts)] shrink-0 ml-auto">
                          {timeAgo(inv.processedAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <span className="text-[10px] font-mono text-cyan-400/60 leading-tight">
                          PO matched but awaiting confirmation. Approve to confirm and learn, or disregard as not a PO purchase.
                        </span>
                        <div className="flex-1" />
                        <button
                          onClick={() => handleApproveUnreconciled(inv.id, inv.poNumber || "")}
                          disabled={isActing || !inv.poNumber}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                          title={`Confirm PO ${inv.poNumber} match — removes from queue and learns for future`}
                        >
                          {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          {isActing ? "..." : "Approve"}
                        </button>
                        <button
                          onClick={() => handleDisregardUnreconciled(inv.id, inv.poNumber || "")}
                          disabled={isActing || !inv.poNumber}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-700/50 text-zinc-400 border border-zinc-600/30 hover:bg-zinc-700 hover:text-zinc-300 disabled:opacity-40 transition-colors"
                          title="Mark as not a PO purchase — removes from queue"
                        >
                          {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                          {isActing ? "..." : "Dismiss"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Previously showed completed invoices with status labels; now focus on pending actions only */}
        </>
      )}
    </div>
  );
}
