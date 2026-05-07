'use client';

import { useState, useEffect } from 'react';
import { Package, ChevronDown, ArrowRight } from 'lucide-react';

interface BOMSummaryItem {
    productId: string;
    productName: string;
    supplierName: string;
    runwayDays: number;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';
    totalBurnRate: number;
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        buildsWorth: number;
    }>;
}

const URGENCY_COLORS = {
    critical: 'text-red-400',
    warning: 'text-amber-400',
    watch: 'text-yellow-400',
    ok: 'text-emerald-400',
} as const;

const URGENCY_BG = {
    critical: 'bg-red-500/15 border-red-500/30',
    warning: 'bg-amber-500/15 border-amber-500/30',
    watch: 'bg-yellow-500/10 border-yellow-500/20',
    ok: 'bg-emerald-500/10 border-emerald-500/20',
} as const;

export default function ComponentDemandCard() {
    const [items, setItems] = useState<BOMSummaryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/dashboard/purchasing?summary=bom&limit=10');
                if (!res.ok) throw new Error('Failed to fetch');
                const data = await res.json();
                setItems(data.items || []);
            } catch (err) {
                console.error('[ComponentDemandCard] fetch error:', err);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    if (loading || items.length === 0) return null;

    const criticalCount = items.filter(i => i.urgency === 'critical').length;
    const warningCount = items.filter(i => i.urgency === 'warning').length;

    return (
        <div className="border-t border-zinc-800/50">
            <button
                onClick={() => setCollapsed(!collapsed)}
                className="w-full px-4 py-2.5 flex items-center justify-between bg-purple-500/5 hover:bg-purple-500/10 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Package className="w-3.5 h-3.5 text-purple-400" />
                    <span className="text-xs font-mono text-purple-300 font-medium">
                        Component Demand
                    </span>
                    {criticalCount > 0 && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">
                            {criticalCount} critical
                        </span>
                    )}
                    {warningCount > 0 && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            {warningCount} warning
                        </span>
                    )}
                </div>
                <ChevronDown className={`w-3 h-3 text-zinc-500 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
            </button>

            {!collapsed && (
                <div className="px-4 py-2 space-y-1.5">
                    {items.map(item => (
                        <div key={item.productId}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded border text-xs font-mono ${URGENCY_BG[item.urgency]}`}
                        >
                            <span className={`w-1.5 h-1.5 rounded-full ${
                                item.urgency === 'critical' ? 'bg-red-400' :
                                item.urgency === 'warning' ? 'bg-amber-400' :
                                item.urgency === 'watch' ? 'bg-yellow-400' : 'bg-emerald-400'
                            }`} />
                            <span className="text-zinc-200 truncate flex-1">{item.productName}</span>
                            <span className={`${URGENCY_COLORS[item.urgency]} tabular-nums`}>
                                {Math.round(item.runwayDays)}d
                            </span>
                            {item.feedsFinishedGoods?.[0] && (
                                <span className="text-zinc-500 text-[9px] truncate max-w-[110px]">
                                    ≈{item.feedsFinishedGoods[0].buildsWorth} builds
                                </span>
                            )}
                            <span className="text-zinc-600 text-[9px] truncate max-w-[80px]">
                                {item.supplierName}
                            </span>
                        </div>
                    ))}

                    {/* Dashboard tab/mode aren't query-param driven yet — link to /dashboard
                        and let Will click the Purchasing tab → BOM Materials button.
                        TODO(v2): wire up ?tab= and ?mode= for direct navigation. */}
                    <a href="/dashboard"
                        className="flex items-center gap-1 text-[10px] font-mono text-purple-400 hover:text-purple-300 pt-1 transition-colors"
                    >
                        View all in Purchasing <ArrowRight className="w-2.5 h-2.5" />
                    </a>
                </div>
            )}
        </div>
    );
}
