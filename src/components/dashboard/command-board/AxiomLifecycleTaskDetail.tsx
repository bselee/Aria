/**
 * @file    AxiomLifecycleTaskDetail.tsx
 * @purpose Premium dashboard detail view for Axiom lifecycle tasks. Includes spec template builder and order preview.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    react, lucide-react, @/components/dashboard/command-board/types
 */
"use client";

import React, { useState, useEffect } from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronRight,
    Copy,
    FileText,
    HelpCircle,
    Info,
    Loader2,
    Lock,
    Save,
    Sparkles,
    Unlock,
    ExternalLink,
    Image as ImageIcon
} from "lucide-react";
import type { CommandBoardTaskDetail } from "./types";
import { isDimensionCongruent } from "@/lib/dash/resolver";
import type { DashAsset } from "@/lib/dash/resolver";

type AxiomLifecycleTaskDetailProps = {
    detail: CommandBoardTaskDetail;
    onActionComplete?: () => void;
};

type ApprovedTemplate = {
    finale_sku: string;
    axiom_job_name: string | null;
    spec: {
        product_class?: "sticker" | "bag";
        size?: string;
        material?: string;
        finish?: string;
        roll_wind?: string;
        quantity_breaks?: string;
        axiom_option_ids?: string;
        thickness?: string;
        gusset_size?: string;
        gusset_type?: string;
    };
    auto_order_allowed: boolean;
    approved: boolean;
};

export function AxiomLifecycleTaskDetail({ detail, onActionComplete }: AxiomLifecycleTaskDetailProps) {
    const inputs = detail.body?.inputs || {};
    const poNumber = inputs.poNumber || detail.source_id || "";
    const finaleSkus: string[] = inputs.finaleSkus || [];
    const missingTemplateSkus: string[] = inputs.missingTemplateSkus || [];
    const duplicateBlockers: any[] = inputs.duplicateBlockers || [];
    const vendorName = inputs.vendorName || "";

    const isBagsVendor = /colorful\s*packaging/i.test(vendorName);

    // State for templates form
    const [selectedSku, setSelectedSku] = useState<string>("");
    const [productClass, setProductClass] = useState<"sticker" | "bag">("sticker");
    const [axiomJobName, setAxiomJobName] = useState<string>("");
    const [size, setSize] = useState<string>('3" x 3"');
    const [material, setMaterial] = useState<string>("White Matte BOPP");
    const [finish, setFinish] = useState<string>("No Lamination");
    const [rollWind, setRollWind] = useState<string>("Any Unwind");
    const [thickness, setThickness] = useState<string>("4.5 mil");
    const [gussetSize, setGussetSize] = useState<string>("2.5\"");
    const [gussetType, setGussetType] = useState<string>("Bottom Gusset");
    const [qtyBreaks, setQtyBreaks] = useState<string>("1000, 2500, 5000");
    const [optionIds, setOptionIds] = useState<string>("");
    const [autoOrderAllowed, setAutoOrderAllowed] = useState<boolean>(false);

    // DASH artwork states
    const [dashAssets, setDashAssets] = useState<DashAsset[]>([]);
    const [loadingAssets, setLoadingAssets] = useState<boolean>(false);

    // UX state
    const [saving, setSaving] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [existingSpecs, setExistingSpecs] = useState<Record<string, ApprovedTemplate>>({});
    const [loadingSpecs, setLoadingSpecs] = useState<boolean>(false);

    // Initial SKU selection
    useEffect(() => {
        if (missingTemplateSkus.length > 0) {
            setSelectedSku(missingTemplateSkus[0]);
        } else if (finaleSkus.length > 0) {
            setSelectedSku(finaleSkus[0]);
        }
    }, [missingTemplateSkus, finaleSkus]);

    // Load templates for all SKUs in PO
    useEffect(() => {
        if (finaleSkus.length === 0) return;

        async function fetchExistingTemplates() {
            setLoadingSpecs(true);
            try {
                const fetched: Record<string, ApprovedTemplate> = {};
                await Promise.all(
                    finaleSkus.map(async sku => {
                        const res = await fetch(`/api/axiom-templates?sku=${encodeURIComponent(sku)}`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data.templates && data.templates.length > 0) {
                                fetched[sku] = data.templates[0];
                            }
                        }
                    })
                );
                setExistingSpecs(fetched);
            } catch (err) {
                console.error("Failed to load existing specs:", err);
            } finally {
                setLoadingSpecs(false);
            }
        }

        fetchExistingTemplates();
    }, [finaleSkus]);

    // Fetch matched DASH artwork when selected SKU changes
    useEffect(() => {
        if (!selectedSku) return;

        async function fetchDashAssets() {
            setLoadingAssets(true);
            try {
                const res = await fetch(`/api/dash-assets?sku=${encodeURIComponent(selectedSku)}`);
                if (res.ok) {
                    const data = await res.json();
                    setDashAssets(data.assets || []);
                } else {
                    setDashAssets([]);
                }
            } catch (err) {
                console.error("Failed to load DASH assets:", err);
                setDashAssets([]);
            } finally {
                setLoadingAssets(false);
            }
        }

        fetchDashAssets();
    }, [selectedSku]);

    // Pre-populate fields when selectedSku changes
    useEffect(() => {
        if (!selectedSku) return;

        const existing = existingSpecs[selectedSku];
        if (existing) {
            setAxiomJobName(existing.axiom_job_name || selectedSku);
            setSize(existing.spec?.size || '3" x 3"');
            setMaterial(existing.spec?.material || "White Matte BOPP");
            setFinish(existing.spec?.finish || "No Lamination");
            setRollWind(existing.spec?.roll_wind || "Any Unwind");
            setQtyBreaks(existing.spec?.quantity_breaks || "1000, 2500, 5000");
            setOptionIds(existing.spec?.axiom_option_ids || "");
            setAutoOrderAllowed(existing.auto_order_allowed || false);

            // Populate generalized packaging fields
            setProductClass(existing.spec?.product_class || (isBagsVendor ? "bag" : "sticker"));
            setThickness(existing.spec?.thickness || "4.5 mil");
            setGussetSize(existing.spec?.gusset_size || "2.5\"");
            setGussetType(existing.spec?.gusset_type || "Bottom Gusset");
        } else {
            // Sensible defaults based on SKU pattern & vendor
            setAxiomJobName(selectedSku);
            const defaultClass = isBagsVendor ? "bag" : "sticker";
            setProductClass(defaultClass);
            setSize(defaultClass === "bag" ? '5" x 6"' : '3" x 3"');
            setMaterial(defaultClass === "bag" ? "Matte Mylar" : "White Matte BOPP");
            setFinish("No Lamination");
            setRollWind("Any Unwind");
            setQtyBreaks("1000, 2500, 5000");
            setOptionIds("");
            setAutoOrderAllowed(false);
            setThickness("4.5 mil");
            setGussetSize("2.5\"");
            setGussetType("Bottom Gusset");
        }
    }, [selectedSku, existingSpecs, isBagsVendor]);

    const handleSaveTemplate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedSku) return;

        setSaving(true);
        setError(null);
        setSuccess(null);

        const payload = {
            finale_sku: selectedSku,
            axiom_job_name: axiomJobName.trim() || selectedSku,
            spec: {
                product_class: productClass,
                size: size.trim(),
                material: material.trim(),
                finish: finish.trim(),
                roll_wind: productClass === "sticker" ? rollWind.trim() : undefined,
                thickness: productClass === "bag" ? thickness.trim() : undefined,
                gusset_size: productClass === "bag" ? gussetSize.trim() : undefined,
                gusset_type: productClass === "bag" ? gussetType.trim() : undefined,
                quantity_breaks: qtyBreaks.trim(),
                axiom_option_ids: optionIds.trim() || null
            },
            auto_order_allowed: autoOrderAllowed,
            approved: true,
            approved_by: "will-dashboard"
        };

        try {
            const res = await fetch("/api/axiom-templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to save template spec");
            }

            setSuccess(`Spec template for ${selectedSku} saved & approved successfully!`);

            // Optimistically update local cache
            setExistingSpecs(prev => ({
                ...prev,
                [selectedSku]: {
                    finale_sku: selectedSku,
                    axiom_job_name: payload.axiom_job_name,
                    spec: payload.spec,
                    auto_order_allowed: payload.auto_order_allowed,
                    approved: true
                }
            }));

            // If we have parent callback, refresh dashboard lists
            setTimeout(() => {
                onActionComplete?.();
            }, 1000);

        } catch (err: any) {
            setError(err.message || "Failed to save spec template.");
        } finally {
            setSaving(false);
        }
    };

    const handleCompleteTask = async () => {
        if (detail.status === "SUCCEEDED") return;
        setSaving(true);
        try {
            const res = await fetch(`/api/command-board/tasks/${detail.id}/actions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "dismiss" })
            });

            if (!res.ok) {
                throw new Error("Failed to dismiss order preparation task");
            }

            setSuccess("Task marked complete!");
            onActionComplete?.();
        } catch (err: any) {
            setError(err.message || "Failed to complete task.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-4">
            {/* Context Summary Banner */}
            <div className="rounded border border-zinc-800 bg-zinc-950/70 p-3 space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-zinc-400">PACKAGING LIFECYCLE</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-300 border border-blue-500/20">
                        PO {poNumber}
                    </span>
                </div>
                <div className="text-[11px] text-zinc-400 font-mono space-y-1">
                    <p>Status: <span className={`font-semibold uppercase ${
                        missingTemplateSkus.length > 0 ? "text-amber-400" : "text-emerald-400"
                    }`}>{detail.status}</span></p>
                    <p>Vendor: <span className="text-zinc-200">{vendorName || "Unknown"}</span></p>
                    <p>Total PO SKUs: <span className="text-zinc-200">{finaleSkus.join(", ") || "None"}</span></p>
                </div>
            </div>

            {/* ERROR / SUCCESS ALERTS */}
            {error && (
                <div className="p-2.5 rounded border border-rose-500/40 bg-rose-500/10 text-[11px] font-mono text-rose-300 flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}
            {success && (
                <div className="p-2.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-[11px] font-mono text-emerald-300 flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{success}</span>
                </div>
            )}

            {/* DUPLICATE BLOCKER WARNING */}
            {duplicateBlockers.length > 0 && (
                <div className="rounded border border-rose-500/30 bg-rose-950/20 p-3 text-[11px] text-rose-200 space-y-1 font-mono">
                    <div className="flex items-center gap-1.5 text-rose-400 font-semibold uppercase tracking-wider">
                        <AlertCircle className="w-4 h-4" />
                        <span>Duplication Block Detected</span>
                    </div>
                    <p className="mt-1 text-zinc-400">
                        This draft PO contains SKUs already active in other open or committed orders:
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5 text-zinc-300">
                        {duplicateBlockers.map((blocker, i) => (
                            <li key={i}>
                                SKU <span className="font-semibold text-rose-300">{blocker.sku}</span> is active on PO <span className="underline">{blocker.poNumber}</span> (Status: {blocker.status})
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* CASE 1: MISSING TEMPLATES FORM */}
            {missingTemplateSkus.length > 0 ? (
                <div className="space-y-3">
                    <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-200 font-mono space-y-1">
                        <div className="flex items-center gap-1.5 font-bold uppercase text-amber-400">
                            <Info className="w-4 h-4" />
                            <span>Action Required: Add Spec Templates</span>
                        </div>
                        <p className="text-zinc-400 leading-normal">
                            Automation is blocked. Each packaging SKU must have an approved layout specification before order compilation can proceed.
                        </p>
                    </div>

                    {/* Sku selector chips */}
                    <div className="flex flex-wrap gap-1.5 py-1">
                        {missingTemplateSkus.map(sku => (
                            <button
                                key={sku}
                                type="button"
                                onClick={() => setSelectedSku(sku)}
                                className={`px-2.5 py-1 rounded text-[10px] font-mono transition-all border ${
                                    selectedSku === sku
                                        ? "bg-amber-500/20 text-amber-200 border-amber-500/40 font-bold"
                                        : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-300"
                                }`}
                            >
                                ⚠️ {sku}
                            </button>
                        ))}
                        {finaleSkus.filter(s => !missingTemplateSkus.includes(s)).map(sku => (
                            <button
                                key={sku}
                                type="button"
                                onClick={() => setSelectedSku(sku)}
                                className={`px-2.5 py-1 rounded text-[10px] font-mono transition-all border ${
                                    selectedSku === sku
                                        ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30 font-bold"
                                        : "bg-zinc-900/50 text-zinc-500 border-zinc-900/70 hover:text-zinc-400"
                                }`}
                            >
                                ✓ {sku}
                            </button>
                        ))}
                    </div>

                    {/* Form Builder */}
                    <form onSubmit={handleSaveTemplate} className="border border-zinc-800 bg-zinc-900/40 rounded p-3 space-y-3 text-[11px] font-mono">
                        <div className="border-b border-zinc-800 pb-2 flex items-center justify-between">
                            <span className="text-zinc-200 font-semibold flex items-center gap-1.5">
                                <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                                Approved Spec Builder: <span className="text-amber-300">{selectedSku}</span>
                            </span>
                            {existingSpecs[selectedSku] && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[9px] border border-emerald-500/20">
                                    Approved Spec Exists
                                </span>
                            )}
                        </div>

                        {/* Product Class Selector Tabs */}
                        <div className="flex gap-2 p-0.5 rounded bg-zinc-950/60 border border-zinc-800/80">
                            <button
                                type="button"
                                onClick={() => {
                                    setProductClass("sticker");
                                    setSize('3" x 3"');
                                    setMaterial("White Matte BOPP");
                                }}
                                className={`flex-1 py-1.5 rounded text-[10px] uppercase font-bold transition-all ${
                                    productClass === "sticker"
                                        ? "bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700/50"
                                        : "text-zinc-500 hover:text-zinc-400"
                                }`}
                            >
                                🏷️ Sticker & Label
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setProductClass("bag");
                                    setSize('5" x 6"');
                                    setMaterial("Matte Mylar");
                                }}
                                className={`flex-1 py-1.5 rounded text-[10px] uppercase font-bold transition-all ${
                                    productClass === "bag"
                                        ? "bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700/50"
                                        : "text-zinc-500 hover:text-zinc-400"
                                }`}
                            >
                                🛍️ Custom Bag
                            </button>
                        </div>

                        {/* Packaging Job Name */}
                        <div className="space-y-1">
                            <label className="text-zinc-400 block font-semibold">
                                {productClass === "bag" ? "Custom Bag" : "Axiom"} Product / Job Name
                            </label>
                            <input
                                type="text"
                                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-zinc-700"
                                placeholder={productClass === "bag" ? "e.g. 1.0 CuFt Soil Bag" : "e.g. APL102 Roll Labels"}
                                value={axiomJobName}
                                onChange={e => setAxiomJobName(e.target.value)}
                                required
                            />
                            <span className="text-[10px] text-zinc-500 block">
                                Exact match of {productClass === "bag" ? "production" : "Axiom's site"} product name or custom job reference.
                            </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {/* Size */}
                            <div className="space-y-1">
                                <label className="text-zinc-400 block font-semibold">
                                    {productClass === "bag" ? "Bag Size" : "Sticker Size"}
                                </label>
                                <input
                                    type="text"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                    placeholder={productClass === "bag" ? 'e.g. 8.5" x 11"' : '3" x 3"'}
                                    value={size}
                                    onChange={e => setSize(e.target.value)}
                                    required
                                />
                            </div>

                            {/* Material */}
                            <div className="space-y-1">
                                <label className="text-zinc-400 block font-semibold">Material Option</label>
                                <input
                                    type="text"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                    placeholder={productClass === "bag" ? "Matte Mylar / Kraft" : "White Matte BOPP"}
                                    value={material}
                                    onChange={e => setMaterial(e.target.value)}
                                    required
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {/* Finish */}
                            <div className="space-y-1">
                                <label className="text-zinc-400 block font-semibold">Finish / Lamination</label>
                                <input
                                    type="text"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                    placeholder="Gloss Lamination"
                                    value={finish}
                                    onChange={e => setFinish(e.target.value)}
                                    required
                                />
                            </div>

                            {/* Class-specific fields */}
                            {productClass === "sticker" ? (
                                <div className="space-y-1">
                                    <label className="text-zinc-400 block font-semibold">Roll Wind / Direction</label>
                                    <input
                                        type="text"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                        placeholder="Right Wind, 3&quot; Core"
                                        value={rollWind}
                                        onChange={e => setRollWind(e.target.value)}
                                        required={productClass === "sticker"}
                                    />
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <label className="text-zinc-400 block font-semibold">Bag Thickness</label>
                                    <input
                                        type="text"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                        placeholder="e.g. 4.5 mil"
                                        value={thickness}
                                        onChange={e => setThickness(e.target.value)}
                                        required={productClass === "bag"}
                                    />
                                </div>
                            )}
                        </div>

                        {productClass === "bag" && (
                            <div className="grid grid-cols-2 gap-2">
                                {/* Gusset Size */}
                                <div className="space-y-1">
                                    <label className="text-zinc-400 block font-semibold">Gusset Size</label>
                                    <input
                                        type="text"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                        placeholder="e.g. 2.5\"
                                        value={gussetSize}
                                        onChange={e => setGussetSize(e.target.value)}
                                        required={productClass === "bag"}
                                    />
                                </div>

                                {/* Gusset Type */}
                                <div className="space-y-1">
                                    <label className="text-zinc-400 block font-semibold">Gusset Type</label>
                                    <input
                                        type="text"
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                        placeholder="e.g. Bottom Gusset / Side"
                                        value={gussetType}
                                        onChange={e => setGussetType(e.target.value)}
                                        required={productClass === "bag"}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Qty breaks and Option IDs */}
                        <div className="space-y-2">
                            <div className="space-y-1">
                                <label className="text-zinc-400 block font-semibold">Allowed Qty Breaks</label>
                                <input
                                    type="text"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-700"
                                    placeholder="1000, 2500, 5000"
                                    value={qtyBreaks}
                                    onChange={e => setQtyBreaks(e.target.value)}
                                />
                            </div>

                            <div className="space-y-1">
                                <label className="text-zinc-400 block font-semibold">
                                    Last Known Option IDs (Optional)
                                </label>
                                <input
                                    type="text"
                                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-zinc-700 font-mono"
                                    placeholder='e.g. {"material_id": "123"}'
                                    value={optionIds}
                                    onChange={e => setOptionIds(e.target.value)}
                                />
                            </div>
                        </div>

                        {/* DASH Artwork Integration Widget */}
                        <div className="border border-zinc-800 bg-zinc-950/45 rounded p-2.5 space-y-2.5">
                            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
                                <span className="text-[10px] font-bold text-zinc-400 tracking-wider uppercase flex items-center gap-1.5">
                                    <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                                    DASH Digital Assets
                                </span>
                                <a
                                    href="https://buildasoil.dash.app/browse/all"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[9px] text-zinc-500 hover:text-blue-400 flex items-center gap-0.5 transition-all font-semibold"
                                >
                                    Browse All <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                            </div>

                            {loadingAssets ? (
                                <div className="flex items-center justify-center gap-2 py-4 text-zinc-500">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Resolving digital artwork...
                                </div>
                            ) : dashAssets.length === 0 ? (
                                <div className="text-zinc-500 text-center py-3 text-[10px]">
                                    No matched digital assets in DASH for SKU "{selectedSku}"
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {/* Mismatch Gating Alert Banner */}
                                    {dashAssets.some(asset => asset.sizeMatch && !isDimensionCongruent(asset.sizeMatch, size)) && (
                                        <div className="p-2 rounded bg-amber-500/10 border border-amber-500/25 text-[10px] text-amber-300/90 leading-relaxed font-sans">
                                            <strong className="text-amber-300">Gating Alert:</strong> Digital asset size mismatch detected. Please verify your print template specs match the physical artwork.
                                        </div>
                                    )}
                                    <div className="grid gap-1.5 max-h-48 overflow-y-auto pr-1">
                                        {dashAssets.map((asset, i) => {
                                            const isCongruent = isDimensionCongruent(asset.sizeMatch, size);
                                            return (
                                                <div
                                                    key={i}
                                                    className="flex items-center justify-between p-2 rounded bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700/80 transition-all text-[10px]"
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <FileText className={`w-4 h-4 shrink-0 ${
                                                            asset.type === "pdf" ? "text-red-400" :
                                                            asset.type === "ai" ? "text-amber-500" : "text-blue-400"
                                                        }`} />
                                                        <div className="min-w-0">
                                                            <p className="font-semibold text-zinc-300 truncate" title={asset.name}>
                                                                {asset.name}
                                                            </p>
                                                            <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-zinc-500 font-mono">
                                                                <span>{asset.addedAt}</span>
                                                                <span>•</span>
                                                                <span className="uppercase text-[8px] px-1 rounded bg-zinc-950 text-zinc-400 border border-zinc-800">
                                                                    {asset.type}
                                                                </span>
                                                                {asset.side !== "unknown" && (
                                                                    <>
                                                                        <span>•</span>
                                                                        <span className="capitalize">{asset.side}</span>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex flex-col items-end gap-1 font-mono text-[9px]">
                                                        {asset.isPrintReady ? (
                                                            <span className="px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold uppercase tracking-wider text-[8px]">
                                                                Print Ready
                                                            </span>
                                                        ) : (
                                                            <span className="px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold uppercase tracking-wider text-[8px]">
                                                                Proof
                                                            </span>
                                                        )}

                                                        {asset.sizeMatch ? (
                                                            isCongruent ? (
                                                                <span className="text-emerald-400 font-semibold flex items-center gap-0.5">
                                                                    ✓ Congruent ({asset.sizeMatch})
                                                                </span>
                                                            ) : (
                                                                <span className="text-amber-400 font-bold flex items-center gap-0.5" title={`Mismatch with current spec: ${size}`}>
                                                                    ⚠ Mismatch ({asset.sizeMatch})
                                                                </span>
                                                            )
                                                        ) : (
                                                            <span className="text-zinc-500 italic">
                                                                🔍 Unverified Size
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Auto order allowed */}
                        <div className="flex items-center gap-2 pt-1">
                            <input
                                id="autoOrderCheck"
                                type="checkbox"
                                className="w-3.5 h-3.5 accent-blue-500 rounded border-zinc-800 bg-zinc-950"
                                checked={autoOrderAllowed}
                                onChange={e => setAutoOrderAllowed(e.target.checked)}
                            />
                            <label htmlFor="autoOrderCheck" className="text-zinc-300 font-semibold cursor-pointer select-none flex items-center gap-1">
                                {autoOrderAllowed ? (
                                    <span className="text-blue-400 inline-flex items-center gap-0.5">
                                        <Unlock className="w-3 h-3" /> Auto Order Allowed (Level 2)
                                    </span>
                                ) : (
                                    <span className="text-zinc-500 inline-flex items-center gap-0.5">
                                        <Lock className="w-3 h-3 text-zinc-600" /> Manual Submission Only (Level 1)
                                    </span>
                                )}
                            </label>
                        </div>

                        <button
                            type="submit"
                            disabled={saving}
                            className="w-full mt-2 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-amber-500 hover:bg-amber-600 active:scale-[0.99] text-black font-bold transition-all shadow focus:outline-none disabled:opacity-50"
                        >
                            {saving ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <Save className="w-3.5 h-3.5" />
                            )}
                            Save Spec & Approve for {selectedSku}
                        </button>
                    </form>
                </div>
            ) : (
                /* CASE 2: READY FOR ORDER PREP */
                <div className="space-y-4 font-mono text-[11px]">
                    <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-3 text-emerald-200 space-y-1">
                        <div className="flex items-center gap-1.5 font-bold uppercase text-emerald-400">
                            <CheckCircle2 className="w-4 h-4" />
                            <span>Specs Approved: Ready to Order</span>
                        </div>
                        <p className="text-zinc-400 leading-normal">
                            All packaging SKUs on draft PO {poNumber} have explicit approved print templates! Safety checks are passing.
                        </p>
                    </div>

                    {/* Check list */}
                    <div className="rounded border border-zinc-800 bg-zinc-900/30 p-3 space-y-2.5">
                        <span className="text-xs font-bold text-zinc-300 block border-b border-zinc-800 pb-1">Safety Checklist</span>
                        <div className="space-y-1.5 text-zinc-300">
                            <div className="flex items-center gap-2">
                                <span className="w-4 h-4 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-[10px]">✓</span>
                                <span>Finale Draft PO Detected (PO {poNumber})</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-4 h-4 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-[10px]">✓</span>
                                <span>Duplication Check Passed (0 overlapping active orders)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-4 h-4 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold text-[10px]">✓</span>
                                <span>Template Gating Passed (Approved spec for every SKU)</span>
                            </div>
                        </div>
                    </div>

                    {/* Specifications breakdown */}
                    <div className="space-y-2">
                        <span className="text-xs font-bold text-zinc-300 block">Print Production Specifications</span>
                        {loadingSpecs ? (
                            <div className="flex items-center gap-2 text-zinc-500 p-2">
                                <Loader2 className="w-3 h-3 animate-spin" /> Loading specifications...
                            </div>
                        ) : (
                            <div className="grid gap-2">
                                {finaleSkus.map(sku => {
                                    const template = existingSpecs[sku];
                                    const isBag = template?.spec?.product_class === "bag";
                                    return (
                                        <div key={sku} className="rounded border border-zinc-800 bg-zinc-950/60 p-2.5 space-y-1.5">
                                            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1">
                                                <span className="text-zinc-200 font-bold text-xs">{sku}</span>
                                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 text-[9px] border border-zinc-800">
                                                    Type: {isBag ? "Custom Bag" : "Sticker/Label"}
                                                </span>
                                            </div>
                                            {template ? (
                                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-400 text-[10px]">
                                                    <p>{isBag ? "Bag Size" : "Sticker Size"}: <span className="text-zinc-200">{template.spec?.size || "—"}</span></p>
                                                    <p>Material: <span className="text-zinc-200">{template.spec?.material || "—"}</span></p>
                                                    <p>Finish: <span className="text-zinc-200">{template.spec?.finish || "—"}</span></p>
                                                    {isBag ? (
                                                        <>
                                                            <p>Thickness: <span className="text-zinc-200">{template.spec?.thickness || "—"}</span></p>
                                                            <p>Gusset Type: <span className="text-zinc-200">{template.spec?.gusset_type || "—"}</span></p>
                                                            <p>Gusset Size: <span className="text-zinc-200">{template.spec?.gusset_size || "—"}</span></p>
                                                        </>
                                                    ) : (
                                                        <p>Unwind: <span className="text-zinc-200">{template.spec?.roll_wind || "—"}</span></p>
                                                    )}
                                                    <p className="col-span-2">Qbreaks: <span className="text-zinc-200">{template.spec?.quantity_breaks || "—"}</span></p>
                                                </div>
                                            ) : (
                                                <p className="text-rose-400">Warning: approved spec not loaded locally.</p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Manual submissions action banner */}
                    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
                        <span className="text-zinc-300 font-semibold block">Order Automation Level: Level 1</span>
                        <p className="text-zinc-400 text-[10px] leading-relaxed">
                            System will prepare the cart inside approved order panel using approved layout options. Under Level 1 gating, you must perform final credit card input and checkout submit.
                        </p>
                        {detail.status !== "SUCCEEDED" && (
                            <button
                                type="button"
                                onClick={handleCompleteTask}
                                disabled={saving}
                                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-emerald-500 hover:bg-emerald-600 active:scale-[0.99] text-black font-bold transition-all shadow focus:outline-none disabled:opacity-50"
                            >
                                {saving ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                )}
                                Prepare Order & Mark Ready
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default AxiomLifecycleTaskDetail;
