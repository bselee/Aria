/**
 * @file    src/cli/hermes-escalate.ts
 * @purpose CLI bridge: Hermes oversight → Aria agent_task hub.
 *          Thin wrapper around agentTask.incrementOrCreate().
 *          Hermes cron jobs call this to surface findings in Will's
 *          normal task UI (/dashboard/tasks + Telegram /tasks).
 *
 *          Uses incrementOrCreate() (not upsertFromSource) —
 *          dedup_count bumps on repeats, avoids stale-row spam.
 *          Respects HUB_TASKS_ENABLED for one-line rollback.
 *
 * @usage   node --import tsx src/cli/hermes-escalate.ts \
 *            --kind=cognitive_critical \
 *            --goal="AP pipeline: 3 stuck items" \
 *            --owner=aria \
 *            --priority=1 \
 *            --source-id="ap-stuck-2026-06-16T15"
 *
 * @author  Hermia
 * @created 2026-06-16
 * @deps    @/lib/intelligence/agent-task
 * @env     HUB_TASKS_ENABLED (default: true)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { incrementOrCreate } from "@/lib/intelligence/agent-task";
import type { AgentTaskType, AgentTaskOwner, ClosurePredicate } from "@/lib/intelligence/agent-task";

function parseArgs(): {
    kind: AgentTaskType;
    goal: string;
    owner: AgentTaskOwner;
    priority: number;
    sourceId: string;
    closesWhen?: ClosurePredicate;
    inputs?: Record<string, unknown>;
} {
    const args = process.argv.slice(2);
    const parsed: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].slice(2);
            const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
            parsed[key] = val;
        }
    }

    const kind = (parsed.kind || "cognitive_critical") as AgentTaskType;
    const goal = parsed.goal;
    if (!goal) {
        console.error("Usage: hermes-escalate.ts --goal='...' [--kind=cognitive_critical] [--owner=aria] [--priority=1] [--source-id=...] [--closes-when=...]");
        process.exit(0); // Best-effort: don't block caller
    }

    return {
        kind,
        goal,
        owner: (parsed.owner || "aria") as AgentTaskOwner,
        priority: parseInt(parsed.priority || "1", 10),
        sourceId: parsed["source-id"] || `hermes-${Date.now()}`,
        closesWhen: parsed["closes-when"] as ClosurePredicate | undefined,
        inputs: parsed.inputs ? JSON.parse(parsed.inputs) : undefined,
    };
}

async function main() {
    const { kind, goal, owner, priority, sourceId, closesWhen, inputs } = parseArgs();

    const hashInputs: Record<string, unknown> = { goal, kind, sourceId };
    if (inputs) Object.assign(hashInputs, inputs);

    console.log(`[hermes-escalate] Escalating to agent_task: ${kind} — ${goal.slice(0, 80)}`);

    const taskId = await incrementOrCreate({
        sourceTable: "hermes-oversight",
        sourceId,
        type: kind,
        goal,
        status: "PENDING",
        owner,
        priority,
        requiresApproval: false,
        inputs: hashInputs,
        closesWhen,
    });

    if (taskId) {
        console.log(`[hermes-escalate] ✓ Task ${taskId} created/updated (dedup-safe)`);
    } else {
        console.log(`[hermes-escalate] → Hub unavailable or disabled (HUB_TASKS_ENABLED). Non-fatal.`);
    }

    // ALWAYS exit 0 — best-effort, never block the caller
    process.exit(0);
}

main();
