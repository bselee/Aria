/**
 * Shipment Interface Definitions
 * @file
 * @purpose Core shipment entity interfaces
 * @author BuildASoil
 * @created 2026-06-18
 * @deps shipment-intelligence
 * @env NEXT_PUBLIC_SUPABASE_URL
 */

export interface ShipmentEvidence {
  id: string;
  trackingNumber: string;
  carrier: string;
  statusCategory: 'in_transit' | 'delivered' | 'exception';
  statusDisplay: string;
  confidence: number;
  sourceRef: string;
  active: boolean;
  createdAt: Date;
}

export function classifyShipment(trackingNumber: string): { category: string; display: string } {
  // Real classification logic will be implemented here
  return { category: 'in_transit', display: 'In Transit' };
}