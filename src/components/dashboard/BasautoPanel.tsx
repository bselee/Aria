/**
 * @file    src/components/dashboard/BasautoPanel.tsx
 * @purpose Dashboard panel for BASAUTO purchase requests.
 *          Shows pending + ordered requests from basauto.vercel.app.
 *          Highlights items needing attention (pending >48h, unusual items).
 *
 *          Data sourced from local cache written by scripts/basauto_poll.py.
 *          Refreshes every 60s during view.
 *
 * @author  Hermia
 * @created 2026-06-09
 * @deps    next (use client), React
 * @env     reads /api/dashboard/basauto-requests
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";

interface BasautoRequest {
    id?: string;
    status: string;
    requestedBy: string;
    description?: string;
    item?: string;
    items?: string;
    quantity?: number;
    notes?: string;
    submittedAt?: string;
    createdAt?: string;
    orderedAt?: string;
    vendor?: string;
    sku?: string;
}

interface BasautoData {
    requests: BasautoRequest[];
    cachedAt: string | null;
    tokenExpiry: string | null;
    total: number;
    pending: number;
    ordered: number;
}

const POLL_INTERVAL = 60_000;

export default function BasautoPanel() {
    const [data, setData] = useState<BasautoData | null>(null);
    const [loading, setLoading] = useState(true);
    const [collapsed, setCollapsed] = useState(false);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch("/api/dashboard/basauto-requests");
            const json = await res.json();
            setData(json);
        } catch {
            // Silent — dashboard keeps last good data
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [fetchData]);

    if (loading && !data) {
        return (
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
                <h3 className="text-sm font-semibold text-gray-400 mb-2">
                    BASAUTO Requests
                </h3>
                <p className="text-gray-500 text-xs">Loading...</p>
            </div>
        );
    }

    const requests = data?.requests || [];
    const pending = requests.filter(
        (r) =>
            r.status === "Pending" ||
            r.status === "pending" ||
            r.status === "NEW",
    );
    const ordered = requests.filter(
        (r) =>
            r.status === "Ordered" ||
            r.status === "ordered" ||
            r.status === "APPROVED",
    );

    // Group by department
    const byDept: Record<string, BasautoRequest[]> = {};
    for (const r of requests) {
        const dept = r.requestedBy || r.requested_by || "Unknown";
        if (!byDept[dept]) byDept[dept] = [];
        byDept[dept].push(r);
    }

    const tokenExpiry = data?.tokenExpiry
        ? new Date(data.tokenExpiry).toLocaleDateString()
        : null;

    return (
        <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
            {/* Header */}
            <div
                className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-gray-800/50"
                onClick={() => setCollapsed(!collapsed)}
            >
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-300">
                        BASAUTO Requests
                    </h3>
                    {pending.length > 0 && (
                        <span className="bg-yellow-500/20 text-yellow-400 text-xs px-2 py-0.5 rounded-full font-medium">
                            {pending.length} pending
                        </span>
                    )}
                    <span className="text-gray-500 text-xs">
                        {data?.total || 0} total
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {tokenExpiry && (
                        <span className="text-gray-600 text-xs">
                            token: {tokenExpiry}
                        </span>
                    )}
                    <span className="text-gray-500 text-xs">
                        {collapsed ? "▶" : "▼"}
                    </span>
                </div>
            </div>

            {collapsed ? null : (
                <div className="px-4 pb-3">
                    {/* Pending section — these are the ones needing attention */}
                    {pending.length > 0 && (
                        <div className="mb-3">
                            <div className="text-xs font-medium text-yellow-400 mb-1">
                                Pending ({pending.length})
                            </div>
                            {pending.map((r, i) => (
                                <div
                                    key={r.id || i}
                                    className="text-xs text-gray-300 py-1 px-2 bg-yellow-500/5 rounded mb-1 border border-yellow-500/10"
                                >
                                    <span className="font-medium text-yellow-300">
                                        {r.requestedBy || "?"}
                                    </span>
                                    {" — "}
                                    <span className="text-gray-400">
                                        {r.description || r.item || r.items || "?"}
                                    </span>
                                    {r.quantity && (
                                        <span className="text-gray-500">
                                            {" "}
                                            (×{r.quantity})
                                        </span>
                                    )}
                                    {r.submittedAt && (
                                        <span className="text-gray-600 ml-1">
                                            {timeAgo(r.submittedAt)}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Ordered by department — reference only */}
                    <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">
                            Ordered ({ordered.length})
                        </div>
                        <div className="grid grid-cols-2 gap-1">
                            {Object.entries(byDept)
                                .sort(([, a], [, b]) => b.length - a.length)
                                .map(([dept, items]) => {
                                    const deptPending = items.filter(
                                        (r) =>
                                            r.status === "Pending" ||
                                            r.status === "pending",
                                    ).length;
                                    const deptOrdered = items.length - deptPending;
                                    return (
                                        <div
                                            key={dept}
                                            className="text-xs text-gray-500 px-2 py-1 bg-gray-800/50 rounded"
                                        >
                                            <span className="text-gray-400">{dept}</span>
                                            {" "}
                                            <span className="text-green-500">
                                                {deptOrdered}✓
                                            </span>
                                            {deptPending > 0 && (
                                                <span className="text-yellow-400 ml-1">
                                                    {deptPending}⏳
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>

                    {/* Footer */}
                    {data?.cachedAt && (
                        <div className="text-gray-600 text-xs mt-2 border-t border-gray-800 pt-2">
                            Last synced:{" "}
                            {new Date(data.cachedAt).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function timeAgo(dateStr: string): string {
    const ms = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
