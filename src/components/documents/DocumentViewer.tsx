"use client";

import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, GitBranch, CheckCircle, AlertTriangle } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

interface DocumentViewerProps {
    pdfUrl: string;
    extractedData: Record<string, unknown>;
    documentType: string;
    matchResult?: { matched: boolean; confidence: string; discrepancies: Array<{ field: string; delta?: number; severity: string }> };
    onApprove?: () => void;
    onCreateIssue?: () => void;
}

export function DocumentViewer({
    pdfUrl, extractedData, documentType, matchResult, onApprove, onCreateIssue
}: DocumentViewerProps) {
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState(1);
    const [scale, setScale] = useState(1.2);

    const blockingDiscrepancies = matchResult?.discrepancies.filter(d => d.severity === "blocking") ?? [];
    const canAutoApprove = matchResult?.matched && blockingDiscrepancies.length === 0;

    return (
        <div className="flex h-full bg-zinc-950 overflow-hidden">
            {/* PDF Panel */}
            <div className="flex-1 flex flex-col border-r border-zinc-800 overflow-hidden">
                {/* PDF Controls */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900">
                    <div className="flex items-center gap-2">
                        <button onClick={() => setPageNumber(p => Math.max(1, p - 1))} disabled={pageNumber <= 1}
                            className="p-1.5 rounded hover:bg-zinc-700 disabled:opacity-30">
                            <ChevronLeft size={16} />
                        </button>
                        <span className="text-sm font-mono text-zinc-400">{pageNumber} / {numPages}</span>
                        <button onClick={() => setPageNumber(p => Math.min(numPages, p + 1))} disabled={pageNumber >= numPages}
                            className="p-1.5 rounded hover:bg-zinc-700 disabled:opacity-30">
                            <ChevronRight size={16} />
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setScale(s => Math.max(0.5, s - 0.2))} className="p-1.5 rounded hover:bg-zinc-700">
                            <ZoomOut size={16} />
                        </button>
                        <span className="text-xs text-zinc-500 w-12 text-center">{Math.round(scale * 100)}%</span>
                        <button onClick={() => setScale(s => Math.min(3, s + 0.2))} className="p-1.5 rounded hover:bg-zinc-700">
                            <ZoomIn size={16} />
                        </button>
                        <a href={pdfUrl} download className="p-1.5 rounded hover:bg-zinc-700">
                            <Download size={16} />
                        </a>
                    </div>
                </div>

                {/* PDF Viewer */}
                <div className="flex-1 overflow-auto flex justify-center p-4 bg-zinc-900">
                    <Document
                        file={pdfUrl}
                        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                        className="shadow-2xl"
                    >
                        <Page
                            pageNumber={pageNumber}
                            scale={scale}
                            renderTextLayer={true}
                            renderAnnotationLayer={true}
                            className="border border-zinc-700"
                        />
                    </Document>
                </div>
            </div>

            {/* Data Panel */}
            <div className="w-96 flex flex-col overflow-hidden">
                {/* Match Status Header */}
                <div className={`px-4 py-3 border-b border-zinc-800 flex items-center gap-2 ${canAutoApprove ? "bg-emerald-950/40" :
                        matchResult?.matched ? "bg-amber-950/40" : "bg-zinc-900"
                    }`}>
                    {canAutoApprove ? (
                        <><CheckCircle size={16} className="text-emerald-400" />
                            <span className="text-sm text-emerald-400 font-medium">Matched — Ready for approval</span></>
                    ) : matchResult?.matched ? (
                        <><AlertTriangle size={16} className="text-amber-400" />
                            <span className="text-sm text-amber-400 font-medium">{blockingDiscrepancies.length} discrepancy{blockingDiscrepancies.length !== 1 ? "s" : ""} found</span></>
                    ) : (
                        <><AlertTriangle size={16} className="text-zinc-500" />
                            <span className="text-sm text-zinc-500">No matching PO found</span></>
                    )}
                </div>

                {/* Extracted Data */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    <ExtractedDataPanel data={extractedData} type={documentType} />

                    {/* Discrepancies */}
                    {matchResult?.discrepancies && matchResult.discrepancies.length > 0 && (
                        <div className="space-y-2">
                            <h3 className="text-xs font-mono text-zinc-500 uppercase tracking-wider">Discrepancies</h3>
                            {matchResult.discrepancies.map((d, i) => (
                                <div key={i} className={`px-3 py-2 rounded-lg border text-sm ${d.severity === "blocking" ? "border-red-800 bg-red-950/30 text-red-300" :
                                        d.severity === "warning" ? "border-amber-800 bg-amber-950/30 text-amber-300" :
                                            "border-zinc-700 bg-zinc-900 text-zinc-400"
                                    }`}>
                                    <div className="font-mono">{d.field}</div>
                                    {d.delta != null && (
                                        <div className="text-xs mt-0.5">Δ ${Math.abs(d.delta).toFixed(2)} {d.delta > 0 ? "over PO" : "under PO"}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="p-4 border-t border-zinc-800 space-y-2">
                    {canAutoApprove && (
                        <button onClick={onApprove}
                            className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                            <CheckCircle size={16} />
                            Approve for Payment
                        </button>
                    )}
                    <button onClick={onCreateIssue}
                        className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition-colors flex items-center justify-center gap-2">
                        <GitBranch size={16} />
                        Create GitHub Issue
                    </button>
                </div>
            </div>
        </div>
    );
}
