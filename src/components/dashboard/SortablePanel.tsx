import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripHorizontal } from "lucide-react";

export function SortablePanel({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 1,
        opacity: isDragging ? 0.3 : 1,
        position: "relative" as const,
    };

    return (
        <div ref={setNodeRef} style={style} className={`group relative flex flex-col min-h-[100px] resize-y overflow-hidden bg-[#0c0c0e] border border-zinc-800/80 rounded-lg shadow-sm ${className || "shrink-0"}`}>
            {/* Drag handle */}
            <div
                {...attributes}
                {...listeners}
                className="absolute top-1 left-1.5 p-1 cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-200 z-50 rounded bg-zinc-900/80 backdrop-blur opacity-0 group-hover:opacity-100 transition-opacity shadow-sm border border-zinc-700/50"
                title="Drag to move panel"
            >
                <GripHorizontal className="w-3.5 h-3.5" />
            </div>

            {/* Child Panel */}
            {children}
        </div>
    );
}

