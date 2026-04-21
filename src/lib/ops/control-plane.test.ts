import { describe, expect, it } from "vitest";

import {
    buildHeartbeatRecord,
    buildOpsHealthDecision,
    defaultTargetForCommand,
    isSupabaseProjectReady,
    type OpsControlCommand,
    type OpsHealthSnapshot,
} from "./control-plane";

function makeSnapshot(overrides: Partial<OpsHealthSnapshot> = {}): OpsHealthSnapshot {
    return {
        projectStatus: "ACTIVE",
        staleCrons: [],
        botHeartbeatAgeMinutes: 2,
        apQueueBacklogAgeMinutes: 0,
        apProcessingStuckCount: 0,
        nightshiftBacklogAgeMinutes: 0,
        nightshiftProcessingStuckCount: 0,
        pendingExceptionCount: 0,
        lastApForwardAgeMinutes: 5,
        lastNightshiftCompletionAgeMinutes: 30,
        ...overrides,
    };
}

describe("isSupabaseProjectReady", () => {
    it("treats ACTIVE as ready", () => {
        expect(isSupabaseProjectReady("ACTIVE")).toBe(true);
        expect(isSupabaseProjectReady("ACTIVE_HEALTHY")).toBe(true);
    });

    it("treats non-active states as not ready", () => {
        expect(isSupabaseProjectReady("COMING_UP")).toBe(false);
        expect(isSupabaseProjectReady("INACTIVE")).toBe(false);
        expect(isSupabaseProjectReady(null)).toBe(false);
    });
});

describe("defaultTargetForCommand", () => {
    it("routes restart requests to the watchdog", () => {
        expect(defaultTargetForCommand("restart_bot")).toBe("watchdog");
    });

    it("routes in-process controls to the bot", () => {
        const botCommands: OpsControlCommand[] = [
            "run_ap_poll_now",
            "run_nightshift_now",
            "clear_stuck_processing",
        ];

        for (const command of botCommands) {
            expect(defaultTargetForCommand(command)).toBe("aria-bot");
        }
    });
});

describe("buildHeartbeatRecord", () => {
    it("captures degraded status when the project is not ready", () => {
        const heartbeat = buildHeartbeatRecord({
            agentName: "aria-bot",
            projectStatus: "COMING_UP",
            metadata: { source: "boot" },
        });

        expect(heartbeat.agentName).toBe("aria-bot");
        expect(heartbeat.status).toBe("degraded");
        expect(heartbeat.metadata.projectStatus).toBe("COMING_UP");
        expect(heartbeat.metadata.source).toBe("boot");
    });
});

describe("buildOpsHealthDecision", () => {
    it("recommends restart when the AP cron and heartbeat are stale", () => {
        const decision = buildOpsHealthDecision(
            makeSnapshot({
                staleCrons: ["APPolling"],
                botHeartbeatAgeMinutes: 22,
            }),
        );

        expect(decision.degraded).toBe(true);
        expect(decision.shouldAlert).toBe(true);
        expect(decision.shouldRestart).toBe(true);
        expect(decision.reasons).toContain("stale_cron:APPolling");
        expect(decision.reasons).toContain("bot_heartbeat_stale");
    });

    it("alerts without restarting when only a long-interval cron is stale", () => {
        const decision = buildOpsHealthDecision(
            makeSnapshot({
                staleCrons: ["DailySummary"],
            }),
        );

        expect(decision.degraded).toBe(true);
        expect(decision.shouldAlert).toBe(true);
        expect(decision.shouldRestart).toBe(false);
        expect(decision.reasons).toContain("stale_cron:DailySummary");
    });

    it("suppresses restart when a recent restart request already exists", () => {
        const decision = buildOpsHealthDecision(
            makeSnapshot({
                staleCrons: ["APPolling"],
                botHeartbeatAgeMinutes: 15,
            }),
            { hasRecentRestartRequest: true },
        );

        expect(decision.degraded).toBe(true);
        expect(decision.shouldAlert).toBe(true);
        expect(decision.shouldRestart).toBe(false);
        expect(decision.reasons).toContain("recent_restart_request");
    });

    it("degrades without recommending restart while Supabase is still coming up", () => {
        const decision = buildOpsHealthDecision(
            makeSnapshot({
                projectStatus: "COMING_UP",
            }),
        );

        expect(decision.degraded).toBe(true);
        expect(decision.shouldAlert).toBe(true);
        expect(decision.shouldRestart).toBe(false);
        expect(decision.reasons).toContain("project_not_ready:COMING_UP");
    });
});
