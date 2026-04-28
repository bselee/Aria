/**
 * @file    AgentCatalogPanel.tsx
 * @purpose Read-only inspector for the catalog (skills / workflows /
 *          references) tied to the currently-selected agent. Pulled from
 *          `/api/command-board/agents` (full catalog response).
 */
"use client";

import React, { useMemo } from "react";
import { BookOpen, GitBranch, Sparkles } from "lucide-react";

import type {
    CommandBoardAgent,
    CommandBoardCatalog,
    CommandBoardSkill,
    CommandBoardWorkflow,
} from "./types";

type AgentCatalogPanelProps = {
    catalog: CommandBoardCatalog | null;
    selectedAgentId: string | null;
};

function findAgent(
    catalog: CommandBoardCatalog | null,
    id: string | null,
): CommandBoardAgent | null {
    if (!catalog || !id) return null;
    return catalog.agents.find(a => a.id === id) ?? null;
}

function intersectByName<T extends { name: string }>(
    items: T[],
    names: string[],
): T[] {
    const set = new Set(names);
    return items.filter(item => set.has(item.name));
}

function Section<T extends { id: string; name: string; path: string }>({
    title,
    icon: Icon,
    items,
}: {
    title: string;
    icon: typeof Sparkles;
    items: T[];
}) {
    if (items.length === 0) return null;
    return (
        <div>
            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <Icon className="w-3 h-3" />
                {title}
                <span className="text-zinc-600">({items.length})</span>
            </div>
            <div className="space-y-0.5">
                {items.map(item => (
                    <div
                        key={item.id}
                        className="px-2 py-1 rounded border border-zinc-800/40 bg-zinc-900/40 text-[11px] text-zinc-300"
                        title={item.path}
                    >
                        {item.name}
                    </div>
                ))}
            </div>
        </div>
    );
}

export function AgentCatalogPanel({
    catalog,
    selectedAgentId,
}: AgentCatalogPanelProps) {
    const agent = useMemo(
        () => findAgent(catalog, selectedAgentId),
        [catalog, selectedAgentId],
    );

    const skills: CommandBoardSkill[] = useMemo(() => {
        if (!catalog || !agent) return [];
        return intersectByName(catalog.skills, agent.skills);
    }, [catalog, agent]);

    const workflows: CommandBoardWorkflow[] = useMemo(() => {
        if (!catalog || !agent) return [];
        return intersectByName(catalog.workflows, agent.workflows);
    }, [catalog, agent]);

    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Catalog
                </span>
                {agent ? (
                    <span className="text-[10px] font-mono text-zinc-500 truncate">
                        {agent.label}
                    </span>
                ) : null}
            </header>
            <div className="flex-1 overflow-y-auto p-2 space-y-3">
                {!catalog ? (
                    <div className="text-center text-[10px] font-mono text-zinc-600 py-6">
                        loading catalog…
                    </div>
                ) : !agent ? (
                    <div className="text-center text-[10px] font-mono text-zinc-600 py-6">
                        select an agent to inspect skills & workflows
                    </div>
                ) : (
                    <>
                        {agent.process.length > 0 ? (
                            <div>
                                <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                                    <BookOpen className="w-3 h-3" />
                                    Process
                                </div>
                                <div className="space-y-0.5">
                                    {agent.process.map((p, idx) => (
                                        <div
                                            key={idx}
                                            className="px-2 py-1 rounded border border-zinc-800/40 bg-zinc-900/40 text-[11px] text-zinc-300"
                                        >
                                            {p}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                        <Section title="Skills" icon={Sparkles} items={skills} />
                        <Section
                            title="Workflows"
                            icon={GitBranch}
                            items={workflows}
                        />
                    </>
                )}
            </div>
        </div>
    );
}

export default AgentCatalogPanel;
