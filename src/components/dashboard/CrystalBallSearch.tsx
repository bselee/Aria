/**
 * @file    CrystalBallSearch.tsx
 * @purpose Search input component with auto-suggestions and fuzzy matching.
 *          Calls the Crystal Ball API route and supports selecting an item
 *          to render its detail forecast view.
 * @author  Aria
 * @created 2026-05-19
 * @updated 2026-05-19
 * @deps    react, lucide-react
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Search, X, Loader2, Package, Store } from "lucide-react";
import type { CrystalBallItem } from "./CrystalBallDetail";

interface CrystalBallSearchProps {
    onSelect: (item: CrystalBallItem) => void;
    onVendorSelect?: (vendor: { vendorName: string; vendorPartyId: string }) => void;
}

export function CrystalBallSearch({ onSelect, onVendorSelect }: CrystalBallSearchProps) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<CrystalBallItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    
    // Clear debounce timer on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        };
    }, []);
    
    // Listen for Escape key and clicks outside the search container
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                containerRef.current?.querySelector("input")?.blur();
            }
        };
        
        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);
    
    // Perform debounced search fetching
    const performSearch = useCallback(async (searchVal: string) => {
        const trimmed = searchVal.trim();
        if (trimmed.length < 2) {
            setResults([]);
            setLoading(false);
            return;
        }
        
        setLoading(true);
        try {
            const res = await fetch(`/api/dashboard/purchasing/crystal-ball?q=${encodeURIComponent(trimmed)}`);
            if (res.ok) {
                const data = await res.json();
                setResults(data.results || []);
            } else {
                setResults([]);
            }
        } catch (err) {
            console.error("[crystal-ball-search] Search fetch failed:", err);
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);
    
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);
        setOpen(true);
        
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        
        if (value.trim().length >= 2) {
            setLoading(true);
            debounceTimerRef.current = setTimeout(() => {
                performSearch(value);
            }, 300);
        } else {
            setResults([]);
            setLoading(false);
        }
    };
    
    const handleSelectResult = (item: CrystalBallItem) => {
        onSelect(item);
        setQuery(""); // Clear search query for a clean header UX
        setResults([]);
        setOpen(false);
    };

    const handleSelectVendor = (vendor: { vendorName: string; vendorPartyId: string }) => {
        onVendorSelect?.(vendor);
        setQuery("");
        setResults([]);
        setOpen(false);
    };
    
    const handleClear = () => {
        setQuery("");
        setResults([]);
        setOpen(false);
    };

    const vendorMatches = (() => {
        if (!onVendorSelect || results.length === 0) return [];
        const normalizedQuery = query.trim().toLowerCase();
        const byVendor = new Map<string, { vendorName: string; vendorPartyId: string; count: number }>();
        for (const item of results) {
            const vendorName = item.vendorName || "Unknown supplier";
            const vendorPartyId = item.vendorPartyId || vendorName;
            const haystack = `${vendorName} ${vendorPartyId}`.toLowerCase();
            if (!haystack.includes(normalizedQuery)) continue;
            const existing = byVendor.get(vendorPartyId);
            if (existing) {
                existing.count += 1;
            } else {
                byVendor.set(vendorPartyId, { vendorName, vendorPartyId, count: 1 });
            }
        }
        return Array.from(byVendor.values());
    })();
    
    return (
        <div ref={containerRef} className="relative w-full max-w-[260px] md:max-w-[320px] z-30 font-mono">
            {/* Search Input Box */}
            <div className="relative">
                <input
                    type="text"
                    value={query}
                    onChange={handleInputChange}
                    onFocus={() => setOpen(true)}
                    placeholder="Search SKU or Supplier..."
                    className="w-full pl-8 pr-8 py-1 bg-zinc-950/80 border border-zinc-500/60 focus:border-zinc-200 rounded text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400/40 shadow-inner transition-all"
                />
                <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
                
                {loading ? (
                    <Loader2 className="w-3 h-3 text-zinc-500 animate-spin absolute right-2.5 top-1/2 -translate-y-1/2" />
                ) : query ? (
                    <button 
                        onClick={handleClear}
                        className="p-0.5 hover:bg-zinc-800/80 rounded text-zinc-500 hover:text-zinc-300 absolute right-2 top-1/2 -translate-y-1/2 transition-colors"
                        title="Clear search"
                    >
                        <X className="w-3 h-3" />
                    </button>
                ) : null}
            </div>
            
            {/* Results Dropdown Overlay */}
            {open && query.trim().length >= 2 && (
                <div className="absolute left-0 right-0 mt-1 max-h-80 overflow-y-auto border border-zinc-800 bg-zinc-950 rounded shadow-2xl overflow-hidden [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-zinc-800">
                    <div className="px-2.5 py-1.5 border-b border-zinc-900 bg-zinc-900/30 text-[9px] text-zinc-500 font-semibold uppercase tracking-wider flex items-center justify-between">
                        <span>Crystal Ball Search Suggestions</span>
                        {results.length > 0 && <span>{results.length} found</span>}
                    </div>
                    
                    {loading && results.length === 0 ? (
                        <div className="p-4 text-center text-[10px] text-zinc-500 space-y-2">
                            <Loader2 className="w-4 h-4 text-zinc-500 animate-spin mx-auto" />
                            <span>Querying cash caches...</span>
                        </div>
                    ) : results.length === 0 ? (
                        <div className="p-4 text-center text-[10px] text-zinc-500 space-y-1 bg-zinc-950/90">
                            <span className="block font-semibold">No matches found</span>
                            <span className="block text-[9px] text-zinc-600">Try a different SKU or vendor name</span>
                        </div>
                    ) : (
                        <div className="divide-y divide-zinc-900/60 bg-zinc-950/80">
                            {vendorMatches.length > 0 && (
                                <div className="bg-zinc-900/40 border-b border-zinc-800/80">
                                    {vendorMatches.map(vendor => (
                                        <button
                                            key={vendor.vendorPartyId}
                                            onClick={() => handleSelectVendor({
                                                vendorName: vendor.vendorName,
                                                vendorPartyId: vendor.vendorPartyId,
                                            })}
                                            className="w-full text-left p-2.5 hover:bg-zinc-800/60 focus:bg-zinc-800/60 focus:outline-none transition-colors flex items-center gap-2.5 group"
                                        >
                                            <div className="p-1 rounded border border-emerald-900/50 bg-emerald-950/25 text-emerald-400 shrink-0">
                                                <Store className="w-3.5 h-3.5" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-xs font-bold text-zinc-200 group-hover:text-zinc-50 truncate">
                                                    View supplier: {vendor.vendorName}
                                                </div>
                                                <div className="text-[9px] text-zinc-500 truncate">
                                                    Pull up this vendor only ({vendor.count} SKU{vendor.count !== 1 ? "s" : ""} matched)
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {results.map(item => {
                                const R = Number.isFinite(item.adjustedRunwayDays) ? item.adjustedRunwayDays : item.runwayDays;
                                let runwayColor = "text-emerald-500";
                                if (R < item.leadTimeDays) {
                                    runwayColor = "text-red-400 font-bold";
                                } else if (R < item.leadTimeDays + 30) {
                                    runwayColor = "text-amber-500";
                                }

                                // Decision summary: next order date + qty + stockout
                                const nextOrderDate = item.projections?.find((p: any) => p.needsOrder)?.orderByDate
                                    ?? item.projectedNextOrderDate ?? null;
                                const suggestedQty = Math.round(item.recommendation?.suggestedQty ?? 0);
                                const stockoutDate = item.projectedStockoutDate ?? null;
                                const needsOrder = R < (item.leadTimeDays ?? 14);
                                
                                return (
                                    <button
                                        key={item.productId}
                                        onClick={() => handleSelectResult(item)}
                                        className="w-full text-left p-2.5 hover:bg-zinc-800/40 focus:bg-zinc-800/40 focus:outline-none transition-colors flex items-start gap-2.5 group"
                                    >
                                        <div className="p-1 rounded border border-zinc-800 bg-zinc-900/60 text-zinc-500 group-hover:text-zinc-300 group-hover:border-zinc-700 transition-colors shrink-0">
                                            <Package className="w-3.5 h-3.5" />
                                        </div>
                                        
                                        <div className="min-w-0 flex-1 space-y-0.5">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-bold text-zinc-200 group-hover:text-zinc-50 transition-colors truncate">
                                                    {item.productId}
                                                </span>
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                                    item.recommendation.urgency === "critical" ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.4)]" :
                                                    item.recommendation.urgency === "warning" ? "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)]" :
                                                    item.recommendation.urgency === "watch" ? "bg-emerald-500" :
                                                    "bg-zinc-500"
                                                }`} />
                                            </div>
                                            <div className="text-[10px] text-zinc-500 group-hover:text-zinc-400 transition-colors truncate">
                                                {item.productName}
                                            </div>
                                            <div className="text-[9px] text-zinc-600 truncate">
                                                Vendor: {item.vendorName}
                                            </div>
                                            {/* Decision row: order qty, next order date, stockout */}
                                            {needsOrder && suggestedQty > 0 ? (
                                                <div className="text-[9px] font-mono text-amber-400 truncate mt-0.5">
                                                    Order {suggestedQty.toLocaleString()} by {nextOrderDate ?? "now"}
                                                    {stockoutDate ? ` · Runs out ${stockoutDate}` : ""}
                                                </div>
                                            ) : nextOrderDate ? (
                                                <div className="text-[9px] font-mono text-emerald-500 truncate mt-0.5">
                                                    Order by {nextOrderDate}
                                                    {stockoutDate ? ` · Runs out ${stockoutDate}` : ""}
                                                </div>
                                            ) : stockoutDate ? (
                                                <div className="text-[9px] font-mono text-zinc-500 truncate mt-0.5">
                                                    Runs out {stockoutDate}
                                                </div>
                                            ) : null}
                                        </div>
                                        
                                        <div className="text-right shrink-0 flex flex-col items-end gap-0.5 justify-center h-full">
                                            <span className={`text-[10px] ${runwayColor}`}>
                                                {Number.isFinite(R) ? `${Math.round(R)}d runway` : "Infinite"}
                                            </span>
                                            {item.stockOnOrder > 0 && (
                                                <span className="text-[9px] text-emerald-500 font-medium bg-emerald-950/20 px-1 rounded border border-emerald-900/20">
                                                    +{item.stockOnOrder} order
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
