"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { TrendingDown, ChevronDown } from "lucide-react";

type ComponentRisk = {
  componentSku: string;
  stockoutDays: number | null;
  incomingPOs: any[];
  usedIn: string[];
  designations: string[];
  riskLevel: "CRITICAL" | "WARNING" | "WATCH" | "OK";
};

type Snapshot = {
  id: string;
  generated_at: string;
  critical_count: number;
  warning_count: number;
  watch_count: number;
  ok_count: number;
  components: Record<string, ComponentRisk>;
};

// DECISION(2026-03-10): Badge hierarchy reform — only CRITICAL gets a filled pill.
const RISK = {
  CRITICAL: { badge: "bg-rose-500/20 text-rose-300 border-rose-500/40", dot: "bg-rose-500", order: 0 },
  WARNING: { badge: "text-amber-400", dot: "bg-amber-400", order: 1 },
  WATCH: { badge: "text-blue-400", dot: "bg-blue-400", order: 2 },
  OK: { badge: "", dot: "", order: 3 },
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function BuildRiskPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

  // Collapse state — persisted to localStorage
  const [isCollapsed, setIsCollapsed] = useState(false);
  useEffect(() => {
    const s = localStorage.getItem("aria-dash-risk-collapsed");
    if (s === "true") setIsCollapsed(true);
  }, []);
  useEffect(() => { localStorage.setItem("aria-dash-risk-collapsed", String(isCollapsed)); }, [isCollapsed]);

  // Resizable height — persisted to localStorage
  const [bodyHeight, setBodyHeight] = useState(160);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    const s = localStorage.getItem("aria-dash-risk-h");
    if (s) setBodyHeight(Math.max(60, Math.min(500, parseInt(s))));
  }, []);
  useEffect(() => { localStorage.setItem("aria-dash-risk-h", String(bodyHeight)); }, [bodyHeight]);
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: bodyHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientY - dragRef.current.startY;
      setBodyHeight(Math.max(60, Math.min(500, dragRef.current.startH + delta)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [bodyHeight]);

  useEffect(() => {
    const supabase = createBrowserClient();

    supabase
      .from("build_risk_snapshots")
      .select("*")
      .order("generated_at", { ascending: false })
      .limit(1)
      .then((res: { data: Snapshot[] | null }) => {
        if (res.data && res.data.length > 0) setSnapshot(res.data[0]);
        setLoading(false);
      });

    const sub = supabase
      .channel("build_risk_snapshots_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "build_risk_snapshots" },
        (p: any) => setSnapshot(p.new as Snapshot))
      .subscribe();

    return () => { supabase.removeChannel(sub); };
  }, []);

  const atRisk = snapshot
    ? Object.values(snapshot.components)
      .filter(c => c.riskLevel !== "OK")
      .sort((a, b) => RISK[a.riskLevel].order - RISK[b.riskLevel].order)
    : [];

  return (
    <div className="border-b border-zinc-800 shrink-0">
      {/* Section header */}
      <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50 border-b border-zinc-800/60">
        <TrendingDown className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Build Risk</span>
        {snapshot && <span className="text-[10px] text-[var(--dash-ts)] font-mono">{timeAgo(snapshot.generated_at)}</span>}
        <div className="flex-1" />
        {snapshot && (
          <div className="flex items-center gap-1.5">
            {snapshot.critical_count > 0 && (
              <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-rose-500/20 text-rose-300 border-rose-500/40">
                {snapshot.critical_count} CRIT
              </span>
            )}
            {snapshot.warning_count > 0 && (
              <span className="text-xs font-mono text-amber-400">
                {snapshot.warning_count} WARN
              </span>
            )}
            {snapshot.watch_count > 0 && (
              <span className="text-xs font-mono text-blue-400">
                {snapshot.watch_count} WATCH
              </span>
            )}
            <span className="text-xs font-mono text-[var(--dash-l3)]">
              {snapshot.ok_count} OK
            </span>
          </div>
        )}
        {!loading && !snapshot && (
          <span className="text-xs text-zinc-700">run /buildrisk</span>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Component rows */}
      {!isCollapsed && atRisk.length > 0 && (
        <>
          <div
            className="overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full border-t border-zinc-800/60"
            style={{ height: bodyHeight }}
          >
            {atRisk.map(comp => {
              const cfg = RISK[comp.riskLevel];
              return (
                <div key={comp.componentSku} className="flex items-start gap-3 px-4 py-2 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
                  {/* Risk dot */}
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
                  <div className="min-w-0">
                    {/* Line 1: SKU + stockout + POs */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono font-semibold text-zinc-100">{comp.componentSku}</span>
                      <span className={`text-[11px] font-mono ${comp.riskLevel === "CRITICAL" ? `px-1.5 py-0.5 rounded border ${cfg.badge}` : cfg.badge}`}>
                        {comp.riskLevel}
                      </span>
                      <span className="text-xs text-[var(--dash-l2)]">
                        {comp.stockoutDays !== null ? `${comp.stockoutDays}d` : "no data"}
                      </span>
                      {comp.incomingPOs.length > 0 && (
                        <span className="text-xs text-zinc-600">
                          {comp.incomingPOs.length} PO{comp.incomingPOs.length > 1 ? "s" : ""} in
                        </span>
                      )}
                    </div>
                    {/* Line 2: used in */}
                    {comp.usedIn.length > 0 && (
                      <div className="mt-0.5 text-xs text-[var(--dash-l3)]">
                        {comp.usedIn.slice(0, 4).join("  ·  ")}
                        {comp.usedIn.length > 4 && <span> +{comp.usedIn.length - 4}</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={startResize}
            className="h-1.5 cursor-ns-resize bg-zinc-900 hover:bg-zinc-700 transition-colors border-t border-zinc-800/60"
            title="Drag to resize"
          />
        </>
      )}
    </div>
  );
}
