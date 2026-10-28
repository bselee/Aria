/**
 * @file    src/lib/artwork/bag-artwork-sync.ts
 * @purpose Phase 2 core: mirror the teammate's two-tab bag artwork sheet
 *          (Review gid 0 / Complete gid 1893895146) into Postgres and link
 *          each sheet SKU (a Finale SKU) to its bag/label component SKU.
 *
 *          READ-ONLY on the sheet: Drive export only. All writes land in OUR
 *          Postgres (bag_artwork, bag_artwork_link, bag_artwork_events,
 *          bag_artwork_alerts). No sheet edits, ever.
 *
 *          Art state rule (Bill 2026-10-28): if an item is on the Review page
 *          we do NOT reorder until it is on Complete. A SKU present on the
 *          Review tab, or carrying a blocking status (In Review / need
 *          revision) on either tab, counts as in_review. A row that moves to
 *          complete while its linked component has < 180 days of runway
 *          writes a bag_artwork_alerts row for the ordering surface.
 * @author  Hermia
 * @created 2026-10-28
 * @deps    xlsx, @/lib/db, @/lib/finale/products, ./schema, ./link-seed
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (token refresh),
 *          DATABASE_URL (schema), PGRST_URL (row I/O)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import { createClient } from '@/lib/db';
import { FinaleClient } from '@/lib/finale/client';
import { ARTWORK_LINK_SEED } from './link-seed';
import { ensureBagArtworkSchema } from './schema';

/** Teammate's sheet (read-only; not ours). */
export const ARTWORK_SHEET_ID = '1MWwcpJ9tEnp8BWXnRQ45ev1ydc3ju1DCaahwJMDE1s8';

const TOKEN_PATH = path.join(process.cwd(), 'drive-token.json');
const RESALE_SNAPSHOT_PATH = path.join(
    process.cwd(),
    process.env.ARIA_PURCHASING_CACHE_DIR || '.aria-cache/purchasing',
    'purchasing-resale.json',
);

export type ArtState = 'complete' | 'in_review';

export interface ArtworkRow {
    artworkSku: string;
    family: string;
    version: string;
    status: string;
    weight: string;
    frontFile: string;
    backFile: string;
    rtpFile: string;
    canvaLink: string;
    tab: 'review' | 'complete';
    prop65Status: string;
}

export interface ArtworkEvent {
    kind: 'new' | 'tab_move' | 'status_change' | 'removed';
    artworkSku: string;
    fromTab?: string;
    toTab?: string;
    fromStatus?: string;
    toStatus?: string;
}

export interface ArtworkSyncResult {
    rows: number;
    events: ArtworkEvent[];
    links: Array<{ componentSku: string; artworkSku: string; source: string }>;
    alerts: Array<{ componentSku: string; artworkSku: string; runwayDays: number }>;
    orphans: string[];
    unlinked: string[];
    dryRun: boolean;
}

/* ─────────────────────────── Drive export ─────────────────────────── */

/** Refresh the drive token when expired; returns a valid access token. */
async function getDriveAccessToken(): Promise<string> {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (token.expiry_date && Date.now() < token.expiry_date - 60_000) {
        return token.access_token;
    }
    const body = new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID!,
        client_secret: process.env.GMAIL_CLIENT_SECRET!,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) throw new Error(`drive token refresh failed: ${res.status}`);
    const fresh = await res.json();
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...token, ...fresh }, null, 2));
    return fresh.access_token;
}

/** Export the whole workbook (all tabs) as XLSX bytes. */
async function exportArtworkWorkbook(): Promise<Buffer> {
    const accessToken = await getDriveAccessToken();
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${ARTWORK_SHEET_ID}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`artwork sheet export failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/* ─────────────────────────── Parsing ─────────────────────────── */

function cell(row: unknown[], i: number): string {
    return String(row[i] ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/** Parse one tab into unified ArtworkRows. Locates the header row dynamically
 *  (the Complete tab carries a stray pre-header row) and skips sku-less rows. */
export function parseTab(rows: unknown[][], tab: 'review' | 'complete'): { rows: ArtworkRow[]; orphans: string[] } {
    const out: ArtworkRow[] = [];
    const orphans: string[] = [];
    const headerIdx = rows.findIndex((r) => /^status$/i.test(cell(r, 0)) && /^sku$/i.test(cell(r, 3)));
    if (headerIdx === -1) throw new Error(`could not find header row in ${tab} tab`);

    // Content above the header (e.g. the orphan "need revision" row) is logged.
    for (const r of rows.slice(0, headerIdx)) {
        const txt = r.map((c) => String(c ?? '').trim()).filter(Boolean).join(' | ');
        if (txt) orphans.push(`[${tab}] pre-header: ${txt}`);
    }

    for (const r of rows.slice(headerIdx + 1)) {
        if (r.every((c) => String(c ?? '').trim() === '')) continue;
        // Review: Status, Family, Version, Sku, Weight, Front, Back, Canva, Prop65, ...
        // Complete: Status, LastOrder, Family, Sku, Weight, RTP File, Canva
        const status = cell(r, 0);
        const family = tab === 'review' ? cell(r, 1) : cell(r, 2);
        const version = tab === 'review' ? cell(r, 2) : '';
        const sku = cell(r, 3);
        const weight = cell(r, 4);
        const frontFile = tab === 'review' ? cell(r, 5) : '';
        const backFile = tab === 'review' ? cell(r, 6) : '';
        const rtpFile = tab === 'complete' ? cell(r, 5) : '';
        const canvaLink = tab === 'review' ? cell(r, 7) : cell(r, 6);
        const prop65Status = tab === 'review' ? cell(r, 8) : '';

        if (!sku) {
            // sku-less rows (orphan notes, template placeholders) — log, never write
            if (status || family) orphans.push(`[${tab}] "${status} | ${family}"`);
            continue;
        }
        out.push({ artworkSku: sku, family, version, status, weight, frontFile, backFile, rtpFile, canvaLink, tab, prop65Status });
    }
    return { rows: out, orphans };
}

/**
 * Effective art state for one SKU across both tabs.
 * Review-wins: presence on the Review tab, or a blocking status on either
 * tab, means the art is NOT ready for a reorder.
 */
export function effectiveArtState(rows: ArtworkRow[]): ArtState {
    const blocking = (r: ArtworkRow): boolean =>
        r.tab === 'review' || /in review|need revision/i.test(r.status);
    return rows.some(blocking) ? 'in_review' : 'complete';
}

/* ─────────────────────────── Link resolution ─────────────────────────── */

async function fetchCachedNames(skus: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const db = createClient();
        const { data } = await db
            .from('finale_sku_cache')
            .select('sku,name:raw_detail->>name')
            .in('sku', skus);
        for (const r of (data ?? []) as Array<{ sku: string; name: string }>) {
            map.set(r.sku, r.name ?? '');
        }
    } catch (err) {
        console.warn('[bag-artwork] name cache read failed:', (err as Error).message);
    }
    return map;
}

/**
 * BOM discovery for sheet SKUs the curated seed does not cover: pull the
 * Finale BOM, then keep components whose name says bag or label.
 */
async function resolveBomLinks(unlinked: string[]): Promise<Array<{ componentSku: string; artworkSku: string; source: 'bom'; vendor: string }>> {
    if (unlinked.length === 0) return [];
    const links: Array<{ componentSku: string; artworkSku: string; source: 'bom'; vendor: string }> = [];
    const client = new FinaleClient();
    for (const sku of unlinked) {
        try {
            const bom = await client.getBillOfMaterials(sku);
            if (bom.length === 0) {
                console.log(`[bag-artwork] no BOM for ${sku} — left unlinked`);
                continue;
            }
            const comps = bom.map((b) => b.componentSku);
            const names = await fetchCachedNames(comps);
            const bagLabel = comps.filter((c) => /bag|label/i.test(names.get(c) ?? c));
            if (bagLabel.length > 0) {
                links.push({ componentSku: bagLabel[0], artworkSku: sku, source: 'bom', vendor: names.get(bagLabel[0]) ?? '' });
                console.log(`[bag-artwork] BOM link: ${bagLabel[0]} -> ${sku} (${names.get(bagLabel[0]) ?? 'no name'})`);
            } else {
                console.log(`[bag-artwork] ${sku} BOM has ${comps.length} components, none named bag/label — left unlinked`);
            }
        } catch (err) {
            console.warn(`[bag-artwork] BOM resolution failed for ${sku}:`, (err as Error).message);
        }
    }
    return links;
}

/* ─────────────────────────── Alerts ─────────────────────────── */

interface SnapshotItem {
    productId?: string;
    runwayDays?: number;
    adjustedRunwayDays?: number;
}

function readResaleRunways(): Map<string, number> {
    const map = new Map<string, number>();
    try {
        const snap = JSON.parse(fs.readFileSync(RESALE_SNAPSHOT_PATH, 'utf8'));
        const groups: Array<{ items?: SnapshotItem[] }> = snap?.value ?? [];
        for (const g of groups) {
            for (const it of g.items ?? []) {
                const sku = it.productId;
                const runway = it.runwayDays ?? it.adjustedRunwayDays;
                if (sku && typeof runway === 'number' && Number.isFinite(runway)) {
                    map.set(sku.toUpperCase(), runway);
                }
            }
        }
    } catch {
        // No snapshot yet — alerts are skipped, not failed.
    }
    return map;
}

/* ─────────────────────────── The sync ─────────────────────────── */

/**
 * Sync the artwork sheet into Postgres.
 *
 * @param opts.live - false: export+parse+diff only (no writes, no BOM calls).
 *                    true: schema, upsert rows, events, links, alerts.
 * @returns Structured result for CLI/UI reporting.
 */
export async function syncBagArtwork(opts: { live?: boolean } = {}): Promise<ArtworkSyncResult> {
    const live = opts.live === true;
    const workbook = await exportArtworkWorkbook();
    const wb = XLSX.read(workbook, { type: 'buffer' });

    const reviewTab = wb.SheetNames.find((n) => /review/i.test(n));
    const completeTab = wb.SheetNames.find((n) => /complete/i.test(n));
    if (!reviewTab || !completeTab) {
        throw new Error(`unexpected tab names: ${wb.SheetNames.join(', ')}`);
    }
    const sheetRows = (name: string): unknown[][] =>
        XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });

    const review = parseTab(sheetRows(reviewTab), 'review');
    const complete = parseTab(sheetRows(completeTab), 'complete');
    const current = [...review.rows, ...complete.rows];
    const orphans = [...review.orphans, ...complete.orphans];

    const db = createClient();

    // Existing rows for diffing (best effort in dry-run). Composite key:
    // (artwork_sku, tab) — a SKU may legitimately sit on BOTH tabs.
    interface ExistingRow {
        artwork_sku: string;
        tab: string;
        status: string;
        removed_at: string | null;
    }
    let existingRows: ExistingRow[] = [];
    try {
        const { data } = await db
            .from('bag_artwork')
            .select('artwork_sku,tab,status,removed_at');
        existingRows = (data ?? []) as ExistingRow[];
    } catch (err) {
        console.warn('[bag-artwork] existing-row read failed; diffing against empty:', (err as Error).message);
    }
    const existingBySku = new Map<string, ExistingRow[]>();
    for (const r of existingRows) {
        if (r.removed_at) continue;
        const key = r.artwork_sku.toUpperCase();
        existingBySku.set(key, [...(existingBySku.get(key) ?? []), r]);
    }
    const prevStateOf = (rows: ExistingRow[]): ArtState =>
        rows.some((r) => r.tab === 'review' || /in review|need revision/i.test(r.status ?? '')) ? 'in_review' : 'complete';

    const events: ArtworkEvent[] = [];
    const currentBySku = new Map<string, ArtworkRow[]>();
    for (const r of current) {
        const key = r.artworkSku.toUpperCase();
        currentBySku.set(key, [...(currentBySku.get(key) ?? []), r]);
    }

    for (const [key, rows] of currentBySku) {
        const sku = rows[0].artworkSku;
        const prevRows = existingBySku.get(key);
        const state = effectiveArtState(rows);
        if (!prevRows || prevRows.length === 0) {
            events.push({ kind: 'new', artworkSku: sku, toTab: state === 'in_review' ? 'review' : 'complete', toStatus: rows.map((r) => r.status).filter(Boolean).join(' / ') });
            continue;
        }
        const prevState = prevStateOf(prevRows);
        if (prevState !== state) {
            events.push({ kind: 'tab_move', artworkSku: sku, fromTab: prevState, toTab: state, fromStatus: prevRows.map((r) => r.status).filter(Boolean).join(' / '), toStatus: rows.map((r) => r.status).filter(Boolean).join(' / ') });
        }
    }
    for (const [key, prevRows] of existingBySku) {
        if (!currentBySku.has(key)) {
            events.push({ kind: 'removed', artworkSku: prevRows[0].artwork_sku, fromTab: prevStateOf(prevRows) });
        }
    }

    if (!live) {
        return {
            rows: current.length,
            events,
            links: [],
            alerts: [],
            orphans,
            unlinked: [], // computed on live run (BOM discovery)
            dryRun: true,
        };
    }

    // ── Live path: schema, upserts, events, links, alerts ──
    await ensureBagArtworkSchema();
    // PostgREST serves from a schema cache that reloads on the pgrst notify;
    // give it a beat so the first write does not 404 with PGRST205.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const now = new Date().toISOString();
    // Dedupe on the composite key so ON CONFLICT never sees the same key twice
    // in one statement (Postgres raises 21000 otherwise).
    const seenKeys = new Set<string>();
    const upsertRows: Array<Record<string, unknown>> = [];
    for (const r of current) {
        const key = `${r.artworkSku.toUpperCase()}|${r.tab}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        upsertRows.push({
            artwork_sku: r.artworkSku,
            family: r.family || null,
            version: r.version || null,
            status: r.status || null,
            weight: r.weight || null,
            front_file: r.frontFile || null,
            back_file: r.backFile || null,
            rtp_file: r.rtpFile || null,
            canva_link: r.canvaLink || null,
            tab: r.tab,
            prop65_status: r.prop65Status || null,
            last_seen_at: now,
            removed_at: null,
        });
    }
    const { error: upsertErr } = await db.from('bag_artwork').upsert(upsertRows, { onConflict: 'artwork_sku,tab' });
    if (upsertErr) throw new Error(`bag_artwork upsert failed: ${upsertErr.message}`);

    // Mark rows that vanished from the sheet as removed.
    const gone = [...existingBySku.keys()].filter((k) => !currentBySku.has(k));
    if (gone.length > 0) {
        await db.from('bag_artwork').update({ removed_at: now }).in('artwork_sku', gone.map((k) => existingBySku.get(k)![0].artwork_sku));
    }

    if (events.length > 0) {
        const eventRows = events.map((e) => ({
            artwork_sku: e.artworkSku,
            kind: e.kind,
            from_tab: e.fromTab ?? null,
            to_tab: e.toTab ?? null,
            from_status: e.fromStatus ?? null,
            to_status: e.toStatus ?? null,
            at: now,
        }));
        const { error: evErr } = await db.from('bag_artwork_events').insert(eventRows);
        if (evErr) console.warn('[bag-artwork] event insert failed:', evErr.message);
    }

    // Completed-at bookkeeping: effective state complete → stamp every row of
    // that SKU (the Complete-tab row is the meaningful one).
    const completeSkus: string[] = [];
    for (const [key, rows] of currentBySku) {
        if (effectiveArtState(rows) === 'complete') {
            completeSkus.push(rows[0].artworkSku);
        }
    }
    if (completeSkus.length > 0) {
        await db.from('bag_artwork').update({ completed_at: now }).in('artwork_sku', completeSkus);
    }

    // Link resolution: curated seed first, then BOM discovery for the rest.
    const seedBySku = new Map<string, (typeof ARTWORK_LINK_SEED)[number]>();
    for (const s of ARTWORK_LINK_SEED) seedBySku.set(s.artworkSku.toUpperCase(), s);

    const linkRows: Array<{ component_sku: string; artwork_sku: string; link_source: string; vendor: string | null; note: string | null }> = [];
    const unlinked: string[] = [];

    for (const [key, rows] of currentBySku) {
        const sku = rows[0].artworkSku;
        const seed = seedBySku.get(key);
        if (seed) {
            linkRows.push({ component_sku: seed.componentSku, artwork_sku: sku, link_source: 'seed', vendor: seed.vendor, note: seed.note ?? null });
        } else {
            unlinked.push(sku);
        }
    }
    // BOM discovery only for SKUs not attempted in the last 7 days, so the
    // weekly sync does not re-run Finale BOM lookups for known-unlinked SKUs.
    let recentAttempts = new Set<string>();
    try {
        const { data: attemptData } = await db.from('bag_artwork_link_attempt').select('artwork_sku,tried_at');
        for (const a of (attemptData ?? []) as Array<{ artwork_sku: string; tried_at: string }>) {
            if (Date.now() - Date.parse(a.tried_at) < 7 * 24 * 60 * 60 * 1000) {
                recentAttempts.add(a.artwork_sku.toUpperCase());
            }
        }
    } catch (err) {
        console.warn('[bag-artwork] link-attempt read failed (proceeding with all):', (err as Error).message);
    }
    const bomTargets = unlinked.filter((s) => !recentAttempts.has(s.toUpperCase()));
    const bomLinks = await resolveBomLinks(bomTargets);

    // Persist the attempt so the next sync does not re-BOM the same SKUs
    // every week (Finale calls). Retry after 7 days in case a BOM was added.
    const attemptRows = bomTargets.map((s) => ({ artwork_sku: s, tried_at: now }));
    if (attemptRows.length > 0) {
        const { error: attErr } = await db.from('bag_artwork_link_attempt').upsert(attemptRows, { onConflict: 'artwork_sku' });
        if (attErr) console.warn('[bag-artwork] link-attempt upsert failed:', attErr.message);
    }
    for (const b of bomLinks) {
        linkRows.push({ component_sku: b.componentSku, artwork_sku: b.artworkSku, link_source: 'bom', vendor: b.vendor || null, note: 'Finale BOM discovery' });
    }
    const bomSkuSet = new Set(bomLinks.map((b) => b.artworkSku.toUpperCase()));
    const finalUnlinked = unlinked.filter((s) => !bomSkuSet.has(s.toUpperCase()));

    if (linkRows.length > 0) {
        // Dedupe on the composite key — one component may serve several
        // artworks (e.g. a shared label roll), and ON CONFLICT rejects a
        // duplicate key within one statement.
        const seenLinkKeys = new Set<string>();
        const deduped = linkRows.filter((l) => {
            const key = `${l.component_sku.toUpperCase()}|${l.artwork_sku.toUpperCase()}`;
            if (seenLinkKeys.has(key)) return false;
            seenLinkKeys.add(key);
            return true;
        });
        const { error: linkErr } = await db.from('bag_artwork_link').upsert(deduped, { onConflict: 'component_sku,artwork_sku' });
        if (linkErr) console.warn('[bag-artwork] link upsert failed:', linkErr.message);
    }

    // Completion alerts: art flipped to complete AND component runway < 180d.
    const alerts: Array<{ componentSku: string; artworkSku: string; runwayDays: number }> = [];
    const completedNow = events.filter((e) => e.kind === 'tab_move' && e.toTab === 'complete').map((e) => e.artworkSku.toUpperCase());
    if (completedNow.length > 0) {
        const runways = readResaleRunways();
        const { data: linkData } = await db.from('bag_artwork_link').select('component_sku,artwork_sku');
        const artToComp = new Map<string, string>();
        for (const l of (linkData ?? []) as Array<{ component_sku: string; artwork_sku: string }>) {
            artToComp.set(l.artwork_sku.toUpperCase(), l.component_sku);
        }
        for (const sku of completedNow) {
            const comp = artToComp.get(sku);
            if (!comp) continue;
            const runway = runways.get(comp.toUpperCase());
            if (runway !== undefined && runway < 180) {
                alerts.push({ componentSku: comp, artworkSku: sku, runwayDays: Math.round(runway * 10) / 10 });
            }
        }
        if (alerts.length > 0) {
            const { error: alertErr } = await db
                .from('bag_artwork_alerts')
                .insert(
                    alerts.map((a) => ({
                        component_sku: a.componentSku,
                        artwork_sku: a.artworkSku,
                        runway_days: a.runwayDays,
                        at: now,
                    })),
                );
            if (alertErr) console.warn('[bag-artwork] alert insert failed:', alertErr.message);
        }
    }

    return {
        rows: current.length,
        events,
        links: linkRows.map((l) => ({ componentSku: l.component_sku, artworkSku: l.artwork_sku, source: l.link_source })),
        alerts,
        orphans,
        unlinked: finalUnlinked,
        dryRun: false,
    };
}
