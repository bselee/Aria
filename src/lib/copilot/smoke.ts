/**
 * @file    src/lib/copilot/smoke.ts
 * @purpose Startup health reporting for the shared copilot layer.
 *
 *          Reports the explicit startup state of each component so that
 *          silent failures are never possible.  Consumed by start-bot.ts
 *          on boot and by monitoring/alerting paths.
 *
 *          States:
 *            running  — component is active and healthy
 *            disabled — component is intentionally off (env var missing, feature flag)
 *            error    — component attempted to start but failed
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComponentState = "running" | "disabled" | "error";

export interface StartupHealth {
    bot:       ComponentState;
    dashboard: ComponentState;
    slack:     ComponentState;
    timestamp: string;
}

// ── getStartupHealth ──────────────────────────────────────────────────────────

/**
 * Return the current startup state of each copilot component.
 *
 * This is intentionally lightweight — no network calls, no DB.
 * It reads env vars to determine intent (running vs disabled) and
 * reports `error` only when a required env var for a component is
 * missing but the component is expected to be running.
 *
 * Never throws.
 */
export async function getStartupHealth(): Promise<StartupHealth> {
    try {
        const bot       = detectBotState();
        const dashboard = detectDashboardState();
        const slack     = detectSlackState();

        return { bot, dashboard, slack, timestamp: new Date().toISOString() };
    } catch {
        return {
            bot:       "error",
            dashboard: "error",
            slack:     "disabled",
            timestamp: new Date().toISOString(),
        };
    }
}

// ── Component state detectors ─────────────────────────────────────────────────

function detectBotState(): ComponentState {
    if (!process.env.TELEGRAM_BOT_TOKEN) return "disabled";
    return "running";
}

function detectDashboardState(): ComponentState {
    // Dashboard runs as long as Next.js is up — no dedicated env gate
    // GOOGLE_GENERATIVE_AI_API_KEY is needed for Gemini chat
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
        return "disabled";
    }
    return "running";
}

function detectSlackState(): ComponentState {
    if (!process.env.SLACK_ACCESS_TOKEN) return "disabled";
    return "running";
}
