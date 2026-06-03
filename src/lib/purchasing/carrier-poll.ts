/**
 * @file    carrier-poll.ts
 * @purpose Refresh shipment status for every active tracking number against
 *          its carrier. Existing tracking-service.getTrackingStatus already
 *          handles LTL (free page fetch), FedEx (direct API), and parcels
 *          (EasyPost) — this just iterates open shipments and writes
 *          updated status via upsertShipmentEvidence.
 *
 * Pace: ~6 carrier calls/minute (10s sleep between) so we stay under any
 * rate ceiling even on a 200-shipment backlog.
 */
import { createClient } from "@/lib/supabase";
import { getTrackingStatus } from "@/lib/carriers/tracking-service";
import { upsertShipmentEvidence } from "@/lib/tracking/shipment-intelligence";

const PACE_MS = 10_000;
const MAX_SHIPMENTS_PER_RUN = 100;

export interface CarrierPollOutcome {
    trackingNumber: string;
    action: 'refreshed' | 'unchanged' | 'no_data' | 'error' | 'skipped_delivered';
    statusCategory?: string | null;
    statusDisplay?: string | null;
    error?: string;
}

export async function pollActiveShipments(): Promise<CarrierPollOutcome[]> {
    const supabase = createClient();
    if (!supabase) return [];

    // Re-poll shipments every 2 hours. Most parcel carriers (UPS, FedEx, USPS)
    // update tracking 4–6×/day during transit. 12h cooldown was missing same-day
    // delivery confirmations entirely.
    const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
    const { data: ships, error } = await supabase
        .from('shipments')
        .select('id, tracking_number, status_category, status_display, last_checked_at, delivered_at, po_numbers, vendor_names')
        .eq('active', true)
        .is('delivered_at', null)
        .or(`last_checked_at.is.null,last_checked_at.lte.${cutoff}`)
        .limit(MAX_SHIPMENTS_PER_RUN);
    if (error) {
        console.error('[carrier-poll] query failed:', error.message);
        return [];
    }

    const outcomes: CarrierPollOutcome[] = [];

    for (const s of ships ?? []) {
        if (s.delivered_at) {
            outcomes.push({ trackingNumber: s.tracking_number, action: 'skipped_delivered' });
            continue;
        }
        try {
            const status = await getTrackingStatus(s.tracking_number);
            if (!status) {
                outcomes.push({ trackingNumber: s.tracking_number, action: 'no_data' });
                continue;
            }

            const newCat = status.category ?? null;
            const newDisp = status.display ?? null;
            const newEta = status.estimated_delivery_at ?? null;
            const newDelivered = newCat === 'delivered'
                ? (status.delivered_at ?? new Date().toISOString())
                : null;

            const changed = newCat !== s.status_category || newDisp !== s.status_display || !!newDelivered;
            if (!changed) {
                // Still mark as checked so we don't pull it again soon.
                await upsertShipmentEvidence({
                    trackingNumber: s.tracking_number,
                    source: 'carrier_poll',
                    statusCategory: s.status_category as any,
                    statusDisplay: s.status_display,
                });
                outcomes.push({
                    trackingNumber: s.tracking_number,
                    action: 'unchanged',
                    statusCategory: s.status_category,
                    statusDisplay: s.status_display,
                });
                continue;
            }

            await upsertShipmentEvidence({
                trackingNumber: s.tracking_number,
                source: 'carrier_poll',
                confidence: 0.95,
                statusCategory: newCat as any,
                statusDisplay: newDisp,
                estimatedDeliveryAt: newEta,
                deliveredAt: newDelivered,
                poNumber: s.po_numbers?.[0] ?? null,
                vendorName: s.vendor_names?.[0] ?? null,
            });
            outcomes.push({
                trackingNumber: s.tracking_number,
                action: 'refreshed',
                statusCategory: newCat,
                statusDisplay: newDisp,
            });
        } catch (err: any) {
            outcomes.push({
                trackingNumber: s.tracking_number,
                action: 'error',
                error: err?.message ?? String(err),
            });
        }
        await new Promise(r => setTimeout(r, PACE_MS));
    }

    return outcomes;
}
