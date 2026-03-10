"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { Calendar, AlertTriangle, CheckCircle2, ChevronDown } from "lucide-react";

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

type Completion = {
  id: string;
  build_id: string;
  sku: string;
  quantity: number;
  completed_at: string;   // e.g. "Mar 3 2026 11:12:41 am"
  created_at: string;
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

/** Parse Finale's "Mar 3 2026 11:12:41 am" timestamp into a short local time string */
function fmtCompletedAt(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Denver",
  });
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="px-4 py-2 bg-zinc-900/40 border-y border-zinc-800/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur-md">
      <span className="text-[12px] font-mono font-semibold text-zinc-300 uppercase tracking-widest">{label}</span>
      {count !== undefined && (
        <span className="text-[10px] font-mono text-zinc-600 border border-zinc-800 px-1.5 py-0.5 rounded-full">{count} ITEMS</span>
      )}
    </div>
  );
}

function FulfillmentBadge({ scheduledQty, actualQty }: { scheduledQty: number; actualQty: number }) {
  const pct = scheduledQty > 0 ? Math.round((actualQty / scheduledQty) * 100) : null;
  if (pct === null) return null;
  const color = pct >= 90 ? "text-emerald-400 border-emerald-500/30"
    : pct >= 70 ? "text-amber-400 border-amber-500/30"
      : "text-rose-400 border-rose-500/30";
  return (
    <span className={`text-[10px] font-mono border px-1 py-0.5 rounded ${color}`}>
      {actualQty.toLocaleString()}/{scheduledQty.toLocaleString()} ({pct}%)
    </span>
  );
}

function BuildRow({ b, risk, completed }: { b: Build; risk: string; completed?: Completion }) {
  const desc = b.originalEvent
    ? b.originalEvent.replace(/^\d+\s*(x\s*)?(bags?|units?|lbs?|of\s+)?/i, "").trim().slice(0, 45) || null
    : null;

  const dot = completed ? "bg-emerald-500" : RISK_DOT[risk];
  const showRisk = !completed && risk !== "OK";

  return (
    <div className="px-4 py-2.5 border-b border-zinc-800/20 hover:bg-zinc-800/30 transition-colors">
      <div className="flex items-center gap-3">
        {/* Color-coded dot: emerald=done, rose=critical, amber=warning, blue=watch, zinc=ok */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <div className="min-w-0 flex-1 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-mono font-semibold text-zinc-100 truncate">{b.sku}</span>
            <span className="text-[10px] font-mono px-1 border border-zinc-700 bg-zinc-800 text-zinc-400 rounded shrink-0">{b.designation}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {completed && (
              <span className="text-[10px] font-mono text-emerald-400">
                ✓ {fmtCompletedAt(completed.completed_at)}
              </span>
            )}
            {/* Scheduled vs Actual fulfillment badge */}
            {completed && (
              <FulfillmentBadge scheduledQty={b.quantity} actualQty={completed.quantity} />
            )}
            {showRisk && (
              <span className={`text-[10px] font-mono font-bold ${RISK_TEXT[risk]}`}>{risk}</span>
            )}
            {/* Show scheduled qty when not yet completed, actual qty when done */}
            {!completed && (
              <span className="text-sm font-mono text-emerald-400">×{b.quantity.toLocaleString()}</span>
            )}
          </div>
        </div>
      </div>
      {desc && (
        <div className="text-[11px] text-zinc-600 truncate mt-0.5 pl-5">{desc}</div>
      )}
    </div>
  );
}

function CompletionRow({ c, noCalEvent }: { c: Completion; noCalEvent?: boolean }) {
  return (
    <div className="px-4 py-2.5 border-b border-zinc-800/20 hover:bg-zinc-800/30 transition-colors">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full shrink-0 bg-emerald-500" />
        <div className="min-w-0 flex-1 flex items-center justify-between">
          <span className="text-sm font-mono font-semibold text-zinc-200 truncate">{c.sku}</span>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[10px] font-mono text-emerald-400">✓ {fmtCompletedAt(c.completed_at)}</span>
            <span className="text-sm font-mono text-zinc-400">×{c.quantity.toLocaleString()}</span>
            {noCalEvent && <span className="text-[10px] font-mono text-zinc-600 italic">no cal event</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BuildSchedulePanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loading, setLoading] = useState(true);

  // Collapse state — persisted to localStorage
  const [isCollapsed, setIsCollapsed] = useState(false);
  useEffect(() => {
    const s = localStorage.getItem("aria-dash-schedule-collapsed");
    if (s === "true") setIsCollapsed(true);
  }, []);
  useEffect(() => { localStorage.setItem("aria-dash-schedule-collapsed", String(isCollapsed)); }, [isCollapsed]);

  useEffect(() => {
    const supabase = createBrowserClient();

    // Load latest risk snapshot
    supabase
      .from("build_risk_snapshots")
      .select("id,generated_at,builds,components")
      .order("generated_at", { ascending: false })
      .limit(1)
      .then((res: { data: Snapshot[] | null }) => {
        if (res.data && res.data.length > 0) setSnapshot(res.data[0]);
        setLoading(false);
      });

    // Load completions from last 7 days
    const since = new Date();
    since.setDate(since.getDate() - 7);
    supabase
      .from("build_completions")
      .select("id,build_id,sku,quantity,completed_at,created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(50)
      .then((res: { data: Completion[] | null }) => {
        if (res.data) setCompletions(res.data);
      });

    // Real-time: new risk snapshot
    const subSnap = supabase
      .channel("build_schedule_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "build_risk_snapshots" },
        (p: any) => setSnapshot(p.new as Snapshot))
      .subscribe();

    // Real-time: new completion
    const subComp = supabase
      .channel("build_completions_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "build_completions" },
        (p: any) => setCompletions(prev => [p.new as Completion, ...prev].slice(0, 50)))
      .subscribe();

    return () => {
      supabase.removeChannel(subSnap);
      supabase.removeChannel(subComp);
    };
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

  // Quick lookup: sku → most recent completion
  const completionBySku = new Map<string, Completion>();
  for (const c of completions) {
    if (!completionBySku.has(c.sku)) completionBySku.set(c.sku, c);
  }

  // Today's completions that have NO matching calendar build (direct Finale builds not on calendar)
  const today = new Date().toISOString().slice(0, 10);
  const allBuilds = snapshot?.builds ?? [];
  const calendarSkus = new Set(allBuilds.map(b => b.sku));

  const todayCompletions = completions.filter(c => {
    const d = new Date(c.completed_at);
    return d.toISOString().slice(0, 10) === today;
  });

  const atRiskComponents = snapshot
    ? Object.values(snapshot.components).filter(c => c.riskLevel !== "OK")
    : [];

  // Group into unified timeline by date
  const timelineMap = new Map<string, { builds: Build[]; stockouts: ComponentRisk[] }>();
  function getDayEntry(dateStr: string) {
    if (!timelineMap.has(dateStr)) timelineMap.set(dateStr, { builds: [], stockouts: [] });
    return timelineMap.get(dateStr)!;
  }
  allBuilds.forEach(b => {
    const comp = completionBySku.get(b.sku);
    if (comp) {
      const isToday = new Date(comp.completed_at).toISOString().slice(0, 10) === today;
      if (isToday) return; // Pulled out into the Completed Today section
    }
    getDayEntry(b.buildDate).builds.push(b);
  });
  atRiskComponents.forEach(c => {
    if (c.stockoutDays !== null && c.stockoutDays >= 0) {
      const d = new Date(today + "T12:00:00");
      d.setDate(d.getDate() + c.stockoutDays);
      getDayEntry(d.toISOString().slice(0, 10)).stockouts.push(c);
    }
  });

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
          {todayCompletions.length > 0 && (
            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
              ● {todayCompletions.length} done today
            </span>
          )}
          {snapshot && (
            <span className="text-[10px] text-[var(--dash-ts)] font-mono">{timeAgo(snapshot.generated_at)}</span>
          )}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "rotate-180" : ""}`} />
          </button>
        </div>
      </header>

      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800/50 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-700/80 [&::-webkit-scrollbar-thumb]:rounded-full">

          {loading && (
            <div className="px-4 py-2 space-y-2.5">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full skeleton-shimmer shrink-0" />
                  <div className="skeleton-shimmer h-3.5" style={{ width: `${40 + i * 15}%` }} />
                  <div className="skeleton-shimmer h-3 w-12 ml-auto" />
                </div>
              ))}
            </div>
          )}

          {/* ── Completed Today ── */}
          {todayCompletions.length > 0 && (
            <details className="group" open>
              <summary className="px-4 py-2 bg-emerald-500/5 border-y border-emerald-500/20 flex items-center gap-2 sticky top-0 z-10 backdrop-blur-md cursor-pointer list-none marker:hidden hover:bg-emerald-500/10 transition-colors">
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                <span className="text-[12px] font-mono font-semibold text-emerald-400 uppercase tracking-widest">Completed Today</span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-[10px] font-mono text-emerald-600 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">{todayCompletions.length} BUILDS</span>
                  <ChevronDown className="w-3.5 h-3.5 text-emerald-500/50 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div>
                {todayCompletions.map(c => {
                  const build = allBuilds.find(b => b.sku === c.sku);
                  if (build) {
                    return <BuildRow key={`b-${c.id}`} b={build} risk="OK" completed={c} />;
                  } else {
                    return <CompletionRow key={`c-${c.id}`} c={c} noCalEvent />;
                  }
                })}
              </div>
            </details>
          )}

          {!loading && !snapshot && (
            <div className="px-4 py-3">
              <span className="text-xs font-mono text-zinc-700">No data — run /buildrisk or wait for 7:30 AM</span>
            </div>
          )}

          {/* ── Upcoming Timeline ── */}
          {upcomingDates.map(date => {
            const { builds, stockouts } = timelineMap.get(date)!;
            builds.sort((a, b) => a.designation.localeCompare(b.designation));

            return (
              <section key={date} className="mb-0">
                <SectionHeader label={fmtDateLabel(date)} count={builds.length + stockouts.length} />

                {/* Builds — dot is emerald if completed, else risk color */}
                {builds.map((b, i) => (
                  <BuildRow
                    key={`b-${i}`}
                    b={b}
                    risk={buildRisk(b.sku)}
                    completed={completionBySku.get(b.sku)}
                  />
                ))}

                {/* Stockout warnings */}
                {stockouts.map(comp => (
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
                ))}
              </section>
            );
          })}

          {/* ── Past Builds — dot color reflects whether completed is confirmed ── */}
          {pastDates.length > 0 && (
            <details className="group">
              <summary className="px-4 py-2 bg-zinc-900/20 text-xs font-mono text-zinc-600 cursor-pointer hover:text-zinc-400 select-none list-none marker:hidden">
                <span className="group-open:hidden">▶ Show Past Builds</span>
                <span className="hidden group-open:inline">▼ Hide Past Builds</span>
              </summary>
              {pastDates.map(date => {
                const { builds } = timelineMap.get(date)!;
                return (
                  <section key={date} className="opacity-60">
                    <SectionHeader label={fmtDateLabel(date)} />
                    {builds.map((b, i) => (
                      <BuildRow
                        key={`b-${i}`}
                        b={b}
                        risk="OK"
                        completed={completionBySku.get(b.sku)}
                      />
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
      )}
    </div>
  );
}
