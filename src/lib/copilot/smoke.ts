export interface StartupHealth {
    bot: "running";
    dashboard: "ready";
    slack: "running" | "disabled";
    notes: string[];
}

export interface StartupHealthInput {
    hasSlackToken?: boolean;
    startSlackWatchdog?: () => Promise<void>;
}

export async function getStartupHealth(input: StartupHealthInput = {}): Promise<StartupHealth> {
    const notes: string[] = [];
    const hasSlackToken = input.hasSlackToken ?? Boolean(process.env.SLACK_ACCESS_TOKEN);

    if (!hasSlackToken) {
        return {
            bot: "running",
            dashboard: "ready",
            slack: "disabled",
            notes,
        };
    }

    try {
        await input.startSlackWatchdog?.();
        return {
            bot: "running",
            dashboard: "ready",
            slack: "running",
            notes,
        };
    } catch (err: any) {
        notes.push(`Slack watchdog failed to start: ${err.message}`);
        return {
            bot: "running",
            dashboard: "ready",
            slack: "disabled",
            notes,
        };
    }
}
