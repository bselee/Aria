/**
 * @file    AgentHierarchyPanel.tsx
 * @purpose Left rail of the command board. Renders the reports-to tree
 *          from `/api/command-board/agents` with heartbeat dot, active task
 *          count, and click-to-filter behaviour.
 */
"use client";

import React, { useMemo } from "react";
import { Bot, ChevronRight } from "lucide-react";

import type { CommandBoardAgent, CommandBoardHeartbeat, CommandBoardTaskCard } from "./types";

type AgentHierarchyPanelProps = {
    agents: CommandBoardAgent[];
    heartbeats: CommandBoardHeartbeat[];
    tasks: CommandBoardTaskCard[];
    selectedAgentId: string | null;
    onSelectAgent: (agentId: string | null) => void;
};

type TreeNode = {
    agent: CommandBoardAgent;
    children: TreeNode[];
};

function buildTree(agents: CommandBoardAgent[]): TreeNode[] {
    const byId = new Map<string, TreeNode>();
    for (const a of agents) byId.set(a.id, { agent: a, children: [] });

    const roots: TreeNode[] = [];
    for (const node of byId.values()) {
        const parent = node.agent.reportsTo
            ? byId.get(node.agent.reportsTo)
            : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    return roots;
}

function staleness(
    heartbeats: CommandBoardHeartbeat[],
    agentName: string,
): "fresh" | "stale" | "degraded" | "unknown" {
    const hb = heartbeats.find(h => h.agent_name === agentName);
    if (!hb) return "unknown";
    return hb.staleness ?? "unknown";
}

function dotClass(state: ReturnType<typeof staleness>): string {
    switch (state) {
        case "fresh":
            return "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]";
        case "degraded":
            return "bg-amber-400";
        case "stale":
            return "bg-rose-500 animate-pulse";
        default:
            return "bg-zinc-600";
    }
}

function activeCountFor(
    agentLabel: string,
    tasks: CommandBoardTaskCard[],
): number {
    return tasks.filter(t => t.owner === agentLabel).length;
}

function TreeRow({
    node,
    depth,
    heartbeats,
    tasks,
    selectedAgentId,
    onSelectAgent,
}: {
    node: TreeNode;
    depth: number;
    heartbeats: CommandBoardHeartbeat[];
    tasks: CommandBoardTaskCard[];
    selectedAgentId: string | null;
    onSelectAgent: (id: string | null) => void;
}) {
    const state = staleness(heartbeats, node.agent.label);
    const active = activeCountFor(node.agent.label, tasks);
    const selected = selectedAgentId === node.agent.id;
    return (
        <div>
            <button
                type="button"
                aria-label={`Select agent ${node.agent.label}`}
                onClick={() =>
                    onSelectAgent(selected ? null : node.agent.id)
                }
                data-testid={`agent-row-${node.agent.id}`}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors text-xs ${
                    selected
                        ? "bg-blue-500/15 text-blue-100 border border-blue-500/40"
                        : "text-zinc-300 border border-transparent hover:bg-zinc-900 hover:border-zinc-800"
                }`}
                style={{ paddingLeft: 8 + depth * 12 }}
            >
                <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass(state)}`} />
                <Bot className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span className="flex-1 truncate">{node.agent.label}</span>
                {active > 0 ? (
                    <span className="text-[10px] font-mono text-zinc-400 px-1 rounded bg-zinc-800">
                        {active}
                    </span>
                ) : null}
                {node.children.length > 0 ? (
                    <ChevronRight className="w-3 h-3 text-zinc-600" />
                ) : null}
            </button>
            {node.children.map(child => (
                <TreeRow
                    key={child.agent.id}
                    node={child}
                    depth={depth + 1}
                    heartbeats={heartbeats}
                    tasks={tasks}
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={onSelectAgent}
                />
            ))}
        </div>
    );
}

export function AgentHierarchyPanel({
    agents,
    heartbeats,
    tasks,
    selectedAgentId,
    onSelectAgent,
}: AgentHierarchyPanelProps) {
    const tree = useMemo(() => buildTree(agents), [agents]);

    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <header className="px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/60 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
                    Agents
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                    {agents.length}
                </span>
            </header>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {tree.length === 0 ? (
                    <div className="text-center text-[10px] font-mono text-zinc-600 py-6">
                        no agents
                    </div>
                ) : (
                    tree.map(node => (
                        <TreeRow
                            key={node.agent.id}
                            node={node}
                            depth={0}
                            heartbeats={heartbeats}
                            tasks={tasks}
                            selectedAgentId={selectedAgentId}
                            onSelectAgent={onSelectAgent}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

export default AgentHierarchyPanel;
