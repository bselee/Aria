/**
 * @file    AxiomSkuMappingPanel.tsx
 * @purpose Finale-SKU-first Axiom order completion gate.
 */
"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    CircleDashed,
    ClipboardCheck,
    FileSearch,
    Loader2,
    PackageCheck,
    Plus,
    RefreshCw,
    Search,
    ShieldCheck,
    X,
} from "lucide-react";

export type AxiomSkuMapping = {
    axiom_job_name: string;
    finale_skus: string[];
    qty_fraction: number;
    description: string | null;
    created_at?: string;
    updated_at?: string;
};

export type AxiomOrderTemplate = {
    finale_sku: string;
    axiom_job_name: string | null;
    spec: Record<string, unknown> | null;
    auto_order_allowed: boolean;
    approved: boolean;
    approved_by?: string | null;
    approved_at?: string | null;
    updated_at?: string | null;
};

type CompletionStatus = "ready" | "manual_ready" | "needs_spec" | "reconciliation_only";

type CompletionRow = {
    finaleSku: string;
    axiomJobName: string;
    status: CompletionStatus;
    statusLabel: string;
    statusTone: string;
    description: string;
    specSummary: string;
    qtyFraction: number | null;
    approved: boolean;
    autoOrderAllowed: boolean;
    source: "template" | "mapping";
};

const DEFAULT_SPEC = `{
  "size": "",
  "material": "",
  "finish": "",
  "roll_direction": "",
  "turnaround": ""
}`;

export function AxiomSkuMappingPanel() {
    const [templates, setTemplates] = useState<AxiomOrderTemplate[]>([]);
    const [mappings, setMappings] = useState<AxiomSkuMapping[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");

    const [showForm, setShowForm] = useState(false);
    const [formSubmitting, setFormSubmitting] = useState(false);
    const [finaleSku, setFinaleSku] = useState("");
    const [axiomJobName, setAxiomJobName] = useState("");
    const [specJson, setSpecJson] = useState(DEFAULT_SPEC);
    const [approved, setApproved] = useState(false);
    const [autoOrderAllowed, setAutoOrderAllowed] = useState(false);

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [templateRes, mappingRes] = await Promise.all([
                fetch("/api/axiom-templates"),
                fetch("/api/axiom-sku-mappings"),
            ]);

            if (!templateRes.ok) throw new Error(`Templates HTTP ${templateRes.status}`);
            if (!mappingRes.ok) throw new Error(`Mappings HTTP ${mappingRes.status}`);

            const templateData = await templateRes.json();
            const mappingData = await mappingRes.json();
            setTemplates(templateData.templates ?? []);
            setMappings(mappingData.mappings ?? []);
        } catch (err) {
            console.error("[axiom-skus] load failed", err);
            setError(err instanceof Error ? err.message : "Failed to load Axiom order gate data.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const rows = useMemo(() => buildCompletionRows(templates, mappings), [templates, mappings]);
    const filteredRows = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return rows;
        return rows.filter(row => [
            row.finaleSku,
            row.axiomJobName,
            row.description,
            row.statusLabel,
            row.specSummary,
        ].some(value => value.toLowerCase().includes(query)));
    }, [rows, searchQuery]);

    const counts = useMemo(() => ({
        ready: rows.filter(row => row.status === "ready").length,
        manualReady: rows.filter(row => row.status === "manual_ready").length,
        needsSpec: rows.filter(row => row.status === "needs_spec").length,
        reconciliationOnly: rows.filter(row => row.status === "reconciliation_only").length,
    }), [rows]);

    const resetForm = () => {
        setFinaleSku("");
        setAxiomJobName("");
        setSpecJson(DEFAULT_SPEC);
        setApproved(false);
        setAutoOrderAllowed(false);
        setShowForm(false);
        setError(null);
    };

    const handleSubmitTemplate = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setSuccessMessage(null);

        const cleanSku = finaleSku.trim();
        if (!cleanSku) {
            setError("Finale SKU is required.");
            return;
        }

        let spec: Record<string, unknown>;
        try {
            spec = specJson.trim() ? JSON.parse(specJson) : {};
        } catch {
            setError("Spec JSON is not valid.");
            return;
        }

        setFormSubmitting(true);
        try {
            const payload = {
                finale_sku: cleanSku,
                axiom_job_name: axiomJobName.trim() || cleanSku,
                spec,
                approved,
                auto_order_allowed: autoOrderAllowed,
                approved_by: approved ? "dashboard" : null,
            };

            const res = await fetch("/api/axiom-templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to save Axiom template.");

            setSuccessMessage(`Template for ${cleanSku} saved.`);
            resetForm();
            await fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save Axiom template.");
        } finally {
            setFormSubmitting(false);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-[#09090b] p-4 text-zinc-100">
            <div className="flex flex-col gap-3 border-b border-zinc-800/80 pb-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-100">
                        <ShieldCheck className="h-4 w-4 text-emerald-400" />
                        <span>Axiom Order Completion Gate</span>
                        {loading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
                    </h2>
                    <p className="max-w-3xl text-xs text-zinc-400">
                        Finale SKU is the order reference. Axiom job names, print specs, and auto-order permission attach to that SKU before any website/API order can be trusted.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={fetchData}
                        disabled={loading}
                        className="rounded border border-zinc-800 bg-zinc-900/70 p-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                        title="Refresh Axiom gate"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            resetForm();
                            setShowForm(true);
                        }}
                        className="inline-flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/25"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add Template
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-2 border-b border-zinc-900 py-3 md:grid-cols-4">
                <FlowStep icon={<FileSearch className="h-3.5 w-3.5" />} label="Finale SKU demand" detail="Ordering says SKU needs Axiom." />
                <FlowStep icon={<ClipboardCheck className="h-3.5 w-3.5" />} label="Approved template" detail="Size/material/options are verified." />
                <FlowStep icon={<PackageCheck className="h-3.5 w-3.5" />} label="Create Axiom order" detail="Only approved SKUs can proceed." />
                <FlowStep icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Invoice updates PO" detail="Invoice and shipment close the loop." />
            </div>

            <div className="grid grid-cols-2 gap-2 py-3 lg:grid-cols-4">
                <Metric label="Ready to order" value={counts.ready} tone="text-emerald-300 border-emerald-500/25 bg-emerald-500/10" />
                <Metric label="Manual ready" value={counts.manualReady} tone="text-sky-300 border-sky-500/25 bg-sky-500/10" />
                <Metric label="Needs spec approval" value={counts.needsSpec} tone="text-amber-300 border-amber-500/25 bg-amber-500/10" />
                <Metric label="Reconciliation only" value={counts.reconciliationOnly} tone="text-zinc-300 border-zinc-700 bg-zinc-900/60" />
            </div>

            {successMessage && (
                <div className="mb-3 flex items-center gap-2 rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{successMessage}</span>
                </div>
            )}

            {error && (
                <div className="mb-3 flex items-center gap-2 rounded border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button type="button" onClick={() => setError(null)} className="rounded p-0.5 hover:bg-rose-500/10">
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {showForm && (
                <form onSubmit={handleSubmitTemplate} className="mb-3 space-y-3 rounded border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Approve Finale SKU Template</span>
                        <button type="button" onClick={resetForm} className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label className="space-y-1 text-[11px] uppercase tracking-wider text-zinc-400">
                            <span>Finale SKU</span>
                            <input
                                value={finaleSku}
                                onChange={event => {
                                    setFinaleSku(event.target.value);
                                    if (!axiomJobName.trim()) setAxiomJobName(event.target.value);
                                }}
                                className="w-full rounded border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5 text-xs normal-case text-zinc-100 outline-none focus:border-emerald-500/60"
                                placeholder="FM104"
                            />
                        </label>
                        <label className="space-y-1 text-[11px] uppercase tracking-wider text-zinc-400">
                            <span>Axiom Job / Template</span>
                            <input
                                value={axiomJobName}
                                onChange={event => setAxiomJobName(event.target.value)}
                                className="w-full rounded border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5 text-xs normal-case text-zinc-100 outline-none focus:border-emerald-500/60"
                                placeholder="FM104"
                            />
                        </label>
                    </div>
                    <label className="block space-y-1 text-[11px] uppercase tracking-wider text-zinc-400">
                        <span>Spec JSON</span>
                        <textarea
                            value={specJson}
                            onChange={event => setSpecJson(event.target.value)}
                            rows={6}
                            className="w-full rounded border border-zinc-800 bg-zinc-900/70 px-2.5 py-2 font-mono text-xs normal-case text-zinc-100 outline-none focus:border-emerald-500/60"
                        />
                    </label>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-900 pt-3">
                        <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-300">
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />
                                Approved
                            </label>
                            <label className="inline-flex items-center gap-2">
                                <input type="checkbox" checked={autoOrderAllowed} onChange={event => setAutoOrderAllowed(event.target.checked)} />
                                Auto-order allowed
                            </label>
                        </div>
                        <button
                            type="submit"
                            disabled={formSubmitting}
                            className="inline-flex items-center gap-1.5 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
                        >
                            {formSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Save Template
                        </button>
                    </div>
                </form>
            )}

            <div className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded border border-zinc-800/70 bg-zinc-950/40">
                <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/70 px-3 py-2">
                    <Search className="h-4 w-4 shrink-0 text-zinc-500" />
                    <input
                        value={searchQuery}
                        onChange={event => setSearchQuery(event.target.value)}
                        placeholder="Search Finale SKU, Axiom job, status, or spec..."
                        className="w-full bg-transparent text-xs text-zinc-100 placeholder-zinc-600 outline-none"
                    />
                    {searchQuery && (
                        <button type="button" onClick={() => setSearchQuery("")} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>

                <div className="flex-1 overflow-auto">
                    {loading && rows.length === 0 ? (
                        <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-xs text-zinc-500">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span>Loading Axiom order gate...</span>
                        </div>
                    ) : filteredRows.length === 0 ? (
                        <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 px-4 text-center">
                            <CircleDashed className="h-7 w-7 text-zinc-600" />
                            <h3 className="text-xs font-semibold text-zinc-300">No Axiom order templates yet</h3>
                            <p className="max-w-md text-[11px] leading-relaxed text-zinc-500">
                                Add a Finale SKU template here when Ordering flags an Axiom SKU. The SKU stays blocked until specs are approved.
                            </p>
                        </div>
                    ) : (
                        <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                            <thead>
                                <tr className="border-b border-zinc-800 bg-zinc-950/90 text-[10px] uppercase tracking-wider text-zinc-500">
                                    <th className="px-3 py-2 font-medium">Finale SKU</th>
                                    <th className="px-3 py-2 font-medium">Order Gate</th>
                                    <th className="px-3 py-2 font-medium">Axiom Job / Template</th>
                                    <th className="px-3 py-2 font-medium">Spec</th>
                                    <th className="px-3 py-2 font-medium">Auto</th>
                                    <th className="px-3 py-2 font-medium">Source</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-900">
                                {filteredRows.map(row => (
                                    <tr key={`${row.source}:${row.finaleSku}:${row.axiomJobName}`} className="hover:bg-zinc-900/35">
                                        <td className="px-3 py-2.5 font-mono font-semibold text-zinc-100">{row.finaleSku}</td>
                                        <td className="px-3 py-2.5">
                                            <span className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold ${row.statusTone}`}>
                                                {row.statusLabel}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2.5 font-mono text-zinc-300">{row.axiomJobName || row.finaleSku}</td>
                                        <td className="max-w-sm px-3 py-2.5 text-zinc-400">{row.specSummary}</td>
                                        <td className="px-3 py-2.5 text-zinc-400">{row.autoOrderAllowed ? "Allowed" : "No"}</td>
                                        <td className="px-3 py-2.5 text-zinc-500">
                                            {row.source === "template" ? "Order template" : "Reconciliation only"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="flex items-center justify-between border-t border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-[10px] text-zinc-500">
                    <span>Showing {filteredRows.length} of {rows.length} Finale SKU rows</span>
                    <span>Automation gate: approved template + auto-order allowed</span>
                </div>
            </div>
        </div>
    );
}

function buildCompletionRows(templates: AxiomOrderTemplate[], mappings: AxiomSkuMapping[]): CompletionRow[] {
    const rows = new Map<string, CompletionRow>();

    for (const template of templates) {
        const status = getTemplateStatus(template);
        rows.set(template.finale_sku, {
            finaleSku: template.finale_sku,
            axiomJobName: template.axiom_job_name || template.finale_sku,
            status,
            ...statusPresentation(status),
            description: "",
            specSummary: summarizeSpec(template.spec),
            qtyFraction: null,
            approved: template.approved,
            autoOrderAllowed: template.auto_order_allowed,
            source: "template",
        });
    }

    for (const mapping of mappings) {
        for (const sku of mapping.finale_skus) {
            if (rows.has(sku)) continue;
            rows.set(sku, {
                finaleSku: sku,
                axiomJobName: mapping.axiom_job_name,
                status: "reconciliation_only",
                ...statusPresentation("reconciliation_only"),
                description: mapping.description ?? "",
                specSummary: mapping.description || "Invoice reconciliation mapping exists, but no order template is approved.",
                qtyFraction: mapping.qty_fraction,
                approved: false,
                autoOrderAllowed: false,
                source: "mapping",
            });
        }
    }

    return Array.from(rows.values()).sort((a, b) => a.finaleSku.localeCompare(b.finaleSku));
}

function getTemplateStatus(template: AxiomOrderTemplate): CompletionStatus {
    if (template.approved && template.auto_order_allowed) return "ready";
    if (template.approved) return "manual_ready";
    return "needs_spec";
}

function statusPresentation(status: CompletionStatus): Pick<CompletionRow, "statusLabel" | "statusTone"> {
    switch (status) {
        case "ready":
            return { statusLabel: "Ready to order", statusTone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" };
        case "manual_ready":
            return { statusLabel: "Manual ready", statusTone: "border-sky-500/30 bg-sky-500/10 text-sky-300" };
        case "needs_spec":
            return { statusLabel: "Needs spec approval", statusTone: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
        case "reconciliation_only":
            return { statusLabel: "Reconciliation only", statusTone: "border-zinc-700 bg-zinc-900 text-zinc-300" };
    }
}

function summarizeSpec(spec: Record<string, unknown> | null): string {
    if (!spec || Object.keys(spec).length === 0) return "No verified Axiom print spec yet.";
    const parts = Object.entries(spec)
        .filter(([, value]) => value !== null && value !== "")
        .map(([key, value]) => `${key}: ${String(value)}`);
    return parts.length > 0 ? parts.join(" | ") : "No verified Axiom print spec yet.";
}

function FlowStep({ icon, label, detail }: { icon: React.ReactNode; label: string; detail: string }) {
    return (
        <div className="rounded border border-zinc-800 bg-zinc-950/55 px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <span className="text-emerald-400">{icon}</span>
                <span>{label}</span>
            </div>
            <div className="mt-1 text-[10px] leading-relaxed text-zinc-500">{detail}</div>
        </div>
    );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
    return (
        <div className={`rounded border px-3 py-2 ${tone}`}>
            <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
            <div className="mt-1 text-lg font-semibold">{value}</div>
        </div>
    );
}

export default AxiomSkuMappingPanel;
