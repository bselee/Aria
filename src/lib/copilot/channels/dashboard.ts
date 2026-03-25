/**
 * @file    src/lib/copilot/channels/dashboard.ts
 * @purpose Thin dashboard adapter over the shared copilot core.
 *
 *          Dashboard API routes delegate normal Q&A reasoning here.
 *          The HTTP route shape (request/response) stays in the Next.js
 *          route handler — this module only handles reasoning.
 */

import { runCopilotTurn } from "../core";

export interface DashboardSendInput {
    message:    string;
    sessionId?: string;
}

export interface DashboardSendResult {
    reply:    string;
    channel:  "dashboard";
    providerUsed:     string;
    toolCalls:        string[];
    actionRefs:       string[];
    boundArtifactId?: string;
}

export async function handleDashboardSend(input: DashboardSendInput): Promise<DashboardSendResult> {
    const result = await runCopilotTurn({
        channel:  "dashboard",
        text:     input.message,
        threadId: input.sessionId ?? "dashboard-default",
    });

    return {
        ...result,
        channel: "dashboard",
    };
}
