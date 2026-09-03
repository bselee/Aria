/**
 * @file    PanelErrorBoundary.tsx
 * @purpose Class-based React error boundary that contains a single panel's
 *          render crash so it doesn't take down sibling panels or the shell.
 *          Renders an inline dark-theme fallback card showing the panel label,
 *          error message, and a "Retry panel" button. Every panel in
 *          panelRegistry.tsx and every tab in CommandBoardShell.tsx MUST be
 *          wrapped in this.
 * @author  delegated engineer (Hermia oversight)
 * @created 2026-07-24
 * @deps    React (class component, ErrorInfo)
 */
"use client";

import React from "react";

export type PanelErrorBoundaryProps = {
    /** Human-readable label identifying the crashed panel (shown in the fallback UI). */
    label: string;
    children: React.ReactNode;
};

type PanelErrorBoundaryState = {
    error: Error | null;
};

/**
 * Error boundary that catches render errors in a single panel's subtree.
 * On catch, logs via console.error with a [PanelErrorBoundary] prefix and
 * renders a dark-theme fallback card with a Retry button that resets the
 * boundary to normal rendering.
 */
export class PanelErrorBoundary extends React.Component<
    PanelErrorBoundaryProps,
    PanelErrorBoundaryState
> {
    state: PanelErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
         
        console.error(`[PanelErrorBoundary] ${this.props.label} crashed:`, error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div
                    className="flex flex-col items-center justify-center h-full p-6 gap-2 text-center"
                    data-testid={`panel-error-boundary-${this.props.label.replace(/\s+/g, "-").toLowerCase()}`}
                >
                    <span className="text-rose-400 text-sm font-mono">
                        {this.props.label} crashed
                    </span>
                    <span className="text-zinc-500 text-xs max-w-sm">
                        {this.state.error.message}
                    </span>
                    <button
                        type="button"
                        onClick={() => this.setState({ error: null })}
                        className="mt-2 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-xs"
                    >
                        Retry panel
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default PanelErrorBoundary;
