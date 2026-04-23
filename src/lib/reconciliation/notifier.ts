import { ReconciliationRun } from './run-tracker';

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

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
    const token = TELEGRAM_BOT_TOKEN;
    const chatId = TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.warn('[ReconciliationNotifier] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
        return;
    }

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

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('[ReconciliationNotifier] Failed to send Telegram message:', err);
    }
}
