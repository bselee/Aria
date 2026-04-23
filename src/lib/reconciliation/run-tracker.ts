import { createClient } from '@/lib/supabase';

interface RunRecord {
    id: string;
    vendor: string;
    mode: 'dry-run' | 'live';
    status: 'running' | 'success' | 'partial' | 'failed';
    started_at: Date;
    ended_at?: Date;
    invoices_found: number;
    invoices_processed: number;
    pos_updated: number;
    price_changes: number;
    freight_added_cents: number;
    errors: Array<{ message: string; context?: Record<string, unknown> }>;
    warnings: Array<{ message: string; context?: Record<string, unknown> }>;
    summary?: string;
    invoked_by: 'manual' | 'cron' | 'telegram';
    run_args: Record<string, unknown>;
}

export class ReconciliationRun {
    private record: RunRecord;
    private supabase = createClient();

    private constructor(record: RunRecord) {
        this.record = record;
    }

    static async start(
        vendor: string,
        mode: 'dry-run' | 'live',
        args: Record<string, unknown> = {},
        invokedBy: 'manual' | 'cron' | 'telegram' = 'manual'
    ): Promise<ReconciliationRun> {
        const record: RunRecord = {
            id: crypto.randomUUID(),
            vendor,
            mode,
            status: 'running',
            started_at: new Date(),
            invoices_found: 0,
            invoices_processed: 0,
            pos_updated: 0,
            price_changes: 0,
            freight_added_cents: 0,
            errors: [],
            warnings: [],
            invoked_by: invokedBy,
            run_args: args,
        };

        const sb = createClient();
        if (sb) {
            const { error } = await sb
                .from('reconciliation_runs')
                .insert({
                    id: record.id,
                    vendor: record.vendor,
                    mode: record.mode,
                    status: record.status,
                    started_at: record.started_at.toISOString(),
                    invoices_found: 0,
                    invoices_processed: 0,
                    pos_updated: 0,
                    price_changes: 0,
                    freight_added_cents: 0,
                    errors: [],
                    warnings: [],
                    invoked_by: record.invoked_by,
                    run_args: record.run_args,
                });

            if (error) console.error('[ReconciliationRun] failed to insert row:', error.message);
        }
        return new ReconciliationRun(record);
    }

    recordInvoiceFound(): void {
        this.record.invoices_found++;
    }

    recordInvoiceProcessed(): void {
        this.record.invoices_processed++;
    }

    recordPoUpdated(_poId: string): void {
        this.record.pos_updated++;
    }

    recordPriceChange(_sku: string, _oldPrice: number, _newPrice: number): void {
        this.record.price_changes++;
    }

    recordFreight(cents: number): void {
        this.record.freight_added_cents += cents;
    }

    recordWarning(message: string, context?: Record<string, unknown>): void {
        this.record.warnings.push({ message, context });
    }

    recordError(message: string, error?: Error, context?: Record<string, unknown>): void {
        this.record.errors.push({
            message: error ? `${message}: ${error.message}` : message,
            context,
        });
    }

    async complete(summary: string): Promise<void> {
        this.record.status = this.record.errors.length === 0 ? 'success' : 'partial';
        this.record.ended_at = new Date();
        this.record.summary = summary;
        await this.persist();
    }

    async fail(reason: string, error?: Error): Promise<void> {
        this.record.status = 'failed';
        this.record.ended_at = new Date();
        this.record.summary = reason;
        if (error) {
            this.record.errors.push({ message: `Fatal: ${reason}: ${error.message}` });
        }
        await this.persist();
    }

    getRecord(): Readonly<RunRecord> {
        return this.record;
    }

    isLive(): boolean {
        return this.record.mode === 'live';
    }

    private async persist(): Promise<void> {
        const sb = createClient();
        if (!sb) return;
        await sb
            .from('reconciliation_runs')
            .update({
                status: this.record.status,
                ended_at: this.record.ended_at?.toISOString() ?? null,
                invoices_found: this.record.invoices_found,
                invoices_processed: this.record.invoices_processed,
                pos_updated: this.record.pos_updated,
                price_changes: this.record.price_changes,
                freight_added_cents: this.record.freight_added_cents,
                errors: this.record.errors,
                warnings: this.record.warnings,
                summary: this.record.summary ?? null,
            })
            .eq('id', this.record.id);
    }
}
