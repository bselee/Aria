/**
 * @file    src/lib/intelligence/notify.ts
 * @purpose THE notification surface for Aria. Replaces `telegram-notify.ts`
 *          (removed 2026-09-17 — Bill does not use Telegram). Alerts now land
 *          in the `agent_task` hub, which the dashboard surfaces at
 *          /dashboard/tasks; the console log keeps a local trace.
 *
 *          Contract kept deliberately close to the old send helpers so call
 *          sites did not need semantic rewrites:
 *            notify(msg)            -> notify(msg)
 *            notifyCritical(msg)    -> notifyCritical(msg)
 *            notify(m,b) -> notify(m, b)
 *
 *          `buttons` is accepted and IGNORED: interactive inline keyboards
 *          only existed on Telegram. Anything that needed an approve/reject
 *          tap now goes through the task hub's approval gate instead.
 *
 * @author  Hermia
 * @created 2026-09-17
 * @deps    ./agent-task (hub writer; best-effort)
 * @env     none
 */

/** Options for a notification. */
export interface NotifyOptions {
    /** Short title — becomes the task goal in the hub. */
    title?: string;
    /** Dedup key so repeated identical alerts collapse into one task row. */
    sourceId?: string;
    /** 0 = highest. Defaults to 3. */
    priority?: number;
    /** Extra structured context stored on the task row. */
    inputs?: Record<string, unknown>;
}

const DEFAULT_TITLE = "Aria notification";

/**
 * Emit a notification. Writes an `agent_task` row (deduped) and logs locally.
 * Never throws — a failed hub write must not break the caller's workflow.
 *
 * @param body    Message body (what used to be the Telegram message text)
 * @param _buttons Ignored. Formerly Telegram inline keyboards; retained so
 *                 existing call sites compile unchanged.
 * @param opts    Optional title/dedup/priority
 */
export async function notify(
    body: string,
    _buttons?: unknown[][],
    opts?: NotifyOptions,
): Promise<void> {
    await emit(body, opts, false);
}

/**
 * Emit a high-priority notification (the old "critical" path, which bypassed
 * the business-hours gate). Same hub write, priority 1.
 *
 * @param body Message body
 * @param opts Optional title/dedup/priority
 */
export async function notifyCritical(body: string, opts?: NotifyOptions): Promise<void> {
    await emit(body, opts, true);
}

async function emit(body: string, opts: NotifyOptions | undefined, critical: boolean): Promise<void> {
    const title = opts?.title ?? DEFAULT_TITLE;
    const text = String(body ?? "").trim();
    console.log(`[notify] ${critical ? "CRITICAL " : ""}${title}: ${text.slice(0, 300)}`);

    try {
        const { incrementOrCreate } = await import("./agent-task");
        await incrementOrCreate({
            type: "agent_exception",
            sourceTable: "cron_notify",
            sourceId: opts?.sourceId ?? stableSourceId(title, text),
            goal: `${title}: ${text.slice(0, 200)}`,
            inputs: { ...(opts?.inputs ?? {}), body: text, critical },
            priority: opts?.priority ?? (critical ? 1 : 3),
            owner: "aria",
        });
    } catch (e: any) {
        // Hub write is best-effort: notification must never break the caller.
        console.warn(`[notify] task-hub write failed (logged only): ${e?.message || e}`);
    }
}

/** Stable dedup key derived from the message, so repeats collapse. */
function stableSourceId(title: string, body: string): string {
    let hash = 0;
    const s = `${title}|${body.slice(0, 400)}`;
    for (let i = 0; i < s.length; i++) {
        hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return `notify:${Math.abs(hash).toString(36)}:${s.length}`;
}
