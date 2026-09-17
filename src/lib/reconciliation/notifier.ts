import { ReconciliationRun } from './run-tracker';


function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

function duration(startedAt: Date, endedAt: Date): string {
    const ms = endedAt.getTime() - startedAt.getTime();
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

export async function sendReconciliationSummary(run: ReconciliationRun): Promise<void> {
    const r = run.getRecord();
    // 2026-09-17: no transport credential needed — notifications go to the task hub.
    let message: string;

    if (r.status === 'failed') {
        const lastError = r.errors[r.errors.length - 1];
        message = [
            `❌ ${r.vendor} reconciliation FAILED`,
            r.summary ? `Step: ${r.summary}` : '',
            lastError ? `Error: ${lastError.message}` : '',
            r.errors.length > 1 ? `(${r.errors.length} errors total)` : '',
            `\nSee: https://supabase.com/project/_/editor/table/reconciliation_runs?id=${r.id}`,
        ].filter(Boolean).join('\n');
    } else {
        const emoji = r.status === 'success' ? '✅' : '⚠️';
        const endedAt = r.ended_at ?? new Date();
        const freight = r.freight_added_cents > 0 ? ` · ${formatCents(r.freight_added_cents)} freight added` : '';
        message = [
            `${emoji} ${r.vendor} reconciliation (${r.mode})`,
            `${r.invoices_found} invoices · ${r.pos_updated} POs updated${freight}`,
            `Duration: ${duration(r.started_at, endedAt)}`,
            r.errors.length > 0 || r.warnings.length > 0
                ? `[${r.errors.length} errors · ${r.warnings.length} warnings]`
                : '',
        ].filter(Boolean).join('\n');
    }

    // 2026-09-17: was a direct api.telegram.org send. Telegram removed — the
    // summary now goes to the agent_task hub (dashboard /dashboard/tasks).
    try {
        const { notify } = await import("@/lib/intelligence/notify");
        await notify(message, undefined, { title: "Reconciliation run" });
    } catch (err) {
        console.error('[ReconciliationNotifier] Failed to record notification:', err);
    }
}
