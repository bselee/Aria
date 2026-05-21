/**
 * @file    POStepper.tsx
 * @purpose Renders a highly visual, premium, and minimalist horizontal progress stepper for active purchases.
 *          Features clean concentric glowing nodes and removes cluttered/cheesy icons for a modern SaaS aesthetic.
 * @author  Antigravity
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    react
 */

import React, { useState } from "react";

export type StepperPO = {
    orderId: string;
    vendorName: string;
    status: string;
    orderDate: string;
    expectedDate: string;
    receiveDate: string | null;
    total: number;
    isReceived: boolean;
    completionState: string;
    trackingNumbers?: string[];
    shipments?: Array<{
        tracking_number: string;
        public_tracking_url: string | null;
        status_display: string | null;
        estimated_delivery_at: string | null;
    }>;
    lifecycleStage?: string;
    lifecycleSummary?: string;
    lastMovementSummary?: string | null;
    trackingUnavailableAt?: string | null;
    trackingRequestedAt?: string | null;
    vendorAcknowledgedAt?: string | null;
    sentVerification: {
        verified: boolean;
        sentAt: string | null;
        source: string | null;
        evidence?: Array<{ type: string; at: string | null; detail: string }>;
    };
};

interface POStepperProps {
    po: StepperPO;
}

interface StepDetail {
    title: string;
    description: string;
    date: string | null;
    status: "pending" | "active" | "completed" | "warning" | "error";
    extra?: string;
}

/**
 * Renders the visual lifecycle timeline stepper for a Purchase Order.
 * Implements a clean, high-end minimalist design with glowing concentric nodes.
 *
 * @param   props - Component props containing the active purchase order data
 * @returns JSX Element representing the horizontal visual progress track
 */
export const POStepper: React.FC<POStepperProps> = ({ po }) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const isCancelled = po.status.toLowerCase() === "cancelled";

    // 1. Sent Step
    const sentDate = po.sentVerification.sentAt || po.orderDate;
    const isSentCompleted = po.sentVerification.verified || !!po.orderDate;

    // 2. Recognized Step
    const ackDate = po.vendorAcknowledgedAt;
    const isAckCompleted = !!po.vendorAcknowledgedAt;
    const isAckWarning = po.lifecycleStage === "noncomm";

    // 3. Shipped Step
    const hasTracking = (po.trackingNumbers && po.trackingNumbers.length > 0) || (po.shipments && po.shipments.length > 0);
    const isShippedCompleted = hasTracking || po.isReceived;
    const isShippedWarning = po.lifecycleStage === "tracking_unavailable" || po.lifecycleStage === "ap_follow_up";
    const trackingDetail = po.lastMovementSummary || (po.trackingNumbers && po.trackingNumbers.length > 0 ? `${po.trackingNumbers.length} tracking capture(s)` : null);

    // 4. Received Step
    const rcvDate = po.receiveDate;
    const isRcvCompleted = po.isReceived;

    // 5. Reconciled Step
    const isReconciledCompleted = po.completionState === "complete";
    const reconciledDate = isReconciledCompleted ? po.receiveDate : null;

    // Assemble step metadata
    const steps: StepDetail[] = [
        {
            title: "Sent",
            description: isSentCompleted ? "PO transmitted to vendor" : "Drafting PO",
            date: sentDate ? new Date(sentDate).toLocaleDateString() : null,
            status: isCancelled ? "pending" : isSentCompleted ? "completed" : "active",
            extra: po.sentVerification.source ? `Source: ${po.sentVerification.source}` : undefined,
        },
        {
            title: "Recognized",
            description: isAckWarning 
                ? "Vendor non-communicative" 
                : isAckCompleted 
                ? "Vendor confirmed PO" 
                : "Awaiting vendor receipt",
            date: ackDate ? new Date(ackDate).toLocaleDateString() : null,
            status: isCancelled 
                ? "pending" 
                : isAckWarning 
                ? "error" 
                : isAckCompleted 
                ? "completed" 
                : isSentCompleted 
                ? "active" 
                : "pending",
            extra: po.lifecycleStage === "noncomm" ? "Follow-up required" : undefined,
        },
        {
            title: "Shipped",
            description: isShippedWarning 
                ? "Tracking request outstanding" 
                : isShippedCompleted 
                ? "Dispatched with tracking" 
                : "Awaiting shipment details",
            date: po.shipments && po.shipments[0]?.estimated_delivery_at 
                ? `ETA: ${new Date(po.shipments[0].estimated_delivery_at).toLocaleDateString()}` 
                : po.expectedDate 
                ? `Exp: ${new Date(po.expectedDate).toLocaleDateString()}` 
                : null,
            status: isCancelled 
                ? "pending" 
                : isShippedWarning 
                ? "warning" 
                : isShippedCompleted 
                ? "completed" 
                : isAckCompleted 
                ? "active" 
                : "pending",
            extra: trackingDetail ?? undefined,
        },
        {
            title: "Received",
            description: isRcvCompleted ? "Warehouse logged receipt" : "Awaiting physical arrival",
            date: rcvDate ? new Date(rcvDate).toLocaleDateString() : null,
            status: isCancelled 
                ? "pending" 
                : isRcvCompleted 
                ? "completed" 
                : isShippedCompleted 
                ? "active" 
                : "pending",
        },
        {
            title: "Reconciled",
            description: isReconciledCompleted ? "Invoice completely matched" : "Awaiting vendor invoice match",
            date: reconciledDate ? new Date(reconciledDate).toLocaleDateString() : null,
            status: isCancelled 
                ? "pending" 
                : isReconciledCompleted 
                ? "completed" 
                : isRcvCompleted 
                ? "active" 
                : "pending",
        },
    ];

    // Determine color schemes based on step status
    const getStatusStyles = (status: StepDetail["status"]) => {
        switch (status) {
            case "completed":
                return {
                    node: "bg-emerald-500 border-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.4)]",
                    inner: "bg-emerald-200 w-1 h-1",
                    label: "text-emerald-400 font-semibold",
                    line: "bg-emerald-500/60",
                };
            case "active":
                return {
                    node: "bg-cyan-500 border-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.6)] animate-pulse",
                    inner: "bg-white w-1.5 h-1.5 animate-ping rounded-full absolute",
                    innerStatic: "bg-white w-1 h-1 z-10",
                    label: "text-cyan-300 font-semibold",
                    line: "bg-zinc-800",
                };
            case "warning":
                return {
                    node: "bg-amber-500 border-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
                    inner: "bg-amber-100 w-1 h-1",
                    label: "text-amber-400 font-semibold",
                    line: "bg-amber-500/30",
                };
            case "error":
                return {
                    node: "bg-rose-500 border-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.5)]",
                    inner: "bg-rose-100 w-1 h-1",
                    label: "text-rose-400 font-semibold",
                    line: "bg-rose-500/30",
                };
            case "pending":
            default:
                return {
                    node: "bg-zinc-800 border-zinc-700/60",
                    inner: "bg-zinc-900 w-0.5 h-0.5",
                    label: "text-zinc-600",
                    line: "bg-zinc-900/60",
                };
        }
    };

    return (
        <div className={`mt-2.5 px-2.5 py-2 rounded bg-zinc-950/15 border border-zinc-900/50 relative ${isCancelled ? "opacity-50" : ""}`}>
            <div className="flex items-center justify-between relative">
                {steps.map((step, idx) => {
                    const styles = getStatusStyles(step.status);
                    const isLast = idx === steps.length - 1;
                    const nextStyles = !isLast ? getStatusStyles(steps[idx + 1].status) : null;
                    const isHovered = hoveredIndex === idx;

                    return (
                        <div key={idx} className="flex-1 flex items-center relative" style={{ flexGrow: isLast ? 0 : 1 }}>
                            {/* Minimalist Glowing concentric dot node */}
                            <div 
                                className={`w-3 h-3 rounded-full flex items-center justify-center border transition-all duration-300 ease-out z-10 cursor-pointer ${styles.node} ${isHovered ? "scale-125 border-zinc-400" : ""}`}
                                onMouseEnter={() => setHoveredIndex(idx)}
                                onMouseLeave={() => setHoveredIndex(null)}
                            >
                                {/* Inner concentric indicator */}
                                {step.status === "active" && styles.innerStatic && (
                                    <div className={`rounded-full ${styles.innerStatic}`} />
                                )}
                                <div className={`rounded-full ${styles.inner}`} />
                            </div>

                            {/* Node Hover Tooltip Card */}
                            {isHovered && (
                                <div className="absolute top-5 left-1.5 -translate-x-1/2 bg-zinc-950/95 border border-zinc-800 p-2.5 rounded shadow-2xl z-30 w-52 pointer-events-none transition-all duration-150 ease-out backdrop-blur-md">
                                    <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-1 mb-1">
                                        <span className="text-[11px] font-semibold text-zinc-100">{step.title}</span>
                                        {step.date && <span className="text-[9px] font-mono text-zinc-500">{step.date}</span>}
                                    </div>
                                    <p className="text-[10px] text-zinc-400 leading-normal">{step.description}</p>
                                    {step.extra && (
                                        <p className="text-[9px] font-mono text-zinc-500 mt-1 border-t border-zinc-800/40 pt-1 truncate">
                                            {step.extra}
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Label underneath node (visible on larger screens, compact for small screens) */}
                            <div className="absolute top-5 left-1.5 -translate-x-1/2 flex flex-col items-center pointer-events-none hidden md:flex shrink-0">
                                <span className={`text-[9px] font-mono font-medium tracking-wide ${styles.label}`}>
                                    {step.title}
                                </span>
                            </div>

                            {/* Connected progress line */}
                            {!isLast && (
                                <div className="flex-1 h-[2px] mx-1 relative pointer-events-none">
                                    {/* Uncompleted gray line background */}
                                    <div className="absolute inset-0 bg-zinc-800/40 rounded-full" />
                                    {/* Glowing active line segment */}
                                    <div 
                                        className={`absolute inset-0 rounded-full transition-all duration-500 ease-out ${
                                            step.status === "completed" && nextStyles?.node.includes("emerald")
                                                ? "bg-emerald-500/40 shadow-[0_0_4px_rgba(16,185,129,0.2)]"
                                                : step.status === "completed"
                                                ? "bg-gradient-to-r from-emerald-500/40 to-zinc-800"
                                                : "bg-zinc-800"
                                        }`} 
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {/* Mobile label display */}
            <div className="mt-4 flex justify-between px-1 text-[8px] font-mono text-zinc-500 md:hidden pointer-events-none">
                {steps.map((s, i) => {
                    const styles = getStatusStyles(s.status);
                    return (
                        <span key={i} className={styles.label}>{s.title}</span>
                    );
                })}
            </div>
        </div>
    );
};
