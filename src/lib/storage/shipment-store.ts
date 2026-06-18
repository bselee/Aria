const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const client = createClient(supabaseUrl, supabaseKey);

export async function upsertShipment(evidence) {
  const { data, error } = await client.from('shipments').upsert([evidence], { 
    onConflict: ['trackingNumber']
  });
  
  if (error) {
    console.error('Supabase upsert error:', error.message);
    throw error;
  }
}

// Type declarations (runtime only)
export type ShipmentEvidence = {
  id?: string;
  trackingNumber: string;
  carrier: string;
  statusCategory: string;
  statusDisplay: string;
  confidence: number;
  sourceRef: string;
  active: boolean;
  createdAt?: Date;
}