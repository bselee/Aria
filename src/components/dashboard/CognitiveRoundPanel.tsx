"use client";

/**
 * @file    src/components/dashboard/CognitiveRoundPanel.tsx
 * @purpose Dashboard panel showing cognitive round decision history.
 *          Displays the last 24h of adaptive priority decisions made by
 *          the cognition layer. Auto-refreshes every 5 minutes.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    react, lucide-react
 */

import { useEffect, useState, useCallback } from "react";
import { Brain, Shield, AlertTriangle, Zap, Coffee, RefreshCw } from "lucide-react";

interface CognitiveDecision {
    priority: "critical" | "high" | "medium" | "low";
    action: string;
    suppress: string[];
    boost: string[];
    summary: string;
}

interface CognitiveRound {
    ranAt: string;
    state: Record<string, unknown>;
    decision: CognitiveDecision;
    durationMs: number;
}

const PRIORITY_STYLES: Record<string, { bg: string; text: string; icon: any; label: string }> = {
    critical: { bg: "bg-red-900/40", text: "text-red-400", icon: AlertTriangle, label: "CRITICAL" },
    high:     { bg: "bg-orange-900/40", text: "text-orange-400", icon: AlertTriangle, label: "HIGH" },
    medium:   { bg: "bg-yellow-900/30", text: "text-yellow-400", icon: Zap, label: "MEDIUM" },
    low:      { bg: "bg-green-900/30", text: "text-green-400", icon: Coffee, label: "LOW" },
};

export default function CognitiveRoundPanel() {
    const [rounds, setRounds] = useState<CognitiveRound[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchRounds = useCallback(async () => {
        try {
            const res = await fetch(`/api/dashboard/cognitive-rounds?hours=24`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setRounds(data.rounds || []);
            setError(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchRounds();
        const interval = setInterval(fetchRounds, 5 * 60 * 1000); // 5 min
        return () => clearInterval(interval);
    }, [fetchRounds]);

    if (loading) {
        return (
            <div className="p-4 bg-gray-900 rounded-lg border border-gray-700">
                <div className="flex items-center gap-2 text-gray-400">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Loading cognitive rounds...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 bg-gray-900 rounded-lg border border-red-800">
                <p className="text-red-400 text-sm">Failed to load: {error}</p>
            </div>
        );
    }

    return (
        <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <h3 className="text-white font-semibold">Cognitive Rounds</h3>
                    <span className="text-xs text-gray-500">Last 24h</span>
                </div>
                <button
                    onClick={fetchRounds}
                    className="p-1 hover:bg-gray-800 rounded text-gray-400 hover:text-white transition-colors"
                >
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            <div className="max-h-96 overflow-y-auto">
                {rounds.length === 0 ? (
                    <div className="p-6 text-center text-gray-500 text-sm">
                        <Shield className="w-8 h-8 mx-auto mb-2 text-gray-600" />
                        <p>No cognitive rounds logged yet.</p>
                        <p className="text-xs mt-1">Cognitive Round runs every 15 min after deploy.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-gray-800">
                        {rounds.map((round, i) => {
                            const style = PRIORITY_STYLES[round.decision.priority] || PRIORITY_STYLES.medium;
                            const Icon = style.icon;
                            const time = new Date(round.ranAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                            });

                            return (
                                <div key={i} className={`px-4 py-3 ${style.bg} hover:bg-gray-800/50 transition-colors`}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex items-center gap-2 flex-1 min-w-0">
                                            <Icon className={`w-4 h-4 flex-shrink-0 ${style.text}`} />
                                            <span className={`text-xs font-mono font-bold ${style.text}`}>
                                                {style.label}
                                            </span>
                                            <span className="text-gray-500 text-xs">{time}</span>
                                            <span className="text-gray-600 text-xs">{round.durationMs}ms</span>
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-300 mt-1 leading-snug">
                                        {round.decision.summary}
                                    </p>
                                    <div className="flex flex-wrap gap-1 mt-2">
                                        {round.decision.suppress.map((job) => (
                                            <span
                                                key={`s-${job}`}
                                                className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-red-900/30 text-red-400 border border-red-800/30"
                                            >
                                                ↓ {job}
                                            </span>
                                        ))}
                                        {round.decision.boost.map((job) => (
                                            <span
                                                key={`b-${job}`}
                                                className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-green-900/30 text-green-400 border border-green-800/30"
                                            >
                                                ↑ {job}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
