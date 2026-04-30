/**
 * @file    po-approval-task.ts
 * @purpose Bridge between agent_task approval gating and Finale PO creation.
 *          Prevents auto-PO creation by pushing to agent_task first.
 *          When approved via /tasks, the real PO is created.
 *
 *          Flow:
 *            1. Spoke says "need PO for vendor X"
 *            2. Upsert agent_task type=approval, source_table=po_pending_approval
 *            3. Task surfaces in /dashboard/tasks with APPROVE / REJECT
 *            4. Will approves → task-actions calls createDraftPOTaskAfterApproval
 *            5. Finale PO created, agent_task marked SUCCEEDED
 *
 *          Reuses the existing `agentTask.upsertFromSource` / `decideApproval` surface.
 */

import * as agentTask from '../intelligence/agent-task';
import { FinaleClient } from '../finale/client';

export interface DraftPOTaskPayload {
    vendorPartyId: string;
    items: Array<{ productId: string; quantity: number; unitPrice: number }>;
    memo: string;
    purchaseDestination?: string;
}

/**
 * Gate: create a pending hub task instead of creating the PO directly.
 * Call this from any path that previously called createDraftPurchaseOrder.
 */
export async function requestDraftPOApproval(
    sourceId: string,
    goal: string,
    payload: DraftPOTaskPayload,
    opts: { priority?: number; parentTaskId?: string | null } = {},
): Promise<{ taskId: string | null; message: string }> {
    const taskId = await agentTask.upsertFromSource({
        sourceTable: 'po_pending_approval',
        sourceId,
        type: 'approval',
        goal,
        status: 'NEEDS_APPROVAL',
        owner: 'will',
        priority: opts.priority ?? 3,
        requiresApproval: true,
        inputs: payload,
        parentTaskId: opts.parentTaskId ?? null,
    });

    return taskId
        ? { taskId, message: `⏸️ Draft PO queued for approval. Task ID: ${taskId.slice(0, 8)}` }
        : { taskId: null, message: '⚠️ Approval queue unavailable — PO not created.' };
}

/**
 * Execute: called from task-actions.ts when a po_pending_approval task is approved.
 * Creates the actual Finale draft PO.
 */
export async function createDraftPOTaskAfterApproval(
    taskId: string,
    decidedBy: string,
): Promise<{ success: boolean; orderId?: string; finaleUrl?: string; message: string }> {
    try {
        const task = await agentTask.getById(taskId);
        if (!task) {
            return { success: false, message: `Task ${taskId} not found.` };
        }

        const payload = task.inputs as DraftPOTaskPayload | undefined;
        if (!payload || !payload.vendorPartyId || !Array.isArray(payload.items)) {
            return { success: false, message: 'Invalid task payload — missing PO details.' };
        }

        const finale = new FinaleClient();
        const result = await finale.createDraftPurchaseOrder(
            payload.vendorPartyId,
            payload.items,
            payload.memo,
            payload.purchaseDestination,
        );

        await agentTask.complete(taskId, {
            approved_by: decidedBy,
            approved_at: new Date().toISOString(),
            finale_order_id: result.orderId,
            finale_url: result.finaleUrl,
        });

        return {
            success: true,
            orderId: result.orderId,
            finaleUrl: result.finaleUrl,
            message: `✅ Draft PO #${result.orderId} created after approval by ${decidedBy}.`,
        };
    } catch (err: any) {
        return { success: false, message: `❌ PO creation failed: ${err.message}` };
    }
}
