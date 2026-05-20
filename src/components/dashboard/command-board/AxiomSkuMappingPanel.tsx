/**
 * @file    AxiomSkuMappingPanel.tsx
 * @purpose Premium CRUD dashboard panel to manage dynamic Axiom-to-Finale SKU mappings.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    react, lucide-react
 */
"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
    AlertCircle,
    CheckCircle2,
    Edit2,
    Loader2,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    X
} from "lucide-react";

export type AxiomSkuMapping = {
    axiom_job_name: string;
    finale_skus: string[];
    qty_fraction: number;
    description: string | null;
    created_at?: string;
    updated_at?: string;
};

export function AxiomSkuMappingPanel() {
    // State lists
    const [mappings, setMappings] = useState<AxiomSkuMapping[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    // Filter/Search state
    const [searchQuery, setSearchQuery] = useState<string>("");

    // Form/Editor state
    const [showForm, setShowForm] = useState<boolean>(false);
    const [isEditing, setIsEditing] = useState<boolean>(false);
    const [formSubmitting, setFormSubmitting] = useState<boolean>(false);
    const [deleteConfirmJob, setDeleteConfirmJob] = useState<string | null>(null);
    const [deletingJob, setDeletingJob] = useState<boolean>(false);

    // Form Fields
    const [axiomJobName, setAxiomJobName] = useState<string>("");
    const [finaleSkusText, setFinaleSkusText] = useState<string>("");
    const [qtyFraction, setQtyFraction] = useState<string>("1.0");
    const [description, setDescription] = useState<string>("");

    // Fetch mappings from next API
    const fetchMappings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/axiom-sku-mappings");
            if (!res.ok) {
                throw new Error(`HTTP Error ${res.status}`);
            }
            const data = await res.json();
            setMappings(data.mappings ?? []);
        } catch (err: any) {
            console.error("Error fetching mappings:", err);
            setError("Failed to load mappings. Please try again.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchMappings();
    }, [fetchMappings]);

    // Handle Form Submit (Upsert)
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccessMessage(null);

        // Validation
        if (!axiomJobName.trim()) {
            setError("Axiom Job Name is required.");
            return;
        }

        const skus = finaleSkusText
            .split(",")
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (skus.length === 0) {
            setError("At least one Finale SKU must be specified.");
            return;
        }

        const fraction = parseFloat(qtyFraction);
        if (isNaN(fraction) || fraction <= 0) {
            setError("Quantity Fraction must be a positive number.");
            return;
        }

        setFormSubmitting(true);

        try {
            const res = await fetch("/api/axiom-sku-mappings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    axiom_job_name: axiomJobName.trim(),
                    finale_skus: skus,
                    qty_fraction: fraction,
                    description: description.trim() || null,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Failed to save mapping");
            }

            setSuccessMessage(
                isEditing
                    ? `Mapping for '${axiomJobName}' updated successfully.`
                    : `Mapping for '${axiomJobName}' created successfully.`
            );

            // Reset form
            resetForm();
            // Refresh list
            await fetchMappings();

            // Auto-dismiss success message
            setTimeout(() => setSuccessMessage(null), 4000);
        } catch (err: any) {
            console.error("Submit error:", err);
            setError(err.message || "Failed to save the mapping rules.");
        } finally {
            setFormSubmitting(false);
        }
    };

    // Open editor with populated data
    const handleEdit = (mapping: AxiomSkuMapping) => {
        setError(null);
        setSuccessMessage(null);
        setIsEditing(true);
        setAxiomJobName(mapping.axiom_job_name);
        setFinaleSkusText(mapping.finale_skus.join(", "));
        setQtyFraction(mapping.qty_fraction.toString());
        setDescription(mapping.description ?? "");
        setShowForm(true);

        // Scroll to form nicely
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // Delete mapping rules
    const handleDelete = async (jobName: string) => {
        setError(null);
        setSuccessMessage(null);
        setDeletingJob(true);

        try {
            const res = await fetch(`/api/axiom-sku-mappings?axiom_job_name=${encodeURIComponent(jobName)}`, {
                method: "DELETE",
            });
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Failed to delete mapping");
            }

            setSuccessMessage(`Mapping for '${jobName}' deleted successfully.`);
            setDeleteConfirmJob(null);
            await fetchMappings();

            setTimeout(() => setSuccessMessage(null), 4000);
        } catch (err: any) {
            console.error("Delete error:", err);
            setError(err.message || "Failed to delete mapping.");
        } finally {
            setDeletingJob(false);
        }
    };

    const resetForm = () => {
        setAxiomJobName("");
        setFinaleSkusText("");
        setQtyFraction("1.0");
        setDescription("");
        setIsEditing(false);
        setShowForm(false);
    };

    // Search and filter mappings list
    const filteredMappings = mappings.filter(m => {
        const query = searchQuery.toLowerCase().trim();
        if (!query) return true;

        const matchesJobName = m.axiom_job_name.toLowerCase().includes(query);
        const matchesDescription = (m.description ?? "").toLowerCase().includes(query);
        const matchesSkus = m.finale_skus.some(sku => sku.toLowerCase().includes(query));

        return matchesJobName || matchesDescription || matchesSkus;
    });

    return (
        <div className="flex flex-col h-full bg-[#09090b] text-zinc-100 p-4 space-y-4 overflow-y-auto">
            {/* Top Section */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-zinc-800/80 pb-4">
                <div>
                    <h2 className="text-base font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
                        <span>Axiom-to-Finale SKU Correlations</span>
                        {loading && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
                    </h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                        Manage dynamic job mapping definitions. Changes are immediately applied to new invoice processes.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={fetchMappings}
                        disabled={loading}
                        className="p-1.5 rounded border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/80 text-zinc-300 disabled:opacity-50 transition-all focus:outline-none focus:ring-1 focus:ring-zinc-700"
                        title="Reload Mappings"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                    </button>
                    {!showForm && (
                        <button
                            type="button"
                            onClick={() => {
                                resetForm();
                                setShowForm(true);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-500 hover:bg-blue-600 active:scale-[0.98] text-white font-semibold text-xs transition-all shadow-md shadow-blue-500/10 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Add Mapping
                        </button>
                    )}
                </div>
            </div>

            {/* Notification / Toast Toasts */}
            {successMessage && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 text-emerald-300 text-xs font-mono animate-in fade-in slide-in-from-top-2 duration-200">
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                    <span>{successMessage}</span>
                </div>
            )}

            {error && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-rose-500/20 bg-rose-500/10 text-rose-300 text-xs font-mono animate-in fade-in slide-in-from-top-2 duration-200">
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                    <span className="flex-1">{error}</span>
                    <button type="button" onClick={() => setError(null)} className="text-rose-400 hover:text-rose-300 p-0.5">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Creation / Editing Form (Collapsible Card) */}
            {showForm && (
                <form
                    onSubmit={handleSubmit}
                    className="border border-zinc-800/80 rounded-lg bg-zinc-950/60 p-4 space-y-3.5 shadow-xl animate-in fade-in slide-in-from-top-3 duration-300 relative overflow-hidden"
                >
                    <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-blue-500/20 via-blue-500/60 to-blue-500/20" />

                    <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 font-mono">
                            {isEditing ? "Modify Mapping Definition" : "Register New SKU Correlation"}
                        </span>
                        <button
                            type="button"
                            onClick={resetForm}
                            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/60 transition-colors focus:outline-none"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Axiom Job Name */}
                        <div className="space-y-1">
                            <label htmlFor="axiom_job_name" className="block text-[11px] font-medium text-zinc-400 uppercase font-mono tracking-wider">
                                Axiom Job Name <span className="text-rose-400">*</span>
                            </label>
                            <input
                                id="axiom_job_name"
                                type="text"
                                disabled={isEditing}
                                value={axiomJobName}
                                onChange={e => setAxiomJobName(e.target.value)}
                                placeholder="e.g. APL102"
                                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-200 text-xs font-mono placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:bg-zinc-900/20 disabled:cursor-not-allowed transition-all"
                            />
                            {isEditing && (
                                <p className="text-[10px] text-zinc-500 font-mono">
                                    Primary key cannot be modified. Delete and recreate if renaming is required.
                                </p>
                            )}
                        </div>

                        {/* Finale SKUs */}
                        <div className="space-y-1">
                            <label htmlFor="finale_skus" className="block text-[11px] font-medium text-zinc-400 uppercase font-mono tracking-wider">
                                Target Finale SKU(s) <span className="text-rose-400">*</span>
                            </label>
                            <input
                                id="finale_skus"
                                type="text"
                                value={finaleSkusText}
                                onChange={e => setFinaleSkusText(e.target.value)}
                                placeholder="e.g. GNS11, GNS21 (comma separated)"
                                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-200 text-xs font-mono placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
                            />
                            <p className="text-[10px] text-zinc-500 font-mono">
                                List multiple SKUs separated by commas for splits (e.g. Front/Back designs).
                              </p>
                        </div>

                        {/* Quantity Fraction */}
                        <div className="space-y-1">
                            <label htmlFor="qty_fraction" className="block text-[11px] font-medium text-zinc-400 uppercase font-mono tracking-wider">
                                Quantity Fraction / Multiplier <span className="text-rose-400">*</span>
                            </label>
                            <input
                                id="qty_fraction"
                                type="number"
                                step="0.01"
                                min="0.01"
                                value={qtyFraction}
                                onChange={e => setQtyFraction(e.target.value)}
                                placeholder="e.g. 1.0 (Full), 0.5 (Half/Split)"
                                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-200 text-xs font-mono placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
                            />
                            <p className="text-[10px] text-zinc-500 font-mono">
                                Use 1.0 for standard mapping. Use 0.5 for F+B labels matching separate front and back SKUs.
                            </p>
                        </div>

                        {/* Description */}
                        <div className="space-y-1">
                            <label htmlFor="description" className="block text-[11px] font-medium text-zinc-400 uppercase font-mono tracking-wider">
                                Description / Notes
                            </label>
                            <input
                                id="description"
                                type="text"
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                placeholder="e.g. 3.0 Soil Cubic Foot Label"
                                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 text-zinc-200 text-xs placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-900">
                        <button
                            type="button"
                            onClick={resetForm}
                            className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 text-xs font-mono font-medium transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={formSubmitting}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-semibold transition-all focus:outline-none"
                        >
                            {formSubmitting && <Loader2 className="w-3 h-3 animate-spin text-zinc-100" />}
                            Save Mapping
                        </button>
                    </div>
                </form>
            )}

            {/* Search and Table Grid Container */}
            <div className="flex-1 min-h-[350px] border border-zinc-800/60 rounded-lg bg-zinc-950/40 flex flex-col overflow-hidden">
                {/* Search Bar */}
                <div className="p-3 border-b border-zinc-850 bg-zinc-950/60 flex items-center gap-2">
                    <Search className="w-4 h-4 text-zinc-500 shrink-0 ml-1" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search mappings by Job Name, SKUs, or Notes..."
                        className="w-full bg-transparent text-zinc-200 placeholder-zinc-600 text-xs focus:outline-none"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="p-0.5 rounded hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>

                {/* Table Data */}
                <div className="flex-1 overflow-auto">
                    {loading && mappings.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 space-y-3">
                            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                            <span className="text-xs font-mono text-zinc-500">Retrieving mapping tables...</span>
                        </div>
                    ) : filteredMappings.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-center px-4">
                            <span className="text-3xl">🗂️</span>
                            <h3 className="text-xs font-semibold text-zinc-300 mt-2.5">No mappings found</h3>
                            <p className="text-[11px] text-zinc-500 max-w-xs mt-1">
                                {searchQuery
                                    ? "No mappings match your current query. Try refining your spelling or keyword search."
                                    : "No Axiom SKU mapping records currently exist in the database. Use the Add button to create your first mapping rule."}
                            </p>
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse table-auto">
                            <thead>
                                <tr className="border-b border-zinc-900 bg-zinc-950/80 text-[10px] uppercase font-mono tracking-wider text-zinc-400">
                                    <th className="px-4 py-2 font-medium">Axiom Job Name</th>
                                    <th className="px-4 py-2 font-medium">Target Finale SKUs</th>
                                    <th className="px-4 py-2 font-medium text-center">Multiplier</th>
                                    <th className="px-4 py-2 font-medium">Description</th>
                                    <th className="px-4 py-2 font-medium text-right pr-5">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-900 text-xs">
                                {filteredMappings.map(m => {
                                    const isDeleting = deleteConfirmJob === m.axiom_job_name;

                                    return (
                                        <tr
                                            key={m.axiom_job_name}
                                            className="hover:bg-zinc-900/30 transition-colors group"
                                        >
                                            {/* Job Name */}
                                            <td className="px-4 py-2.5 font-mono font-medium text-zinc-200">
                                                {m.axiom_job_name}
                                            </td>

                                            {/* Finale SKUs */}
                                            <td className="px-4 py-2.5">
                                                <div className="flex flex-wrap gap-1">
                                                    {m.finale_skus.map(sku => (
                                                        <span
                                                            key={sku}
                                                            className="px-1.5 py-0.5 rounded border border-blue-500/25 bg-blue-500/10 text-blue-400 font-mono text-[10px] uppercase tracking-wide"
                                                        >
                                                            {sku}
                                                        </span>
                                                    ))}
                                                </div>
                                            </td>

                                            {/* Quantity Fraction */}
                                            <td className="px-4 py-2.5 text-center font-mono text-zinc-400">
                                                <span className="px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-900/60 text-[10px] text-zinc-300 font-medium">
                                                    {m.qty_fraction}
                                                </span>
                                            </td>

                                            {/* Description */}
                                            <td className="px-4 py-2.5 text-zinc-400 max-w-xs truncate" title={m.description ?? ""}>
                                                {m.description || <span className="text-zinc-600 font-mono italic">no description</span>}
                                            </td>

                                            {/* Actions */}
                                            <td className="px-4 py-2.5 text-right pr-4">
                                                {isDeleting ? (
                                                    <div className="flex items-center justify-end gap-1.5 animate-in fade-in duration-150">
                                                        <span className="text-[10px] text-rose-400 font-mono mr-1">Confirm delete?</span>
                                                        <button
                                                            type="button"
                                                            disabled={deletingJob}
                                                            onClick={() => handleDelete(m.axiom_job_name)}
                                                            className="px-1.5 py-0.5 rounded bg-rose-500 hover:bg-rose-600 text-white text-[10px] font-semibold transition-colors disabled:opacity-50"
                                                        >
                                                            Delete
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={deletingJob}
                                                            onClick={() => setDeleteConfirmJob(null)}
                                                            className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-medium transition-colors"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
                                                        <button
                                                            type="button"
                                                            onClick={() => handleEdit(m)}
                                                            className="p-1 rounded bg-zinc-900 border border-zinc-800/80 hover:border-blue-500/50 hover:bg-zinc-800 text-zinc-400 hover:text-blue-400 transition-all focus:outline-none"
                                                            title="Edit Mapping"
                                                        >
                                                            <Edit2 className="w-3.5 h-3.5" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => setDeleteConfirmJob(m.axiom_job_name)}
                                                            className="p-1 rounded bg-zinc-900 border border-zinc-800/80 hover:border-rose-500/50 hover:bg-zinc-800 text-zinc-400 hover:text-rose-400 transition-all focus:outline-none"
                                                            title="Delete Mapping"
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Footer status summary */}
                <div className="px-4 py-2 border-t border-zinc-850 bg-zinc-950/60 flex items-center justify-between text-[10px] font-mono text-zinc-500">
                    <span>
                        Showing {filteredMappings.length} of {mappings.length} mappings
                    </span>
                    <span>
                        Active correlations override local fallback values
                    </span>
                </div>
            </div>
        </div>
    );
}

export default AxiomSkuMappingPanel;
