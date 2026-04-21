import type { OpsControlCommand } from "./control-plane";

export interface ClearStuckProcessingResult {
    emailQueue: number;
    apQueue: number;
    nightshiftQueue: number;
}

export interface BotControlCommandDeps {
    pollAPInbox: () => Promise<void>;
    runNightshiftLoop: () => Promise<void>;
    clearStuckProcessing: () => Promise<ClearStuckProcessingResult>;
}

export async function executeBotControlCommand(
    command: Extract<OpsControlCommand, "run_ap_poll_now" | "run_nightshift_now" | "clear_stuck_processing">,
    deps: BotControlCommandDeps,
): Promise<string> {
    if (command === "run_ap_poll_now") {
        await deps.pollAPInbox();
        return "ap_poll_completed";
    }

    if (command === "run_nightshift_now") {
        await deps.runNightshiftLoop();
        return "nightshift_run_completed";
    }

    const resetCounts = await deps.clearStuckProcessing();
    const totalCleared = resetCounts.emailQueue + resetCounts.apQueue + resetCounts.nightshiftQueue;
    return `stuck_processing_cleared:${totalCleared}`;
}
