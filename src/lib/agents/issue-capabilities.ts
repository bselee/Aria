/**
 * @file    issue-capabilities.ts
 * @purpose Surface skills + playbooks + registered tools as a single
 *          "what can Aria DO" catalog. The orchestrator (Task 4) reads
 *          this to decide what next-action kinds are available for an
 *          issue. The control API (Task 5) returns the same shape so the
 *          UI can render capability badges.
 *
 *          Plan task 3 (docs/plans/2026-04-30-agentic-issue-orchestrator-control.md).
 */

import { listTools } from "./tool-registry";
import { buildCatalog } from "@/lib/command-board/catalog";
import { PLAYBOOK_BY_KIND } from "@/lib/intelligence/playbooks/registry";

export type IssueCapabilityKind = "skill" | "playbook" | "tool";

export type IssueCapability = {
    id: string;
    kind: IssueCapabilityKind;
    label: string;
    description: string;
    /** True when the capability is read-only / docs-only — safe to invoke in autonomous mode. */
    safeByDefault: boolean;
    /** True when invocation requires an approval gate (writes, mutations). */
    requiresApproval: boolean;
    /** Empty when unrestricted. Otherwise list of HANDLER ids that may invoke this. */
    handlerScope: string[];
};

export async function listIssueCapabilities(
    opts: { handler?: string } = {},
): Promise<IssueCapability[]> {
    const catalog = await buildCatalog();
    const tools = listTools(opts.handler ? { agentScope: opts.handler } : {});
    const out: IssueCapability[] = [];

    // Skills — discovered from .claude/skills/* via the catalog. Read-only
    // by definition (skills are docs/guides, not executable code).
    for (const skill of catalog.skills) {
        out.push({
            id: `skill:${skill.id}`,
            kind: "skill",
            label: skill.name,
            description: skill.description,
            safeByDefault: true,
            requiresApproval: false,
            handlerScope: [],
        });
    }

    // Playbooks — registered side-effect routines. Require approval by
    // default; the runner gates them via task NEEDS_APPROVAL.
    for (const [kind, playbook] of PLAYBOOK_BY_KIND) {
        out.push({
            id: `playbook:${kind}`,
            kind: "playbook",
            label: kind,
            description: playbook.description,
            safeByDefault: false,
            requiresApproval: true,
            handlerScope: [],
        });
    }

    // Tools — registered through tool-registry. Read tools are safe;
    // write tools require approval and may be gated by agentScope.
    for (const tool of tools) {
        out.push({
            id: `tool:${tool.name}`,
            kind: "tool",
            label: tool.name,
            description: tool.description,
            safeByDefault: tool.scope === "read",
            requiresApproval: tool.scope !== "read",
            handlerScope: [...tool.agentScope],
        });
    }

    return out.sort((a, b) =>
        `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`),
    );
}
