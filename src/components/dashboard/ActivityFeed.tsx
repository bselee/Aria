"use client";

import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { ExternalLink, FileText, CheckCircle2, AlertCircle, Trash2, Webhook, BotMessageSquare } from "lucide-react";

type ActivityLog = {
    id: string;
    created_at: string;
    email_from: string;
    email_subject: string;
    intent: string;
    action_taken: string;
    metadata: any;
};

export default function ActivityFeed() {
    const [logs, setLogs] = useState<ActivityLog[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const supabase = createBrowserClient();

        // Initial fetch
        const fetchLogs = async () => {
            const { data, error } = await supabase
                .from("ap_activity_log")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(50);

            if (data) setLogs(data);
            setLoading(false);
        };

        fetchLogs();

        // Subscribe to real-time changes
        const subscription = supabase
            .channel("ap_activity_log_changes")
            .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "ap_activity_log" },
                (payload: any) => {
                    setLogs((current) => [payload.new as ActivityLog, ...current].slice(0, 50));
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(subscription);
        };
    }, []);

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
                <div className="w-6 h-6 border-2 border-neon-blue border-t-transparent rounded-full animate-spin mb-4" />
                <p className="font-mono text-sm tracking-widest uppercase">Initializing Secure Feed...</p>
            </div>
        );
    }

    return (
        <div className="space-y-6 relative before:absolute before:inset-0 before:ml-4 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-zinc-800 before:to-transparent">
            {logs.map((log) => {
                // Determine styling based on intent and action
                let dotColor = "bg-zinc-700 ring-zinc-900";
                let Icon = BotMessageSquare;

                const isError = log.action_taken.toLowerCase().includes("failed") || log.action_taken.toLowerCase().includes("error");
                const needsReview = log.action_taken.toLowerCase().includes("review") || log.action_taken.toLowerCase().includes("flagged");
                const isSuccess = log.action_taken.toLowerCase().includes("applied") || log.intent === "RECONCILIATION";
                const isJunk = log.intent === "ADVERTISEMENT" || log.action_taken.toLowerCase().includes("archived");

                if (isError) {
                    dotColor = "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (needsReview) {
                    dotColor = "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)] ring-zinc-900";
                    Icon = AlertCircle;
                } else if (isSuccess) {
                    dotColor = "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] ring-zinc-900";
                    Icon = CheckCircle2;
                } else if (isJunk) {
                    dotColor = "bg-zinc-600 ring-zinc-900 opacity-50";
                    Icon = Trash2;
                } else {
                    dotColor = "bg-neon-blue shadow-[0_0_10px_rgba(59,130,246,0.5)] ring-zinc-900";
                    Icon = Webhook;
                }

                const date = new Date(log.created_at);
                const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                return (
                    <div key={log.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group transition-all duration-300">
                        {/* Timeline Dot */}
                        <div className="flex items-center justify-center w-8 h-8 rounded-full border-4 border-[#09090b] bg-zinc-800 absolute left-0 md:left-1/2 -translate-x-1/2 shrink-0 shadow-lg z-10 transition-transform group-hover:scale-110">
                            <div className={`w-2 h-2 rounded-full ${dotColor}`} />
                        </div>

                        {/* Content Card */}
                        <div className={`w-[calc(100%-3rem)] md:w-[calc(50%-2rem)] ${isJunk ? 'opacity-60' : ''}`}>
                            <div className="p-4 rounded-xl bg-zinc-900/40 backdrop-blur-sm border border-zinc-800/60 hover:border-zinc-700 hover:bg-zinc-900/60 transition-all duration-300">
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex items-center gap-2">
                                        <Icon className={`w-4 h-4 ${isError ? 'text-rose-400' : needsReview ? 'text-amber-400' : isSuccess ? 'text-emerald-400' : isJunk ? 'text-zinc-500' : 'text-neon-blue'}`} />
                                        <span className="text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">{log.intent}</span>
                                    </div>
                                    <span className="text-xs font-mono text-zinc-500">{timeString}</span>
                                </div>

                                <h3 className="text-sm font-semibold text-zinc-200 mb-1 leading-snug">{log.action_taken}</h3>
                                <p className="text-xs text-zinc-400 truncate" title={log.email_subject}>{log.email_subject}</p>

                                {/* Actionable Ghost Buttons */}
                                {log.metadata && (
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        {log.metadata.orderId && (
                                            <button className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-neon-blue/10 text-neon-blue border border-neon-blue/20 hover:bg-neon-blue/20 transition-colors">
                                                <ExternalLink className="w-3 h-3" />
                                                PO {log.metadata.orderId}
                                            </button>
                                        )}
                                        {log.metadata.invoiceNumber && (
                                            <button className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-neon-purple/10 text-neon-purple border border-neon-purple/20 hover:bg-neon-purple/20 transition-colors">
                                                <FileText className="w-3 h-3" />
                                                INV {log.metadata.invoiceNumber}
                                            </button>
                                        )}
                                        {needsReview && (
                                            <button className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono font-medium uppercase tracking-wider rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/20 transition-colors">
                                                Verify Variance
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
