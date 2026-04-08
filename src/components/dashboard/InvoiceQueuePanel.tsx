"use client";

import React from "react";
import { useEffect, useState, useCallback } from "react";
import { Receipt, ChevronDown, Check, X, AlertCircle } from "lucide-react";
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

type StatusKey = "auto_approved" | "needs_approval" | "rejected" | "duplicate" | "unmatched";

const STATUS_CFG: Record<StatusKey, { dot: string; label: string; pulse: boolean }> = {
  auto_approved: { dot: "bg-emerald-500", label: "AUTO", pulse: false },
  needs_approval: { dot: "bg-amber-400", label: "PENDING", pulse: true },
  rejected: { dot: "bg-red-500", label: "REJECT", pulse: false },
  duplicate: { dot: "bg-zinc-600", label: "DUP", pulse: false },
  unmatched: { dot: "bg-rose-500", label: "NO PO", pulse: false },
};

function statusCfg(status: string) {
  return STATUS_CFG[status as StatusKey] ?? { dot: "bg-zinc-600", label: status.toUpperCase(), pulse: false };
}

// ── Guidance ──────────────────────────────────────────────────────────────────

function pendingGuidance(inv: InvoiceQueueItem): { text: string; suggestion: "approve" | "dismiss" | "review" } {
  const v = inv.vendorName.toLowerCase();
  const num = (inv.invoiceNumber ?? "").toLowerCase();
  const impact = Math.abs(inv.dollarImpact ?? 0);

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

  // Handle approve/dismiss actions
  const handleAction = useCallback(async (id: string, action: "approve" | "dismiss") => {
    setActingOn(id);
    try {
      const res = await fetch("/api/dashboard/reconciliation-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityLogId: id, action }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("Action failed:", data.error);
      }
    } catch (err) {
      console.error("Action error:", err);
    } finally {
      setActingOn(null);
      fetchData(true); // bust cache and refresh
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
    const url = bust
      ? "/api/dashboard/invoice-queue?bust=1"
      : "/api/dashboard/invoice-queue";
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
  const pending = invoices.filter(i => i.status === "needs_approval");
  const rest = invoices.filter(i => i.status !== "needs_approval");

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

        {/* CSV export — only when expanded */}
        {!isCollapsed && (
          <button
            onClick={() => window.open("/api/dashboard/invoice-queue?export=1", "_blank")}
            className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors mr-1"
          >
            export
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
            return (
              <div
                key={inv.id}
                className="flex items-start gap-2.5 px-4 py-2 border-b border-amber-500/10 bg-amber-500/5 border-l-2"
                style={{ borderLeftColor: "var(--dash-accent-pending)" }}
              >
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} animate-pulse`} />
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
                    {inv.activityLogId && (
                      <>
                        <button
                          onClick={() => handleAction(inv.activityLogId!, "approve")}
                          disabled={actingOn === inv.activityLogId}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors"
                        >
                          <Check className="w-3 h-3" />
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
            );
          })}

           {/* Removed status-heavy log section for action-first focus */}
           {/* Previously showed completed invoices with status labels; now focus on pending actions only */}
        </>
      )}
    </div>
  );
}
