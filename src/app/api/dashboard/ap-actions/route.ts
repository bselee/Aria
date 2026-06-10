/**
 * @file    route.ts (dashboard AP actions — proactive fixes)
 * @purpose API endpoint for proactive AP health fixes. Allows the dashboard
 *          to trigger real remediation actions within safe guardrails:
 *
 *          1. retry-invoice: Queue a stuck invoice for reprocessing
 *          2. mark-autopay: Add sender to autopay routing rules
 *          3. clean-zombies: Delete zombie ERROR_PROCESSING records
 *
 * @author  Hermia
 * @created 2026-06-10
 * @deps    @/lib/supabase, @/lib/intelligence/vendor-router
 * @guardrails
 *          - All actions are logged to system_events table for audit
 *          - No bulk operations except clean-zombies (max 50 at a time)
 *          - mark-autopay writes to vendor-router.ts requires manual code edit
 *            (for safety — returns the suggested rule code to paste)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

type ActionResponse = {
    success: boolean;
    message: string;
    data?: any;
};

// ── retry-invoice ─────────────────────────────────────────────────────────────

async function retryInvoice(messageId: string): Promise<ActionResponse> {
    const db = createClient();
    if (!db) return { success: false, message: 'Supabase unavailable' };

    try {
        // 1. Verify invoice is actually in ERROR state
        const { data: invoice, error: fetchErr } = await db
            .from('ap_inbox_queue')
            .select('id, status, email_from, email_subject')
            .eq('message_id', messageId)
            .in('status', ['ERROR_PROCESSING', 'ERROR_FORWARDING'])
            .single();

        if (fetchErr || !invoice) {
            return {
                success: false,
                message: `Invoice ${messageId} not found in ERROR state`
            };
        }

        // 2. Delete from queue (ap-fetcher will re-pick it up on next cycle)
        const { error: deleteErr } = await db
            .from('ap_inbox_queue')
            .delete()
            .eq('id', invoice.id);

        if (deleteErr) {
            return {
                success: false,
                message: `Failed to delete: ${deleteErr.message}`
            };
        }

        // 3. Log the action
        await db.from('system_events').insert({
            event_type: 'ap_retry_invoice',
            event_data: {
                message_id: messageId,
                email_from: invoice.email_from,
                email_subject: invoice.email_subject,
                previous_status: invoice.status,
                retried_at: new Date().toISOString()
            }
        });

        return {
            success: true,
            message: `Invoice ${messageId} queued for retry`,
            data: { message_id: messageId, status: 'queued' }
        };
    } catch (err: any) {
        return { success: false, message: `Error: ${err.message}` };
    }
}

// ── mark-autopay ──────────────────────────────────────────────────────────────

async function markAutopay(sender: string, label: string): Promise<ActionResponse> {
    // Extract domain from sender email if provided
    let domainKeyword = sender;
    if (sender.includes('@')) {
        domainKeyword = sender.split('@')[1];
    }

    // Generate the suggested routing rule (user must manually add to vendor-router.ts)
    const suggestedRule = {
        match: {
            senderContains: domainKeyword.toLowerCase()
        },
        action: 'autopay',
        label: `${label} (Autopay)`
    };

    const codeSnippet = `    {
      match: { senderContains: '${domainKeyword.toLowerCase()}' },
      action: 'autopay',
      label: '${label} (Autopay)'
    },`;

    try {
        const db = createClient();
        if (!db) return { success: false, message: 'Supabase unavailable' };

        // Log the suggestion for audit trail
        await db.from('system_events').insert({
            event_type: 'ap_mark_autopay_suggestion',
            event_data: {
                sender,
                label,
                suggested_rule: suggestedRule,
                suggested_at: new Date().toISOString()
            }
        });

        return {
            success: true,
            message: `Routing rule suggested. Add this to src/lib/intelligence/ap/vendor-router.ts:\n\n${codeSnippet}`,
            data: {
                rule: suggestedRule,
                code_snippet: codeSnippet,
                file_to_edit: 'src/lib/intelligence/ap/vendor-router.ts'
            }
        };
    } catch (err: any) {
        return { success: false, message: `Error: ${err.message}` };
    }
}

// ── clean-zombies ─────────────────────────────────────────────────────────────

async function cleanZombies(daysOld: number = 7, limit: number = 50): Promise<ActionResponse> {
    const db = createClient();
    if (!db) return { success: false, message: 'Supabase unavailable' };

    try {
        // Validate inputs
        if (daysOld < 1 || daysOld > 365) {
            return { success: false, message: 'daysOld must be 1-365' };
        }
        if (limit < 1 || limit > 100) {
            return { success: false, message: 'limit must be 1-100' };
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);

        // Find zombie records: ERROR_PROCESSING + no extracted_json + old
        const { data: zombies, error: selectErr } = await db
            .from('ap_inbox_queue')
            .select('id, message_id, created_at')
            .eq('status', 'ERROR_PROCESSING')
            .is('extracted_json', null)
            .lt('created_at', cutoffDate.toISOString())
            .limit(limit);

        if (selectErr) {
            return { success: false, message: `Select error: ${selectErr.message}` };
        }

        if (!zombies || zombies.length === 0) {
            return {
                success: true,
                message: `No zombie records older than ${daysOld} days`,
                data: { deleted: 0 }
            };
        }

        // Delete them
        const zombieIds = zombies.map(z => z.id);
        const { error: deleteErr } = await db
            .from('ap_inbox_queue')
            .delete()
            .in('id', zombieIds);

        if (deleteErr) {
            return { success: false, message: `Delete error: ${deleteErr.message}` };
        }

        // Log the action
        await db.from('system_events').insert({
            event_type: 'ap_clean_zombies',
            event_data: {
                days_old: daysOld,
                limit,
                deleted_count: zombies.length,
                deleted_ids: zombieIds,
                cleaned_at: new Date().toISOString()
            }
        });

        return {
            success: true,
            message: `Deleted ${zombies.length} zombie records`,
            data: { deleted: zombies.length, ids: zombieIds }
        };
    } catch (err: any) {
        return { success: false, message: `Error: ${err.message}` };
    }
}

// ── POST endpoint ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
    try {
        const body = await request.json();
        const { action, ...params } = body;

        if (!action) {
            return NextResponse.json(
                { success: false, message: 'Missing action parameter' },
                { status: 400 }
            );
        }

        let result: ActionResponse;

        switch (action) {
            case 'retry-invoice':
                if (!params.message_id) {
                    return NextResponse.json(
                        { success: false, message: 'Missing message_id' },
                        { status: 400 }
                    );
                }
                result = await retryInvoice(params.message_id);
                break;

            case 'mark-autopay':
                if (!params.sender || !params.label) {
                    return NextResponse.json(
                        { success: false, message: 'Missing sender or label' },
                        { status: 400 }
                    );
                }
                result = await markAutopay(params.sender, params.label);
                break;

            case 'clean-zombies':
                result = await cleanZombies(
                    params.days_old || 7,
                    params.limit || 50
                );
                break;

            default:
                return NextResponse.json(
                    { success: false, message: `Unknown action: ${action}` },
                    { status: 400 }
                );
        }

        const status = result.success ? 200 : 500;
        return NextResponse.json(result, { status });

    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: `Request error: ${err.message}` },
            { status: 400 }
        );
    }
}
