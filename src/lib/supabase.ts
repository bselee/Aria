import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-key';

/**
 * Generate a valid JWT for PostgREST authentication.
 * PostgREST requires a JWT signed with PGRST_JWT_SECRET.
 * The JWT contains a "role" claim that maps to a PostgreSQL role.
 *
 * For local dev, we generate the JWT on the fly using the same
 * secret configured in docker/aria-db/docker-compose.yml
 * (PGRST_JWT_SECRET). For Supabase cloud, we use the provided
 * service role key directly (it's already a JWT).
 */
function getAuthToken(): string {
    // If the key looks like a JWT (3 dot-separated base64 parts), use it directly.
    // This is the case for Supabase service role keys.
    if (supabaseKey.split('.').length === 3) {
        return supabaseKey;
    }

    // For local PostgREST: generate a JWT signed with the known secret
    const PGRST_SECRET = process.env.PGRST_JWT_SECRET || 'aria-local-dev-secret-not-for-production';
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ role: 'anon', iss: 'postgrest', exp: 9999999999 })).toString('base64url');
    const sig = crypto.createHmac('sha256', PGRST_SECRET).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}

/**
 * Custom fetch with:
 * 1. 10s timeout — prevents indefinite hangs on DB 522/524
 * 2. URL rewrite — strips /rest/v1/ from the path so supabase-js
 *    talks to PostgREST directly (PostgREST serves from /, not /rest/v1/)
 * 3. JWT auth — injects a valid JWT for PostgREST if the API key isn't already a JWT
 */
function fetchWithTimeout(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let finalUrl = typeof url === 'string' ? url : url.toString();

    // Rewrite Supabase REST URL to PostgREST format
    finalUrl = finalUrl.replace('/rest/v1/', '/');

    // Inject JWT auth — always override because supabase-js sets the
    // raw API key (not a JWT) which PostgREST rejects.
    const token = getAuthToken();
    const headers = new Headers(init?.headers);
    headers.set('apikey', token);
    headers.set('Authorization', `Bearer ${token}`);

    // Debug: log first few calls to verify fetch override is active
    if (process.env.DEBUG_SUPABASE_FETCH === '1') {
        console.log(`[supabase-fetch] ${finalUrl.substring(0, 120)}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    return fetch(finalUrl, { ...init, headers, signal: controller.signal }).finally(() =>
        clearTimeout(timeout)
    );
}

let supabase: any = null;

export function createClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabase && url && key) {
        supabase = createSupabaseClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: fetchWithTimeout as any },
            db: { schema: 'public' },
            realtime: { params: { eventsPerSecond: 1 } },
        });
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
        browserClient = createSupabaseClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: fetchWithTimeout as any },
        });
    }
    return browserClient;
}
