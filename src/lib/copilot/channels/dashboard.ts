import { logChatMessage } from "../../intelligence/chat-logger";
import { runCopilotTurn, type CopilotTurnResult } from "../core";

export interface DashboardSendInput {
    message: string;
    threadId?: string;
}

export async function handleDashboardSend(input: DashboardSendInput): Promise<CopilotTurnResult> {
    const threadId = input.threadId ?? "dashboard";

    await logChatMessage({
        source: "telegram",
        role: "user",
        content: input.message,
        threadId,
        metadata: { from: "dashboard" },
    });

    const result = await runCopilotTurn({
        channel: "dashboard",
        text: input.message,
        threadId,
    });

    await logChatMessage({
        source: "telegram",
        role: "assistant",
        content: result.reply,
        threadId,
        metadata: { from: "dashboard", provider: result.providerUsed },
    });

    return result;
}
