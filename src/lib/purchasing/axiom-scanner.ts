import { createClient } from '../supabase';
import { FinaleClient } from '../finale/client';
import { assessPurchasingGroups } from './assessment-service';
import { buildDraftPOItemsFromAssessment } from './draft-po-policy';

export async function scanAxiomDemand(finaleClient: FinaleClient) {
    const supabase = createClient();
    if (!supabase) {
        console.warn('[axiom-scanner] Supabase client not initialized');
        return { queuedCount: 0 };
    }

    console.log('[axiom-scanner] Starting Axiom demand scan...');
    // 1. Get purchasing intelligence
    const groups = await finaleClient.getPurchasingIntelligence();
    
    // 2. Filter for Axiom group
    const axiomGroup = groups.find(g => g.vendorName?.toLowerCase().includes('axiom'));
    
    if (!axiomGroup) {
        console.log('[axiom-scanner] No Axiom demand found in purchasing intelligence.');
        return { queuedCount: 0 };
    }

    // 3. Run the shared purchasing policy and only queue actionable lines
    const assessment = assessPurchasingGroups([axiomGroup]);
    const assessedGroup = assessment.groups[0];
    const draftItems = buildDraftPOItemsFromAssessment(assessedGroup?.items ?? []);
    const itemsToQueue = (assessedGroup?.items ?? [])
        .filter(line => draftItems.items.some(item => item.productId === line.item.productId));

    let queuedCount = 0;

    for (const line of itemsToQueue) {
        const item = line.item;
        const draftItem = draftItems.items.find(entry => entry.productId === item.productId);
        if (!draftItem || draftItem.quantity <= 0) continue;

        // Check if there is already a 'pending' row for this sku
        const { data: existing } = await supabase
            .from('axiom_demand_queue')
            .select('id')
            .eq('sku', item.productId)
            .eq('status', 'pending')
            .maybeSingle();

        if (existing) {
            // Update the existing pending row with fresh data
            await supabase
                .from('axiom_demand_queue')
                .update({ 
                    suggested_qty: draftItem.quantity,
                    velocity_30d: item.dailyRate * 30,
                    runway_days: item.adjustedRunwayDays ?? item.runwayDays,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
        } else {
            // Insert a new pending row
            await supabase
                .from('axiom_demand_queue')
                .insert({
                    sku: item.productId,
                    product_name: item.productName,
                    suggested_qty: draftItem.quantity,
                    velocity_30d: item.dailyRate * 30,
                    runway_days: item.adjustedRunwayDays ?? item.runwayDays,
                    status: 'pending'
                });
            queuedCount++;
        }
    }

    console.log(`[axiom-scanner] Queued/updated ${itemsToQueue.length} Axiom SKUs for ordering. (New: ${queuedCount})`);
    return { queuedCount: itemsToQueue.length }; // returning total items processed for testing
}
