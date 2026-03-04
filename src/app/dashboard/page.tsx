"use client";

import { useCallback, useEffect, useState } from "react";
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

import ActivityFeed from "@/components/dashboard/ActivityFeed";
import BuildRiskPanel from "@/components/dashboard/BuildRiskPanel";
import BuildSchedulePanel from "@/components/dashboard/BuildSchedulePanel";
import ChatMirror from "@/components/dashboard/ChatMirror";
import InvoiceQueuePanel from "@/components/dashboard/InvoiceQueuePanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";
import ReorderPanel from "@/components/dashboard/ReorderPanel";
import { SortablePanel } from "@/components/dashboard/SortablePanel";

const DEFAULT_LEFT_W = 480;
const DEFAULT_MID_W = 340;

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
    "build-risk": <BuildRiskPanel key="build-risk" />,
    "receivings": <ReceivedItemsPanel key="receivings" />,
    "activity": (
        <div key="activity" className="flex flex-col flex-1 overflow-hidden min-h-[300px]">
            <ActivityFeed />
        </div>
    ),
    "invoice-queue": <InvoiceQueuePanel key="invoice-queue" />,
    "reorder": <ReorderPanel key="reorder" />,
    "build-schedule": <BuildSchedulePanel key="build-schedule" />,
    "chat-mirror": (
        <div key="chat-mirror" className="flex flex-col flex-1 overflow-hidden min-h-[400px]">
            <ChatMirror />
        </div>
    )
};

type ColumnId = "left" | "mid" | "right";
type LayoutState = Record<ColumnId, string[]>;

const DEFAULT_LAYOUT: LayoutState = {
    left: ["build-risk", "receivings", "activity"],
    mid: ["invoice-queue", "reorder", "build-schedule"],
    right: ["chat-mirror"]
};

import { useDroppable } from "@dnd-kit/core";

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
    const [midW, setMidW] = useState(DEFAULT_MID_W);
    const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
    const [activeId, setActiveId] = useState<string | null>(null);

    // Initialize layout from localStorage, avoiding hydration mismatch
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
        const lw = localStorage.getItem("aria-dash-left-w");
        const mw = localStorage.getItem("aria-dash-mid-w");
        const ly = localStorage.getItem("aria-dash-layout");

        if (lw) setLeftW(Math.max(240, Math.min(760, parseInt(lw))));
        if (mw) setMidW(Math.max(200, Math.min(600, parseInt(mw))));
        if (ly) {
            try {
                const parsed = JSON.parse(ly);
                // Basic validation
                if (parsed.left && parsed.mid && parsed.right) setLayout(parsed);
            } catch (e) { }
        }
    }, []);

    // Persist on change
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-left-w", String(leftW)); }, [leftW, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-mid-w", String(midW)); }, [midW, mounted]);
    useEffect(() => { if (mounted) localStorage.setItem("aria-dash-layout", JSON.stringify(layout)); }, [layout, mounted]);

    const startLeftResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = leftW;
        const onMove = (ev: MouseEvent) =>
            setLeftW(Math.max(240, Math.min(760, startW + ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [leftW]);

    const startMidResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = midW;
        const onMove = (ev: MouseEvent) =>
            setMidW(Math.max(200, Math.min(600, startW + ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, [midW]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    function findContainer(id: string): ColumnId | undefined {
        if (id in layout) return id as ColumnId;
        return Object.keys(layout).find((key) => layout[key as ColumnId].includes(id)) as ColumnId | undefined;
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

            const activeIndex = activeItems.indexOf(active.id as string);
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

                    {/* Left column */}
                    <Column id="left" items={layout.left} style={{ width: leftW }} className="shrink-0 flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden h-full pb-20">
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
                            <SortablePanel key={id} id={id} className={id === "activity" || id === "chat-mirror" ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                    <ColHandle onMouseDown={startLeftResize} />

                    {/* Middle column */}
                    <Column id="mid" items={layout.mid} style={{ width: midW }} className="shrink-0 flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden h-full pb-20">
                        {layout.mid.map(id => (
                            <SortablePanel key={id} id={id} className={id === "activity" || id === "chat-mirror" ? "flex-1" : undefined}>
                                {PANEL_MAP[id]}
                            </SortablePanel>
                        ))}
                    </Column>

                    <ColHandle onMouseDown={startMidResize} />

                    {/* Right column */}
                    <Column id="right" items={layout.right} className="flex-1 min-w-[240px] flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden h-full pb-20">
                        {layout.right.map(id => (
                            <SortablePanel key={id} id={id} className={id === "activity" || id === "chat-mirror" ? "flex-1" : undefined}>
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
        </main>
    );
}
