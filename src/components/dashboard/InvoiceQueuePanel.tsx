"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { Receipt } from "lucide-react";

type LogEntry = {
  id: string;
  created_at: string;
  email_from: string;
  email_subject: string;
  intent: string;
  action_taken: string;
  metadata: any;
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function vendorName(from: string): string {
  // Extract display name from "Vendor Name <email@domain.com>" or just use email
  const m = from.match(/^([^<]+?)\s*</);
  if (m) return m[1].trim();
  return from.replace(/@.*/, "");
}

type Status = "matched" | "pending" | "unmatched" | "forwarded" | "junk";

function classify(log: LogEntry): Status {
  const a = log.action_taken.toLowerCase();
  if (log.intent === "ADVERTISEMENT" || a.includes("archived") || a.includes("ignored")) return "junk";
  if (a.includes("pending") || a.includes("flagged") || a.includes("review") || a.includes("approval")) return "pending";
  if (a.includes("applied") || a.includes("reconcil") || a.includes("matched")) return "matched";
  if (a.includes("forwarded") || a.includes("bill.com")) return "forwarded";
  if (a.includes("no match") || a.includes("unmatched") || a.includes("dropship")) return "unmatched";
  return "forwarded";
}

const STATUS_CFG: Record<Status, { dot: string; label: string; text: string }> = {
  matched:   { dot: "bg-emerald-500", label: "MATCHED",   text: "text-emerald-400" },
  pending:   { dot: "bg-amber-400",   label: "PENDING",   text: "text-amber-300" },
  unmatched: { dot: "bg-rose-500",    label: "NO MATCH",  text: "text-rose-300" },
  forwarded: { dot: "bg-blue-400",    label: "FWDED",     text: "text-blue-300" },
  junk:      { dot: "bg-zinc-700",    label: "JUNK",      text: "text-zinc-600" },
};

export default function InvoiceQueuePanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createBrowserClient();

    supabase
      .from("ap_activity_log")
      .select("*")
      .in("intent", ["INVOICE", "STATEMENT", "HUMAN_INTERACTION"])
      .order("created_at", { ascending: false })
      .limit(30)
      .then((res: { data: LogEntry[] | null }) => {
        if (res.data) setLogs(res.data);
        setLoading(false);
      });

    const sub = supabase
      .channel("invoice_queue_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ap_activity_log" },
        (p: any) => {
          const entry = p.new as LogEntry;
          if (["INVOICE", "STATEMENT", "HUMAN_INTERACTION"].includes(entry.intent)) {
            setLogs(cur => [entry, ...cur].slice(0, 30));
          }
        })
      .subscribe();

    return () => { supabase.removeChannel(sub); };
  }, []);

  const pending = logs.filter(l => classify(l) === "pending");
  const rest    = logs.filter(l => classify(l) !== "pending" && classify(l) !== "junk");

  return (
    <div className="border-b border-zinc-800 shrink-0">
      {/* Header */}
      <div className="px-4 py-2 flex items-center gap-2 bg-zinc-900/50">
        <Receipt className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-xs font-mono font-semibold text-zinc-400 uppercase tracking-widest">AP / Invoices</span>
        <div className="flex-1" />
        {pending.length > 0 && (
          <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded border bg-amber-500/20 text-amber-300 border-amber-500/40">
            {pending.length} PENDING
          </span>
        )}
        {!loading && pending.length === 0 && (
          <span className="text-xs font-mono text-zinc-600">all clear</span>
        )}
      </div>

      {loading && (
        <div className="px-4 py-2 flex items-center gap-2 text-zinc-700">
          <div className="w-3 h-3 border border-zinc-700 border-t-transparent rounded-full animate-spin shrink-0" />
          <span className="text-xs font-mono">Loading…</span>
        </div>
      )}

      {/* Pending first — always visible */}
      {pending.map(log => {
        const cfg = STATUS_CFG.pending;
        const poId = log.metadata?.orderId;
        return (
          <div key={log.id} className="flex items-start gap-2.5 px-4 py-2 border-b border-amber-500/10 bg-amber-500/5">
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot} animate-pulse`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-mono font-semibold text-zinc-100 truncate">{vendorName(log.email_from)}</span>
                {poId && <span className="text-xs font-mono text-blue-400 shrink-0">→ PO {poId}</span>}
                <span className="text-[10px] font-mono text-zinc-600 shrink-0 ml-auto">{timeAgo(log.created_at)}</span>
              </div>
              <div className="text-xs text-amber-300/70 truncate mt-0.5">{log.action_taken}</div>
            </div>
          </div>
        );
      })}

      {/* Recent matched / forwarded — capped scroll */}
      {rest.length > 0 && (
        <div className="max-h-[160px] overflow-y-auto">
          {rest.slice(0, 15).map(log => {
            const status = classify(log);
            const cfg = STATUS_CFG[status];
            const poId = log.metadata?.orderId;
            if (status === "junk") return null;
            return (
              <div key={log.id} className="flex items-center gap-2.5 px-4 py-1.5 border-b border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                <span className="text-xs font-mono text-zinc-300 truncate flex-1">{vendorName(log.email_from)}</span>
                {poId && <span className="text-[10px] font-mono text-blue-400/60 shrink-0">PO {poId}</span>}
                <span className={`text-[10px] font-mono font-semibold shrink-0 ${cfg.text}`}>{cfg.label}</span>
                <span className="text-[10px] font-mono text-zinc-700 shrink-0 w-6 text-right">{timeAgo(log.created_at)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
