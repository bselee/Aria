/**
 * @file    src/lib/artwork/enrich.ts
 * @purpose Join bag/label artwork state onto purchasing scan groups.
 *          Reads bag_artwork + bag_artwork_link from PostgREST (24h memo) and
 *          stamps each linked component item with artStatus. Items whose art
 *          is in_review get reviewRequired + a reason so the ordering board
 *          and auto-draft flows hold the reorder until the art is Complete.
 *          Pure read; never writes, never touches the sheet, never blocks a
 *          scan on failure.
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db, @/lib/finale/core-client
 * @env     PGRST_URL
 */
import { createClient } from '@/lib/db';
import type { PurchasingGroup } from '@/lib/finale/core-client';

export type ArtState = 'complete' | 'in_review';

interface ArtworkRecord {
    artwork_sku: string;
    tab: string;
    status: string | null;
    version: string | null;
    removed_at: string | null;
}

interface LinkRecord {
    component_sku: string;
    artwork_sku: string;
}

interface ComponentArt {
    state: ArtState;
    skus: string[];
    versions: string[];
}

let memo: { at: number; byComponent: Map<string, ComponentArt> } | null = null;
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Load the artwork map (component SKU → art state). One component may serve
 * several artworks (shared label rolls); any linked in_review artwork blocks.
 * Failure returns an empty map — enrichment is an improvement, never a reason
 * to lose a scan.
 */
export async function loadArtworkMap(force = false): Promise<Map<string, ComponentArt>> {
    if (memo && !force && Date.now() - memo.at < MEMO_TTL_MS) return memo.byComponent;
    try {
        const db = createClient();
        const { data: artData } = await db
            .from('bag_artwork')
            .select('artwork_sku,tab,status,version,removed_at');
        const { data: linkData } = await db
            .from('bag_artwork_link')
            .select('component_sku,artwork_sku');

        const artBySku = new Map<string, ArtworkRecord[]>();
        for (const r of (artData ?? []) as ArtworkRecord[]) {
            if (r.removed_at) continue;
            const key = r.artwork_sku.toUpperCase();
            artBySku.set(key, [...(artBySku.get(key) ?? []), r]);
        }
        const stateOf = (rows: ArtworkRecord[]): ArtState =>
            rows.some((r) => r.tab === 'review' || /in review|need revision/i.test(r.status ?? '')) ? 'in_review' : 'complete';

        const byComponent = new Map<string, ComponentArt>();
        for (const l of (linkData ?? []) as LinkRecord[]) {
            const compKey = l.component_sku.toUpperCase();
            const rows = artBySku.get(l.artwork_sku.toUpperCase());
            if (!rows || rows.length === 0) continue;
            const existing = byComponent.get(compKey);
            const state = stateOf(rows);
            if (existing) {
                if (state === 'in_review') existing.state = 'in_review';
                existing.skus.push(l.artwork_sku);
                existing.versions.push(...rows.map((r) => r.version).filter((v): v is string => Boolean(v)));
            } else {
                byComponent.set(compKey, {
                    state,
                    skus: [l.artwork_sku],
                    versions: rows.map((r) => r.version).filter((v): v is string => Boolean(v)),
                });
            }
        }
        memo = { at: Date.now(), byComponent };
        return byComponent;
    } catch (err) {
        console.warn('[bag-artwork] enrichment map load failed (skipping):', (err as Error).message);
        return memo?.byComponent ?? new Map();
    }
}

/**
 * Stamp art state onto scan groups in place and return them. Items without a
 * link are untouched (artStatus stays undefined — no gate, not an error).
 */
export async function applyArtworkStatus(groups: PurchasingGroup[]): Promise<PurchasingGroup[]> {
    const map = await loadArtworkMap();
    if (map.size === 0) return groups;
    for (const g of groups) {
        for (const it of g.items) {
            const key = (it.productId ?? '').toUpperCase();
            const art = map.get(key);
            if (!art) continue;
            it.artStatus = art.state;
            it.artSku = art.skus[0];
            if (art.versions.length > 0) it.artVersion = art.versions[0];
            if (art.state === 'in_review') {
                it.reviewRequired = true;
                it.reviewReasons = [...(it.reviewReasons ?? []), 'art in review — hold reorder until Complete'];
            }
        }
    }
    return groups;
}
