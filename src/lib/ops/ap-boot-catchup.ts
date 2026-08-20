/**
 * @file    src/lib/ops/ap-boot-catchup.ts
 * @purpose After bot restart, recover a missed sparse ap-polling window
 *          (7:30/12:00/17:00 America/Denver) with one idempotent runJobOnce.
 *          Boot used to call deprecated pollAPInbox only — that path does
 *          not run the local forwarder.
 * @author  Hermia
 * @created 2026-08-07
 * @deps    cron/history, cron/runner
 * @env     none
 */

/** ap-polling fire windows in America/Denver (local wall clock). */
export const AP_POLLING_WINDOWS_DENVER = [
    { hour: 7, minute: 30 },
    { hour: 12, minute: 0 },
    { hour: 17, minute: 0 },
] as const;

/** @deprecated Use AP_POLLING_WINDOWS_DENVER — hour-only alias for the old 8/12/17 schedule. */
export const AP_POLLING_HOURS_DENVER = [7, 12, 17] as const;

export interface ApWindowSkipInput {
    /** Current instant (UTC Date). */
    now: Date;
    /** Most recent cron_runs.started_at for ap-polling, or null. */
    lastRunStartedAt: string | null | undefined;
    /**
     * How long after a scheduled window we still consider it "due"
     * for catch-up (covers boot that finishes a few minutes late).
     * Default 4 hours — half-way to the next sparse window.
     */
    catchUpHorizonMs?: number;
}

export interface ApWindowSkipResult {
    skipped: boolean;
    /** ISO of the most recent scheduled window at or before now. */
    windowAt: string | null;
    reason: string;
}

/**
 * Format a Date as YYYY-MM-DD and H/M parts in America/Denver.
 */
export function denverParts(d: Date): { y: number; m: number; day: number; hour: number; minute: number } {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    return {
        y: get("year"),
        m: get("month"),
        day: get("day"),
        hour: get("hour"),
        minute: get("minute"),
    };
}

/**
 * Build a UTC Date for a Denver local wall time on a calendar day.
 * Uses iterative offset resolution (handles MST/MDT).
 */
export function denverLocalToUtc(
    y: number,
    month: number,
    day: number,
    hour: number,
    minute = 0,
): Date {
    // First guess: treat as UTC, then correct by Denver offset at that instant.
    let guess = new Date(Date.UTC(y, month - 1, day, hour, minute, 0));
    for (let i = 0; i < 3; i++) {
        const p = denverParts(guess);
        const asDenverMs = Date.UTC(p.y, p.m - 1, p.day, p.hour, p.minute, 0);
        const wantMs = Date.UTC(y, month - 1, day, hour, minute, 0);
        const delta = wantMs - asDenverMs;
        if (delta === 0) break;
        guess = new Date(guess.getTime() + delta);
    }
    return guess;
}

/**
 * Most recent ap-polling window at or before `now` in Denver time.
 * Returns null only if something pathological happens (should not).
 */
export function mostRecentApPollingWindow(now: Date): Date {
    const p = denverParts(now);
    // Candidate windows: today's schedule slots ≤ now, else yesterday's 17:00.
    const todayCandidates = AP_POLLING_WINDOWS_DENVER
        .map((slot) => denverLocalToUtc(p.y, p.m, p.day, slot.hour, slot.minute))
        .filter((w) => w.getTime() <= now.getTime());

    if (todayCandidates.length > 0) {
        return todayCandidates[todayCandidates.length - 1]!;
    }

    // Before first window today → yesterday 17:00 Denver.
    const yesterdayProbe = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const y = denverParts(yesterdayProbe);
    return denverLocalToUtc(y.y, y.m, y.day, 17, 0);
}

/**
 * True when the latest scheduled ap-polling window has no successful-or-any
 * cron_runs row started at/after that window, and we are still inside the
 * catch-up horizon after the window.
 */
export function isApPollingWindowSkipped(input: ApWindowSkipInput): ApWindowSkipResult {
    const horizon = input.catchUpHorizonMs ?? 4 * 60 * 60 * 1000;
    const window = mostRecentApPollingWindow(input.now);
    const ageMs = input.now.getTime() - window.getTime();

    if (ageMs < 0) {
        return { skipped: false, windowAt: window.toISOString(), reason: "window_in_future" };
    }
    if (ageMs > horizon) {
        // Too late for this window — next scheduled tick owns it (or overnight gap).
        // Boot still may want a fresh local forward; callers decide force policy.
        return {
            skipped: false,
            windowAt: window.toISOString(),
            reason: "past_catchup_horizon",
        };
    }

    if (!input.lastRunStartedAt) {
        return {
            skipped: true,
            windowAt: window.toISOString(),
            reason: "no_prior_run",
        };
    }

    const lastMs = new Date(input.lastRunStartedAt).getTime();
    if (Number.isNaN(lastMs)) {
        return {
            skipped: true,
            windowAt: window.toISOString(),
            reason: "invalid_last_run",
        };
    }

    if (lastMs >= window.getTime()) {
        return {
            skipped: false,
            windowAt: window.toISOString(),
            reason: "window_already_covered",
        };
    }

    return {
        skipped: true,
        windowAt: window.toISOString(),
        reason: "window_missed",
    };
}

export interface ApBootCatchupResult {
    ran: boolean;
    reason: string;
    windowAt: string | null;
    jobStatus?: string;
}

/**
 * If the current sparse ap-polling window was missed, run one idempotent
 * `runJobOnce("ap-polling", "manual")` (local forwarder + full post-pass).
 * Safe on every boot: no-ops when the window already has a cron_runs row.
 *
 * @param deps - injectable for tests
 */
export async function runApBootCatchup(deps?: {
    now?: Date;
    lastRun?: () => Promise<{ started_at: string } | null>;
    runJob?: (name: string, by: "manual") => Promise<{ status: string }>;
    /** When true, run even if horizon says no (still skips if window covered). */
    forceIfUncovered?: boolean;
}): Promise<ApBootCatchupResult> {
    const now = deps?.now ?? new Date();

    let lastStarted: string | null = null;
    try {
        if (deps?.lastRun) {
            const row = await deps.lastRun();
            lastStarted = row?.started_at ?? null;
        } else {
            const { lastRun } = await import("../../cron/history");
            const row = await lastRun("ap-polling");
            lastStarted = row?.started_at ?? null;
        }
    } catch (err: any) {
        console.warn(`[ap-boot-catchup] lastRun failed: ${err?.message ?? err}`);
    }

    const decision = isApPollingWindowSkipped({
        now,
        lastRunStartedAt: lastStarted,
        // Allow catch-up for the full gap to the next window (~4–5h).
        catchUpHorizonMs: 5 * 60 * 60 * 1000,
    });

    // Always catch up when window is uncovered inside horizon.
    // Outside horizon but still no run today at all → optional force path.
    let shouldRun = decision.skipped;
    if (!shouldRun && deps?.forceIfUncovered && decision.reason === "past_catchup_horizon") {
        const window = mostRecentApPollingWindow(now);
        const lastMs = lastStarted ? new Date(lastStarted).getTime() : 0;
        if (lastMs < window.getTime()) {
            shouldRun = true;
            decision.reason = "forced_uncovered";
        }
    }

    if (!shouldRun) {
        return {
            ran: false,
            reason: decision.reason,
            windowAt: decision.windowAt,
        };
    }

    try {
        const runJob =
            deps?.runJob ??
            (async (name: string, by: "manual") => {
                const { runJobOnce } = await import("../../cron/runner");
                return runJobOnce(name, by);
            });

        console.log(
            `[ap-boot-catchup] Missed window ${decision.windowAt} (${decision.reason}) — running ap-polling once`,
        );
        const result = await runJob("ap-polling", "manual");
        return {
            ran: true,
            reason: decision.reason,
            windowAt: decision.windowAt,
            jobStatus: result.status,
        };
    } catch (err: any) {
        console.warn(`[ap-boot-catchup] run failed (non-fatal): ${err?.message ?? err}`);
        return {
            ran: false,
            reason: `run_failed:${err?.message ?? err}`,
            windowAt: decision.windowAt,
        };
    }
}
