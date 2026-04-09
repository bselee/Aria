import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-key';

let supabase: any = null;

export function createClient() {
    // Force initialization if env vars are missing but we are in Node
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabase && url && key) {
        supabase = createSupabaseClient(url, key);
    } else if (!supabase) {
        console.warn('⚠️ Supabase env vars missing. NEXT_PUBLIC_SUPABASE_URL:', !!url, 'SUPABASE_SERVICE_ROLE_KEY:', !!key);
    }
    return supabase;
}

let browserClient: any = null;
export function createBrowserClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'mock-key';

    if (!browserClient) {
        browserClient = createSupabaseClient(url, key);
    }
    return browserClient;
}
