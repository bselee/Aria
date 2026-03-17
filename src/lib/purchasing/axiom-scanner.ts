import { createClient } from '../supabase';
import { FinaleClient } from '../finale/client';

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

    // 3. Filter items that need ordering
    const itemsToQueue = axiomGroup.items.filter(item => 
        item.urgency === 'critical' || item.urgency === 'warning' || item.urgency === 'reorder_flagged'
    );

    let queuedCount = 0;

    for (const item of itemsToQueue) {
        if (!item.suggestedQty || item.suggestedQty <= 0) continue;

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
                    suggested_qty: item.suggestedQty,
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
                    suggested_qty: item.suggestedQty,
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
