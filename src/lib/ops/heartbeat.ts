/**
 * @file    src/lib/ops/heartbeat.ts
 * @purpose Aria system heartbeat runner. Executes every liveness probe in
 *          src/lib/ops/heartbeat-probes.ts in parallel, aggregates failures,
 *          rate-limits repeat alerts, and emits a single consolidated Telegram
 *          message when something is newly unhealthy. Healthy ticks are silent
 *          ("no news is good news"). Invoked by the `system-heartbeat` cron.
 * @author  Hermia
 * @created 2026-06-11
 */

import { HEARTBEAT_PROBES, type ProbeResult, type ProbeSpec } from "@/lib/ops/heartbeat-probes";
import { sendTelegramNotify, sendCriticalTelegramNotify } from "@/lib/intelligence/telegram-notify";

/** Re-alert suppression window: a given probe failure is not re-sent within this span. */
const ALERT_WINDOW_MS = 30 * 60_000;

/**
 * In-memory record of the last time each probe failure was alerted, keyed by
 * probe name. Survives between cron ticks within a single aria-bot process;
 * resets on restart (acceptable — a restart re-surfaces standing failures).
 */
const lastAlertedAt = new Map<string, number>();

/** A probe failure paired with its spec metadata. */
interface Failure {
    spec: ProbeSpec;
    result: ProbeResult;
}

/**
 * Run one probe defensively. A thrown probe (which should not happen, since
 * probes are written to resolve) is converted into a failing {@link ProbeResult}
 * so a single misbehaving probe can never crash the heartbeat runner.
 *
 * @param spec The probe to execute.
 */
async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
    try {
        return await spec.probe();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { name: spec.name, ok: false, message: `Probe threw: ${message}`, detail: err };
    }
}

/**
 * Format the consolidated Telegram alert body from the failing probes.
 *
 * @param failures Newly-alerting failures to render.
 */
function formatAlert(failures: Failure[]): string {
    const lines: string[] = ["🚨 Aria System Alert", "───────────────────"];
    for (const f of failures) {
        lines.push(`❌ ${f.result.name}: ${f.result.message}`);
    }
    return lines.join("\n");
}

/**
 * Run all heartbeat probes, aggregate failures, suppress already-alerted ones
 * within the 30-minute window, and send a single consolidated Telegram alert
 * for any newly-unhealthy probes. Critical failures bypass business hours;
 * non-critical failures route through the business-hours-gated channel. When
 * everything is healthy (or every failure was recently alerted), nothing is
 * sent — only a console summary is logged.
 *
 * Never throws: probe-level and notify-level errors are caught and logged so a
 * heartbeat tick can always complete.
 */
export async function runSystemHeartbeat(): Promise<void> {
    const settled = await Promise.allSettled(HEARTBEAT_PROBES.map((spec) => runProbe(spec)));

    const failures: Failure[] = [];
    settled.forEach((outcome, i) => {
        const spec = HEARTBEAT_PROBES[i];
        const result: ProbeResult =
            outcome.status === "fulfilled"
                ? outcome.value
                : { name: spec.name, ok: false, message: "Probe rejected unexpectedly", detail: outcome.reason };
        if (!result.ok) {
            failures.push({ spec, result });
            if (result.detail !== undefined) {
                console.warn(`[system-heartbeat] FAIL ${result.name}: ${result.message}`, result.detail);
            } else {
                console.warn(`[system-heartbeat] FAIL ${result.name}: ${result.message}`);
            }
        }
    });

    // Rate-limit: drop failures alerted within the suppression window.
    const now = Date.now();
    const newFailures = failures.filter((f) => {
        const last = lastAlertedAt.get(f.result.name);
        return last === undefined || now - last >= ALERT_WINDOW_MS;
    });

    if (newFailures.length > 0) {
        const message = formatAlert(newFailures);
        const anyCritical = newFailures.some((f) => f.spec.critical);
        try {
            if (anyCritical) {
                await sendCriticalTelegramNotify(message);
            } else {
                await sendTelegramNotify(message);
            }
            // Only mark as alerted once the send succeeds, so a transient send
            // failure doesn't suppress the next tick's retry.
            for (const f of newFailures) lastAlertedAt.set(f.result.name, now);
        } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            console.warn(`[system-heartbeat] Telegram alert failed: ${m}`);
        }
    }

    console.log(
        `[system-heartbeat] ${HEARTBEAT_PROBES.length} probes, ${failures.length} failures, ${newFailures.length} newly-alerted`,
    );
}
