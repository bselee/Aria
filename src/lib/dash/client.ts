/**
 * @file    src/lib/dash/client.ts
 * @purpose Dash REST API v2 client — OAuth2 authentication, asset search,
 *          file download, and barcode extraction for artwork verification.
 * @author  Hermia
 * @created 2026-06-22
 * @deps    none (fetch-based, no external SDK)
 * @env     DASH_CLIENT_ID, DASH_CLIENT_SECRET, DASH_SUBDOMAIN (default: buildasoil)
 *
 * AUTH FLOW:
 *   Dash uses OAuth2 Authorization Code flow. Client Credentials (machine-to-machine)
 *   are NOT supported. The flow:
 *     1. User authorizes via browser → gets auth code
 *     2. Exchange code for access_token + refresh_token
 *     3. Store refresh_token, use access_token for API calls
 *     4. When access_token expires, use refresh_token to get a new one
 *
 *   For CLI usage, the first run opens a browser for authorization.
 *   The refresh_token is cached locally so subsequent runs are unattended.
 */

const DASH_API_BASE = 'https://api-v2.dash.app';
const DASH_AUTH_BASE = 'https://login.dash.app';
const DASH_AUDIENCE = 'https://assetplatform.io';

export interface DashConfig {
    clientId: string;
    clientSecret: string;
    subdomain: string;
    redirectUri: string;
}

export interface DashTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
}

export interface DashAsset {
    id: string;
    filename: string;
    fileType: string;
    lifecycleStatus: string;
    dateLastModified: string;
    downloadUrl?: string;
    /** Parsed SKU from filename (first segment before _ or -) */
    skuMatch?: string;
    /** Parsed dimensions from filename (e.g. "8.5x11") */
    sizeMatch?: string;
    /** Whether filename contains "PrintReady" */
    isPrintReady?: boolean;
}

/**
 * Load Dash configuration from environment.
 */
export function getDashConfig(redirectUri?: string): DashConfig {
    const clientId = process.env.DASH_CLIENT_ID;
    const clientSecret = process.env.DASH_CLIENT_SECRET;
    const subdomain = process.env.DASH_SUBDOMAIN || 'buildasoil';

    if (!clientId || !clientSecret) {
        throw new Error(
            'DASH_CLIENT_ID and DASH_CLIENT_SECRET must be set in .env.local'
        );
    }

    return {
        clientId,
        clientSecret,
        subdomain,
        redirectUri: redirectUri || 'http://localhost:3001/api/dash/callback',
    };
}

// ── Token persistence ─────────────────────────────────────────────────────────

const TOKEN_CACHE_PATH = process.cwd() + '/.dash-tokens.json';

function loadCachedTokens(): DashTokens | null {
    try {
        const fs = require('fs');
        if (fs.existsSync(TOKEN_CACHE_PATH)) {
            const raw = fs.readFileSync(TOKEN_CACHE_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch { /* ignore */ }
    return null;
}

function saveCachedTokens(tokens: DashTokens): void {
    try {
        const fs = require('fs');
        fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    } catch { /* ignore */ }
}

// ── OAuth2 flow ───────────────────────────────────────────────────────────────

/**
 * Build the authorization URL for the OAuth2 code flow.
 * User visits this URL in a browser to authorize the application.
 */
export function buildAuthUrl(config: DashConfig): string {
    const params = new URLSearchParams({
        response_type: 'code',
        audience: DASH_AUDIENCE,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: `offline_access subdomain:${config.subdomain}`,
    });
    return `${DASH_AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(
    config: DashConfig,
    code: string,
): Promise<DashTokens> {
    const resp = await fetch(`${DASH_AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.redirectUri,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    const tokens: DashTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };

    saveCachedTokens(tokens);
    return tokens;
}

/**
 * Refresh an expired access token using the stored refresh token.
 */
export async function refreshAccessToken(
    config: DashConfig,
    refreshToken: string,
): Promise<DashTokens> {
    const resp = await fetch(`${DASH_AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    const tokens: DashTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken, // some providers don't rotate
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };

    saveCachedTokens(tokens);
    return tokens;
}

/**
 * Get a valid access token — loads cached, refreshes if expired.
 * Throws if no cached token and no code provided (user must auth first).
 */
export async function getAccessToken(
    config: DashConfig,
    authCode?: string,
): Promise<string> {
    // If an auth code is provided, exchange it
    if (authCode) {
        const tokens = await exchangeCode(config, authCode);
        return tokens.accessToken;
    }

    // Try cache
    const cached = loadCachedTokens();
    if (cached) {
        // If still valid, return it
        if (cached.expiresAt > Date.now() + 60000) {
            return cached.accessToken;
        }
        // Expired — try refresh
        try {
            const refreshed = await refreshAccessToken(config, cached.refreshToken);
            return refreshed.accessToken;
        } catch {
            // Refresh failed — need re-auth
            throw new Error(
                'Dash token expired and refresh failed. Re-authenticate at:\n' +
                buildAuthUrl(config)
            );
        }
    }

    throw new Error(
        'No Dash token cached. Authenticate first by visiting:\n' +
        buildAuthUrl(config)
    );
}

// ── Asset search ──────────────────────────────────────────────────────────────

/**
 * Search Dash assets by filename pattern.
 * Uses the FILENAME criterion which supports partial matching.
 */
export async function searchAssetsByFilename(
    token: string,
    filenamePattern: string,
    maxResults: number = 20,
): Promise<DashAsset[]> {
    // Try FILENAME first, fall back to KEYWORDS
    let resp = await fetch(`${DASH_API_BASE}/asset-searches`, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 0,
            pageSize: maxResults,
            criterion: {
                type: 'FIELD_MATCHES',
                value: '*' + filenamePattern + '*',
                field: {
                    type: 'FIXED',
                    fieldName: 'FILENAME',
                },
            },
            sorts: [],
        }),
    });

    let data = await resp.json();

    // If FILENAME search returns nothing, try KEYWORDS
    if (!data.results || data.results.length === 0) {
        resp = await fetch(`${DASH_API_BASE}/asset-searches`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 0,
                pageSize: maxResults,
                criterion: {
                    type: 'FIELD_MATCHES',
                    value: filenamePattern,
                    field: {
                        type: 'FIXED',
                        fieldName: 'KEYWORDS',
                    },
                },
                sorts: [],
            }),
        });
        data = await resp.json();
    }

    // Parse results — Dash wraps them in { result: { ... } }
    const assets: DashAsset[] = [];
    for (const wrapper of data.results || []) {
        const item = wrapper.result || wrapper;
        const file = item.currentAssetFile || item.currentFile || {};
        const filename = file.filename || item.filename || '';
        const fileType = file.fileType || item.fileType || '';

        // Get asset detail for download URL
        let downloadUrl: string | undefined;
        try {
            const detailResp = await fetch(`${DASH_API_BASE}/assets/${item.id}`, {
                headers: { 'Authorization': 'Bearer ' + token },
            });
            if (detailResp.ok) {
                const detailData = await detailResp.json();
                const detailAsset = detailData.result || detailData;
                const f = detailAsset.currentAssetFile || detailAsset.currentFile || {};
                downloadUrl = f.url || f.downloadUrl;
            }
        } catch { /* ignore */ }

        assets.push({
            id: item.id,
            filename,
            fileType,
            lifecycleStatus: item.lifecycleStatus?.state || '',
            dateLastModified: item.dateLastModified || '',
            downloadUrl,
            ...parseDashFilename(filename),
        });
    }

    return assets;
}

/**
 * Get a single asset by ID.
 */
export async function getAssetById(
    token: string,
    assetId: string,
): Promise<DashAsset | null> {
    const resp = await fetch(`${DASH_API_BASE}/assets/${assetId}`, {
        headers: { 'Authorization': 'Bearer ' + token },
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const asset = data.result || data;

    return {
        id: asset.id,
        filename: asset.filename || asset.name || '',
        fileType: asset.fileType || '',
        lifecycleStatus: asset.lifecycleStatus?.state || '',
        dateLastModified: asset.dateLastModified || '',
        downloadUrl: asset.currentFile?.url || asset.downloadUrl,
        ...parseDashFilename(asset.filename || asset.name || ''),
    };
}

// ── Filename parser (moved from resolver.ts, same logic) ──────────────────────

/**
 * Parse a Dash filename to extract SKU, dimensions, and print-ready status.
 * Convention: {SKU}_{description}_{dimensions}_PrintReady.{ext}
 */
export function parseDashFilename(fileName: string): {
    skuMatch?: string;
    sizeMatch?: string;
    isPrintReady?: boolean;
} {
    const base = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
    const lower = base.toLowerCase();

    // SKU = first segment before underscore or hyphen
    const parts = base.split(/[_-]/);
    const sku = parts[0] ? parts[0].trim().toUpperCase() : undefined;

    // Print-ready status
    const isPrintReady = lower.includes('printready') || lower.includes('print ready') || lower.includes('print_ready');

    // Dimensions (e.g. 8.5x11, 7.5x10, 7x8.75, 5x6)
    let sizeMatch: string | undefined;
    const dimMatch = base.match(/(\d+(?:\.\d+)?[a-z]?\s*[x×]\s*\d+(?:\.\d+)?[a-z]?)/i);
    if (dimMatch) {
        sizeMatch = dimMatch[1].toLowerCase().replace(/\s+/g, '');
    }

    return { skuMatch: sku, sizeMatch, isPrintReady };
}

// ── File download ─────────────────────────────────────────────────────────────

/**
 * Get a download URL for a Dash asset file.
 * Uses the preview URL from the asset files endpoint (available without a batch job).
 */
export async function getAssetDownloadUrl(token: string, assetId: string): Promise<string | null> {
    try {
        // Get the asset file to find its preview/download URL
        const resp = await fetch(`${DASH_API_BASE}/assets/${assetId}/files`, {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const files = Array.isArray(data) ? data : data.results || [];
        if (files.length === 0) return null;
        const file = files[0].result || files[0];
        // Use preview URL (rendered image of the PDF)
        if (file.previewUrl) return file.previewUrl;
        return null;
    } catch {
        return null;
    }
}

/**
 * Download an asset file (for barcode extraction).
 * Returns the raw bytes. Uses the preview URL from Dash.
 */
export async function downloadAssetFile(
    token: string,
    asset: DashAsset,
): Promise<Buffer | null> {
    // Try getting from the files endpoint first
    if (asset.id) {
        const url = await getAssetDownloadUrl(token, asset.id);
        if (url) {
            const resp = await fetch(url);
            if (resp.ok) {
                const arrayBuffer = await resp.arrayBuffer();
                return Buffer.from(arrayBuffer);
            }
        }
    }
    
    // Fallback to stored downloadUrl
    if (asset.downloadUrl) {
        const resp = await fetch(asset.downloadUrl, {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        if (resp.ok) {
            const arrayBuffer = await resp.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
    }
    
    return null;
}

// ── Simplified verification (no PDF parsing needed — just file match) ─────────

/**
 * Verify that a Dash asset exists and matches expected properties for a given SKU.
 * This is the lightweight check — confirms the right file exists in Dash
 * before you place a PO. (Full barcode extraction requires pdf-pipeline.)
 */
export async function verifyArtworkForSku(
    token: string,
    sku: string,
): Promise<{
    verified: boolean;
    message: string;
    assets: DashAsset[];
}> {
    const assets = await searchAssetsByFilename(token, sku, 10);

    // Filter to assets whose parsed SKU matches
    const matching = assets.filter(a =>
        a.skuMatch?.toUpperCase() === sku.toUpperCase()
    );
    const printReady = matching.filter(a => a.isPrintReady);

    if (matching.length === 0) {
        return {
            verified: false,
            message: `No assets found in Dash for SKU "${sku}". Artwork may not be uploaded yet.`,
            assets: [],
        };
    }

    if (printReady.length === 0) {
        return {
            verified: false,
            message: `Found ${matching.length} asset(s) for "${sku}" but none marked PrintReady. Verify manually.`,
            assets: matching,
        };
    }

    return {
        verified: true,
        message: `${printReady.length} print-ready asset(s) found for "${sku}".`,
        assets: printReady,
    };
}
