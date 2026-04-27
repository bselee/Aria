/**
 * @file supervisor-agent.ts
 * @purpose A meta-agent that monitors and attempts to recover other agents from failure.
 *          It polls the `ops_agent_exceptions` queue and attempts to execute automated remedies
 *          or escalates to human operators via Telegram.
 * @author Aria (Antigravity)
 */

import { createClient } from "../supabase";
import { Telegraf } from "telegraf";
import * as agentTask from "./agent-task";
import { unifiedObjectGeneration } from "./llm";
import { z } from "zod";
import { remember, recall, Memory } from "./memory";
import { recordFeedback } from "./feedback-loop";

export class SupervisorAgent {
    private bot: Telegraf;

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    /**
     * Determines the appropriate action for a specific agent error.
     */
    private async classifyErrorAndRemedy(agent: string, errorMessage: string, errorStack: string): Promise<string> {
        const schema = z.object({
            remedy: z.enum(["RETRY", "ESCALATE", "IGNORE"]),
            reasoning: z.string().describe("Why this remedy was chosen")
        });

        // Retrieve memories of past errors and how they were handled
        const memories = await recall(`Agent ${agent} error: ${errorMessage}`, { category: "decision", topK: 3, minScore: 0.6 });

        let memoryContext = "";
        if (memories.length > 0) {
            memoryContext = "\n\nPast Experiences:\n" + memories.map(m => `- ${m.content}`).join("\n");
        }

        const prompt = `You are the Supervisor Agent overseeing an AP/Purchasing Multi-Agent System.
An agent has encountered an unhandled exception and crashed.
Agent: ${agent}
Error: ${errorMessage}
Stack: ${errorStack.slice(0, 1000)}

Determine the best recovery action:
- RETRY: The error appears transient (network timeout, rate limit, quota exceeded, temporary 500 error). We should try again.
- ESCALATE: The error is logic-based (TypeError, undefined is not a function) or requires a human to fix the underlying data or code.
- IGNORE: Expected or noisy error that doesn't affect system stability.
${memoryContext}

Respond strictly balancing these criteria, and leveraging past experiences if relevant.`;

        try {
            const res = (await unifiedObjectGeneration({
                system: "You are the MAS Supervisor. Choose the correct recovery action. Return JSON.",
                prompt,
                schema,
                schemaName: "SupervisorRemedy"
            })) as { remedy: string, reasoning: string };

            console.log(`     [Supervisor] Determined remedy for ${agent}: ${res.remedy} (${res.reasoning})`);
            return res.remedy;
        } catch (e: any) {
            console.error(`     [Supervisor] Failed to classify error, defaulting to ESCALATE:`, e.message);
            return "ESCALATE";
        }
    }

    /**
     * Polls the exception queue and resolves/escalates pending errors.
     */
    async supervise() {
        console.log(`🛡️ [Supervisor-Agent] Checking for recent agent exceptions...`);
        const supabase = createClient();

        if (!supabase) {
            console.error("❌ [Supervisor-Agent] Supabase client unavailable — check env vars.");
            return;
        }

        try {
            const { data: exceptions, error } = await supabase
                .from('ops_agent_exceptions')
                .select('*')
                .eq('status', 'pending');

            if (error) throw error;
            if (!exceptions || exceptions.length === 0) return;

            console.log(`   Found ${exceptions.length} pending error(s) to evaluate.`);

            for (const rootCause of exceptions) {
                // Mirror to control-plane hub. Idempotent via the partial unique index
                // on (source_table, source_id) — safe to call on every supervise() pass.
                // We do this at the TOP of the loop because nothing else creates the hub
                // row for this exception (the reportAgentException call from ops-manager
                // is currently a no-op; a future PR can wire it). This way the
                // updateBySource calls in the three branches always find the hub row.
                // Phase 2.5: incrementOrCreate dedups identical-shape exceptions.
                try {
                    const task = await agentTask.incrementOrCreate({
                        sourceTable: 'ops_agent_exceptions',
                        sourceId: String(rootCause.id),
                        type: 'agent_exception',
                        goal: `Agent ${rootCause.agent_name} raised an exception: ${String(rootCause.error_message ?? '(no message)').slice(0, 120)}`,
                        status: 'PENDING',
                        owner: 'aria',
                        priority: 1,
                        inputs: {
                            agent_name: rootCause.agent_name,
                            error_message: rootCause.error_message,
                            context_data: rootCause.context_data,
                        },
                    });
                    if (!rootCause.task_id) {
                        await supabase.from('ops_agent_exceptions')
                            .update({ task_id: task.id })
                            .eq('id', rootCause.id);
                    }
                } catch { /* hub write is best-effort */ }

                // Determine course of action
                const remedy = await this.classifyErrorAndRemedy(
                    rootCause.agent_name,
                    rootCause.error_message,
                    rootCause.error_stack || ""
                );

                if (remedy === "ESCALATE") {
                    await this.escalateToHuman(rootCause.agent_name, rootCause.error_message, rootCause.error_stack || "");

                    await supabase.from('ops_agent_exceptions')
                        .update({ status: 'escalated', resolution_notes: 'Pushed to Telegram' })
                        .eq('id', rootCause.id);

                    // Mirror to control-plane hub: this exception now needs human attention.
                    await agentTask.updateBySource('ops_agent_exceptions', String(rootCause.id), {
                        status: 'NEEDS_APPROVAL',
                        owner: 'will',
                    });

                    // Remember this outcome so it learns
                    await remember({
                        category: "decision",
                        content: `For agent ${rootCause.agent_name} and error "${rootCause.error_message}", the supervisor decided to ESCALATE to a human.`,
                        relatedTo: rootCause.agent_name,
                        source: "SupervisorAgent",
                        tags: ["escalate", "crash", rootCause.agent_name]
                    });

                } else if (remedy === "RETRY") {
                    // For now, retry just means we ignore it and let the next cron pick it up,
                    // assuming the original agent didn't successfully lock the queue row or API state
                    // and will organically try again automatically on next tick.
                    // If we need explicit requeuing, we read `rootCause.context_data` here.
                    await supabase.from('ops_agent_exceptions')
                        .update({ status: 'resolved', resolution_notes: 'Transient error, ignoring to allow organic retry.' })
                        .eq('id', rootCause.id);

                    // Mirror to control-plane hub: classified as transient, expected to self-heal.
                    await agentTask.updateBySource('ops_agent_exceptions', String(rootCause.id), {
                        status: 'SUCCEEDED',
                        outputs: { remedy: 'RETRY', resolution: 'transient — organic retry on next tick' },
                    });

                    // Remember this outcome so it learns
                    await remember({
                        category: "decision",
                        content: `For agent ${rootCause.agent_name} and error "${rootCause.error_message}", the supervisor determined it was transient and decided to RETRY.`,
                        relatedTo: rootCause.agent_name,
                        source: "SupervisorAgent",
                        tags: ["retry", "crash", rootCause.agent_name]
                    });

                } else if (remedy === "IGNORE") {
                    await supabase.from('ops_agent_exceptions')
                        .update({ status: 'ignored', resolution_notes: 'Noise pattern identified.' })
                        .eq('id', rootCause.id);

                    // Mirror to control-plane hub: noise, close as cancelled.
                    await agentTask.updateBySource('ops_agent_exceptions', String(rootCause.id), {
                        status: 'CANCELLED',
                        outputs: { remedy: 'IGNORE', resolution: 'noise pattern' },
                    });

                    // Remember this outcome so it learns
                    await remember({
                        category: "decision",
                        content: `For agent ${rootCause.agent_name} and error "${rootCause.error_message}", the supervisor determined it was noise and decided to IGNORE.`,
                        relatedTo: rootCause.agent_name,
                        source: "SupervisorAgent",
                        tags: ["ignore", "crash", rootCause.agent_name]
                    });
                }

                // Kaizen: record error pattern feedback (Pillar 5 — Self-Improving Error Handling)
                recordFeedback({
                    category: "error_pattern",
                    eventType: `agent_error_${remedy.toLowerCase()}`,
                    agentSource: "supervisor",
                    subjectType: "message",
                    subjectId: rootCause.agent_name,
                    prediction: { errorMessage: rootCause.error_message.slice(0, 200) },
                    actualOutcome: { remedy, resolved: remedy !== "ESCALATE" },
                    accuracyScore: remedy === "ESCALATE" ? 0.3 : remedy === "RETRY" ? 0.7 : 0.5,
                    userAction: remedy === "ESCALATE" ? "corrected" : undefined,
                    contextData: {
                        agent: rootCause.agent_name,
                        stackSnippet: (rootCause.error_stack || "").slice(0, 300),
                    },
                }).catch(() => { /* non-blocking */ });
            }
        } catch (err: any) {
            console.error("❌ [Supervisor-Agent] Critical failure while supervising:", err.message);
        }
    }

    private async escalateToHuman(agentName: string, errorMessage: string, errorStack: string) {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
            console.warn("   ⚠️ TELEGRAM_CHAT_ID missing; cannot escalate.");
            return;
        }

        const stackSnippet = errorStack.split('\n').slice(0, 3).join('\n');

        try {
            await this.bot.telegram.sendMessage(
                chatId,
                `🚨 <b>Agent Crash Escalation</b> 🚨\n\n<b>Agent:</b> ${agentName}\n<b>Supervisor Assessment:</b> Fix required.\n<b>Error:</b> ${errorMessage}\n<pre>${stackSnippet}</pre>`,
                { parse_mode: 'HTML' }
            );
            console.log(`     [Supervisor] ↗️ Escalated ${agentName} failure to Engineering.`);
        } catch (tgErr: any) {
            console.error(`     ❌ Failed to send escalation via Telegram:`, tgErr.message);
        }
    }
}
