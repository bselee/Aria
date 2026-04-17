/**
 * @file    page.tsx
 * @purpose ARIA Operations Dashboard — 4-column draggable layout with floating chat
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-03-25
 * @deps    @dnd-kit/core, @dnd-kit/sortable, dashboard panel components
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    DndContext,
    DragOverlay,
    closestCorners,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragStartEvent,
    DragOverEvent,
    DragEndEvent,
    defaultDropAnimationSideEffects
} from "@dnd-kit/core";
import {
    SortableContext,
    arrayMove,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";

import ActivityFeed from "@/components/dashboard/ActivityFeed";
import BuildRiskPanel from "@/components/dashboard/BuildRiskPanel";
import BuildSchedulePanel from "@/components/dashboard/BuildSchedulePanel";
import ChatMirror from "@/components/dashboard/ChatMirror";
import InvoiceQueuePanel from "@/components/dashboard/InvoiceQueuePanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";
import PurchasingPanel from "@/components/dashboard/PurchasingPanel";
import { SortablePanel } from "@/components/dashboard/SortablePanel";
import ActivePurchasesPanel from "@/components/dashboard/ActivePurchasesPanel";
import PurchasingCalendarPanel from "@/components/dashboard/PurchasingCalendarPanel";
import StatementReconciliationPanel from "@/components/dashboard/StatementReconciliationPanel";
import TrackingBoardPanel from "@/components/dashboard/TrackingBoardPanel";
import OversightPanel from "@/components/dashboard/OversightPanel";


// ── Column width defaults (px) ──────────────────────────────────────
// DECISION(2026-03-25): Consolidated from 5 to 4 columns because the
// farRight + right columns were pushed off-screen on typical viewport widths.
// Total fixed widths ~880px leaves ~400px+ for the flex right column at 1280px.
const DEFAULT_LEFT_W = 300;
const DEFAULT_MIDLEFT_W = 280;
const DEFAULT_MIDRIGHT_W = 300;

function ColHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
    return (
        <div
            onMouseDown={onMouseDown}
            className="w-[5px] cursor-col-resize shrink-0 bg-zinc-900 hover:bg-zinc-700 border-x border-zinc-800/80 transition-colors"
            title="Drag to resize"
        />
    );
}

const PANEL_MAP: Record<string, React.ReactNode> = {
    "build-risk": <BuildRiskPanel />,
    "receivings": <ReceivedItemsPanel />,
    "activity": (
        <div className="flex flex-col flex-1 overflow-hidden min-h-[300px]">
            <ActivityFeed />
        </div>
    ),
    "invoice-queue": <InvoiceQueuePanel />,
    "statement-reconciliation": <StatementReconciliationPanel />,
    "purchasing": <PurchasingPanel />,
    "build-schedule": <BuildSchedulePanel />,
    "active-purchases": <ActivePurchasesPanel />,
    "tracking-board": <TrackingBoardPanel />,
    "purchasing-calendar": <PurchasingCalendarPanel />,
    "oversight": <OversightPanel />,
};

// ── Layout types ────────────────────────────────────────────────────
// DECISION(2026-03-25): Consolidated to 4 columns. 5-column layout pushed
// farRight + right off-screen on typical viewports. Build Schedule merged
// with Purchasing into midRight. ChatMirror stays as floating widget.
type ColumnId = "left" | "midLeft" | "midRight" | "right";
type LayoutState = Record<ColumnId, string[]>;

const DEFAULT_LAYOUT: LayoutState = {
    left: ["build-risk", "receivings"],
    // DECISION(2026-03-25): Removed axiom-queue from dashboard — Axiom ordering
    // is now fully autonomous (like ULINE). No manual review needed.
    midLeft: ["invoice-queue", "statement-reconciliation", "active-purchases", "tracking-board"],
    midRight: ["purchasing", "purchasing-calendar"],
    right: ["activity", "build-schedule"]
};

// All ColumnIds for iteration during layout merge / restore
const ALL_COLUMNS: ColumnId[] = ["left", "midLeft", "midRight", "right"];

function Column({ id, items, children, style, className }: { id: string, items: string[], children: React.ReactNode, style?: React.CSSProperties, className?: string }) {
    const { setNodeRef } = useDroppable({ id });
    return (
        <SortableContext id={id} items={items} strategy={verticalListSortingStrategy}>
            <div ref={setNodeRef} style={style} className={className}>
                {children}
            </div>
        </SortableContext>
    );
}

export default function DashboardPage() {
    const [leftW, setLeftW] = useState(DEFAULT_LEFT_W);
    const [midLeftW, setMidLeftW] = useState(DEFAULT_MIDLEFT_W);
    const [midRightW, setMidRightW] = useState(DEFAULT_MIDRIGHT_W);
    const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [chatOpen, setChatOpen] = useState(false);

    // Initialize layout from localStorage, avoiding hydration mismatch
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
        const lw = localStorage.getItem("aria-dash-left-w");
        const mlw = localStorage.getItem("aria-dash-midleft-w");
        const mrw = localStorage.getItem("aria-dash-midright-w");
        const ly = localStorage.getItem("aria-dash-layout");
        const co = localStorage.getItem("aria-dash-chat-open");

        if (lw) setLeftW(Math.max(200, Math.min(600, parseInt(lw))));
        if (mlw) setMidLeftW(Math.max(200, Math.min(600, parseInt(mlw))));
        if (mrw) setMidRightW(Math.max(200, Math.min(600, parseInt(mrw))));
        if (co === "true") setChatOpen(true);
        if (ly) {
            try {
                const restored = JSON.parse(ly);

                // DECISION(2026-03-09): Migrate old 3-col "mid" layouts.
                if (restored.mid && !restored.midLeft) {
                    const oldMid: string[] = restored.mid;
                    restored.midLeft = oldMid.filter((id: string) =>
                        DEFAULT_LAYOUT.midLeft.includes(id)
                    );
                    restored.midRight = oldMid.filter((id: string) =>
                        DEFAULT_LAYOUT.midRight.includes(id)
                    );
                    const placed = new Set([...restored.midLeft, ...restored.midRight]);
                    const overflow = oldMid.filter((id: string) => !placed.has(id));
                    restored.right = [...(restored.right || []), ...overflow];
                    delete restored.mid;
                }
                // DECISION(2026-03-25): Migrate old 5-col layout → 4-col.
                // Move any panels from the retired farRight column into midRight.
                if (restored.farRight) {
                    const farRightPanels: string[] = restored.farRight;
                    if (!restored.midRight) restored.midRight = [];
                    for (const id of farRightPanels) {
                        if (!restored.midRight.includes(id)) {
                            restored.midRight.push(id);
                        }
                    }
                    delete restored.farRight;
                }
                // Strip retired panels from all columns
                const RETIRED_PANELS = new Set(["chat-mirror", "reorder", "axiom-queue"]);
                for (const col of ALL_COLUMNS) {
                    if (restored[col]) {
                        restored[col] = (restored[col] as string[]).filter((id: string) => !RETIRED_PANELS.has(id));
                    }
                }
                // Deduplicate: if a panel appears in multiple columns, keep
                // only the first occurrence to avoid React key warnings.
                const seen = new Set<string>();
                for (const col of ALL_COLUMNS) {
                    if (restored[col]) {
                        restored[col] = (restored[col] as string[]).filter((id: string) => {
                            if (seen.has(id)) return false;
                            seen.add(id);
                            return true;
                        });
                    }
                }

                // Validate all four columns exist before restoring
                if (restored.left && restored.midLeft && restored.midRight && restored.right) {
                    // Merge any panels that exist in DEFAULT_LAYOUT but are missing from
                    // the saved layout (prevents new panels from being silently dropped
                    // by stale localStorage saves).
                    for (const col of ALL_COLUMNS) {
                        const defaults = DEFAULT_LAYOUT[col];
                        for (const id of defaults) {
                            const inSaved = ALL_COLUMNS.some(c =>
                                (restored[c] as string[])?.includes(id)
                            );
                            if (!inSaved) {
                                if (!restored[col]) restored[col] = [];
                                restored[col].push(id);
                            }
                        }
                    }
                    setLayout(restored);
                }
            } catch { /* corrupt localStorage — use defaults */ }
        }
    }, []);

    // Persist on change
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-left-w", String(leftW)); }, [leftW, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-midleft-w", String(midLeftW)); }, [midLeftW, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-midright-w", String(midRightW)); }, [midRightW, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-chat-open", String(chatOpen)); }, [chatOpen, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-layout", JSON.stringify(layout)); }, [layout, mounted]);

    // ── Resize handlers ─────────────────────────────────────────────
    const startLeftResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = leftW;
        const onMove = (ev: MouseEvent) =>
            setLeftW(Math.max(200, Math.min(600, startW + ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [leftW]);

    const startMidLeftResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = midLeftW;
        const onMove = (ev: MouseEvent) =>
            setMidLeftW(Math.max(200, Math.min(600, startW + ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [midLeftW]);

    const startMidRightResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = midRightW;
        const onMove = (ev: MouseEvent) =>
            setMidRightW(Math.max(200, Math.min(600, startW + ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [midRightW]);

    // DECISION(2026-03-25): Removed farRight column + resize handler (4-col layout).

    // ── DnD ─────────────────────────────────────────────────────────
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    function findContainer(id: string): ColumnId | undefined {
        if (id in layout) return id as ColumnId;
        return ALL_COLUMNS.find((key) => layout[key].includes(id));
    }

    function handleDragStart(event: DragStartEvent) {
        setActiveId(event.active.id as string);
    }

    function handleDragOver(event: DragOverEvent) {
        const { active, over } = event;
        const overId = over?.id;
        if (!overId) return;

        const activeContainer = findContainer(active.id as string);
        const overContainer = findContainer(overId as string);

        if (!activeContainer || !overContainer || activeContainer === overContainer) {
            return;
        }

        setLayout((prev) => {
            const activeItems = prev[activeContainer];
            const overItems = prev[overContainer];

            const overIndex = overItems.indexOf(overId as string);

            let newIndex;
            if (overId in prev) {
                // Dragging over the container itself (empty container or bottom edge)
                newIndex = overItems.length + 1;
            } else {
                newIndex = overIndex >= 0 ? overIndex : overItems.length + 1;
            }

            return {
                ...prev,
                [activeContainer]: activeItems.filter(item => item !== active.id),
                [overContainer]: [
                    ...overItems.slice(0, newIndex),
                    active.id as string,
                    ...overItems.slice(newIndex)
                ]
            };
        });
    }

    function handleDragEnd(event: DragEndEvent) {
        setActiveId(null);
        const { active, over } = event;
        const overId = over?.id;
        if (!overId) return;

        const activeContainer = findContainer(active.id as string);
        const overContainer = findContainer(overId as string);

        if (!activeContainer || !overContainer || activeContainer !== overContainer) {
            return;
        }

        const activeIndex = layout[activeContainer].indexOf(active.id as string);
        const overIndex = layout[overContainer].indexOf(overId as string);

        if (activeIndex !== overIndex) {
            setLayout((prev) => ({
                ...prev,
                [activeContainer]: arrayMove(prev[activeContainer], activeIndex, overIndex)
            }));
        }
    }

    // ── Shared column CSS ───────────────────────────────────────────
    const colClasses = "shrink-0 flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden h-full pb-20";
    const flexPanelIds = new Set(["activity", "chat-mirror"]);

    if (!mounted) {
        // Simple skeleton to prevent hydration mismatch
        return <main className="flex h-screen bg-[#09090b]"></main>;
    }

    return (
        <main className="flex h-screen overflow-hidden">
            {/* Sidebar */}
            <aside className="w-14 border-r border-zinc-800 bg-[#09090b] flex flex-col items-center py-4 shrink-0">
                <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center font-black tracking-tighter text-neon-blue shadow-[0_0_15px_rgba(59,130,246,0.2)] text-sm">A</div>
            </aside>

            <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
            >
                <section className="flex-1 flex flex-row overflow-hidden bg-[#09090b] min-w-0">

                    {/* ── Column 1: Operations ──────────────────────── */}
                    <Column id="left" items={layout.left} style={{ width: leftW }} className={colClasses}>
                        <header className="px-4 py-3 -m-4 mb-0 border-b border-zinc-800 bg-[#09090b] flex items-center justify-between shrink-0 sticky top-0 z-10 backdrop-blur-md">
                            <div>
                                <h1 className="text-sm font-semibold tracking-tight text-zinc-200">Ops</h1>
                            </div>
                            <div className="flex gap-2">
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/50">
                                    <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"></span>
                                    <span className="text-[11px] font-mono text-zinc-400">AP</span>
                                </div>
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/50">
                                    <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"></span>
                                    <span className="text-[11px] font-mono text-zinc-400">Watchdog</span>
                                </div>
                            </div>
                        </header>

                        {layout.left.map(id => (
                            <SortablePanel key={id} id={id} className={flexPanelIds.has(id) ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                    <ColHandle onMouseDown={startLeftResize} />

                    {/* ── Column 2: AP & Tracking ───────────────────── */}
                    <Column id="midLeft" items={layout.midLeft} style={{ width: midLeftW }} className={colClasses}>
                        {layout.midLeft.map(id => (
                            <SortablePanel key={id} id={id} className={flexPanelIds.has(id) ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                    <ColHandle onMouseDown={startMidLeftResize} />

                    {/* ── Column 3: Purchasing & Builds ─────────────── */}
                    <Column id="midRight" items={layout.midRight} style={{ width: midRightW }} className={colClasses}>
                        {layout.midRight.map(id => (
                            <SortablePanel key={id} id={id} className={flexPanelIds.has(id) ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                    <ColHandle onMouseDown={startMidRightResize} />

                    {/* ── Column 5: Activity ─────────────────────────── */}
                    <Column id="right" items={layout.right} className="flex-1 min-w-[240px] flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden h-full pb-20">
                        {layout.right.map(id => (
                            <SortablePanel key={id} id={id} className={flexPanelIds.has(id) ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                </section>

                <DragOverlay dropAnimation={{ sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.5' } } }) }}>
                    {activeId ? (
                        <div className="opacity-80 scale-[1.02] shadow-2xl pointer-events-none ring-2 ring-blue-500/50 rounded overflow-hidden">
                            {PANEL_MAP[activeId]}
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>

            {/* ── Floating Chat Widget ─────────────────────────────── */}
            {chatOpen && (
                <div className="fixed bottom-20 right-5 w-[420px] h-[560px] z-50 rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-zinc-700/70 bg-zinc-900 flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-200">
                    <ChatMirror />
                </div>
            )}

            {/* ── Chat Toggle FAB ─────────────────────────────────── */}
            <button
                onClick={() => setChatOpen(!chatOpen)}
                className={`fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 shadow-lg ${chatOpen
                        ? "bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rotate-0"
                        : "bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/30"
                    }`}
                title={chatOpen ? "Close Chat" : "Open Chat"}
            >
                {chatOpen ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                )}
            </button>
        </main>
    );
}
