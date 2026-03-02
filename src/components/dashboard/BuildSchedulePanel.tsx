"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { Calendar, AlertTriangle } from "lucide-react";

type Build = {
  sku: string;
  quantity: number;
  buildDate: string;
  originalEvent: string;
  confidence: number;
  designation: "SOIL" | "MFG";
};

type ComponentRisk = {
  componentSku: string;
  stockoutDays: number | null;
  incomingPOs: any[];
  usedIn: string[];
  riskLevel: "CRITICAL" | "WARNING" | "WATCH" | "OK";
};

type Snapshot = {
  id: string;
  generated_at: string;
  builds: Build[];
  components: Record<string, ComponentRisk>;
};

const RISK_ORDER = { CRITICAL: 0, WARNING: 1, WATCH: 2, OK: 3 };
const RISK_DOT: Record<string, string> = {
  CRITICAL: "bg-rose-500",
  WARNING: "bg-amber-400",
  WATCH: "bg-blue-400",
  OK: "bg-zinc-600",
};
const RISK_TEXT: Record<string, string> = {
  CRITICAL: "text-rose-300",
  WARNING: "text-amber-300",
  WATCH: "text-blue-300",
  OK: "text-zinc-500",
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDateLabel(s: string): string {
  const d = new Date(s + "T12:00:00");
  if (isNaN(d.getTime())) return s;
  const today = new Date();
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  const shortDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (diff === 0) return `Today · ${shortDate}`;
  if (diff === 1) return `Tomorrow · ${shortDate}`;
  if (diff < 0) return `${shortDate} (Past)`;
  if (diff <= 6) return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="px-4 py-2 bg-zinc-900/40 border-y border-zinc-800/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md">
      <span className="text-[12px] font-mono font-semibold text-zinc-300 uppercase tracking-widest">{label}</span>
      {count !== undefined && <span className="text-[10px] font-mono text-zinc-600 border border-zinc-800 px-1.5 py-0.5 rounded-full">{count} ITEMS</span>}
    </div>
  );
}

function BuildRow({ b, risk }: { b: Build; risk: string }) {
  // Brief description from calendar event name — strip leading qty/unit patterns
  const desc = b.originalEvent
    ? b.originalEvent.replace(/^\d+\s*(x\s*)?(bags?|units?|lbs?|of\s+)?/i, "").trim().slice(0, 45) || null
    : null;
  return (
    <div className="px-4 py-2.5 border-b border-zinc-800/20 hover:bg-zinc-800/30 transition-colors">
      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full shrink-0 ${RISK_DOT[risk]}`} />
        <div className="min-w-0 flex-1 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-mono font-semibold text-zinc-100 truncate">{b.sku}</span>
            <span className="text-[10px] font-mono px-1 border border-zinc-700 bg-zinc-800 text-zinc-400 rounded shrink-0">{b.designation}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {risk !== "OK" && (
              <span className={`text-[10px] font-mono font-bold ${RISK_TEXT[risk]}`}>{risk}</span>
            )}
            <span className="text-sm font-mono text-emerald-400">×{b.quantity.toLocaleString()}</span>
          </div>
        </div>
      </div>
      {desc && (
        <div className="text-[11px] text-zinc-600 truncate mt-0.5 pl-5">{desc}</div>
      )}
    </div>
  );
}

export default function BuildSchedulePanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createBrowserClient();

    supabase
      .from("build_risk_snapshots")
      .select("id,generated_at,builds,components")
      .order("generated_at", { ascending: false })
      .limit(1)
      .then((res: { data: Snapshot[] | null }) => {
        if (res.data && res.data.length > 0) setSnapshot(res.data[0]);
        setLoading(false);
      });

    const sub = supabase
      .channel("build_schedule_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "build_risk_snapshots" },
        (p: any) => setSnapshot(p.new as Snapshot))
      .subscribe();

    return () => { supabase.removeChannel(sub); };
  }, []);

  // Worst risk level among components that reference this build SKU
  const buildRisk = (buildSku: string): string => {
    if (!snapshot) return "OK";
    let worst = "OK";
    for (const comp of Object.values(snapshot.components)) {
      if (comp.usedIn.includes(buildSku) && RISK_ORDER[comp.riskLevel] < RISK_ORDER[worst as keyof typeof RISK_ORDER]) {
        worst = comp.riskLevel;
      }
    }
    return worst;
  };

  const today = new Date().toISOString().slice(0, 10);
  const allBuilds = snapshot?.builds ?? [];

  const atRiskComponents = snapshot
    ? Object.values(snapshot.components)
      .filter(c => c.riskLevel !== "OK")
    : [];

  // Group everything into a unified timeline by date
  const timelineMap = new Map<string, { builds: Build[], stockouts: ComponentRisk[] }>();

  function getDayEntry(dateStr: string) {
    if (!timelineMap.has(dateStr)) {
      timelineMap.set(dateStr, { builds: [], stockouts: [] });
    }
    return timelineMap.get(dateStr)!;
  }

  // Add builds to timeline
  allBuilds.forEach(b => {
    getDayEntry(b.buildDate).builds.push(b);
  });

  // Add stockouts to timeline
  atRiskComponents.forEach(c => {
    if (c.stockoutDays !== null && c.stockoutDays >= 0) {
      const d = new Date(today + "T12:00:00");
      d.setDate(d.getDate() + c.stockoutDays);
      const stockoutDate = d.toISOString().slice(0, 10);
      getDayEntry(stockoutDate).stockouts.push(c);
    }
  });

  // Sort dates (we can separate past from upcoming)
  const sortedDates = Array.from(timelineMap.keys()).sort();
  const pastDates = sortedDates.filter(d => d < today);
  const upcomingDates = sortedDates.filter(d => d >= today);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <header className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">Build Schedule</span>
        </div>
        <div className="flex items-center gap-3">
          {snapshot && (
            <span className="text-xs text-zinc-700">{timeAgo(snapshot.generated_at)}</span>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full">

        {loading && (
          <div className="px-4 py-3 flex items-center gap-2 text-zinc-700">
            <div className="w-3 h-3 border border-zinc-700 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-xs font-mono">Loading…</span>
          </div>
        )}

        {!loading && !snapshot && (
          <div className="px-4 py-3">
            <span className="text-xs font-mono text-zinc-700">No data — run /buildrisk or wait for 7:30 AM</span>
          </div>
        )}

        {/* ── Upcoming Timeline ── */}
        {upcomingDates.map(date => {
          const { builds, stockouts } = timelineMap.get(date)!;
          // sort builds: SOIL first, then MFG
          builds.sort((a, b) => a.designation.localeCompare(b.designation));

          return (
            <section key={date} className="mb-0">
              <SectionHeader label={fmtDateLabel(date)} count={builds.length + stockouts.length} />

              {/* Builds */}
              {builds.map((b, i) => (
                <BuildRow key={`b-${i}`} b={b} risk={buildRisk(b.sku)} />
              ))}

              {/* Stockouts */}
              {stockouts.map(comp => {
                const cfg = RISK_TEXT[comp.riskLevel] || "text-zinc-500";
                return (
                  <div key={`s-${comp.componentSku}`} className="px-4 py-2 border-b border-zinc-800/20 bg-rose-500/[0.02] border-l-2 border-l-rose-500/30 flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-3 h-3 text-rose-500/70 shrink-0" />
                      <span className="text-xs font-mono font-semibold text-rose-300">
                        {comp.componentSku} runs out
                      </span>
                      {comp.incomingPOs.length > 0 && (
                        <span className="text-[10px] font-mono text-emerald-500 ml-auto border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 rounded">
                          {comp.incomingPOs.length} PO{comp.incomingPOs.length > 1 ? "s" : ""} incoming
                        </span>
                      )}
                    </div>
                    {comp.usedIn.length > 0 && (
                      <span className="text-[10px] font-mono text-zinc-500 pl-5">
                        Builds impacted: {comp.usedIn.slice(0, 3).join(", ")}
                        {comp.usedIn.length > 3 && ` +${comp.usedIn.length - 3}`}
                      </span>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}

        {/* ── Past Timeline ── */}
        {pastDates.length > 0 && (
          <details className="group">
            <summary className="px-4 py-2 bg-zinc-900/20 text-xs font-mono text-zinc-600 cursor-pointer hover:text-zinc-400 select-none list-none marker:hidden">
              <span className="group-open:hidden">▶ Show Past Builds</span>
              <span className="hidden group-open:inline">▼ Hide Past Builds</span>
            </summary>
            {pastDates.map(date => {
              const { builds } = timelineMap.get(date)!;
              return (
                <section key={date} className="opacity-50">
                  <SectionHeader label={fmtDateLabel(date)} />
                  {builds.map((b, i) => (
                    <BuildRow key={`b-${i}`} b={b} risk="OK" />
                  ))}
                </section>
              );
            })}
          </details>
        )}

        {snapshot && sortedDates.length === 0 && (
          <div className="px-4 py-3">
            <span className="text-xs font-mono text-zinc-700">No scheduled builds or component stockouts on the horizon.</span>
          </div>
        )}
      </div>
    </div>
  );
}
