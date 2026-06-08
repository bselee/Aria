/**
 * @file    src/lib/sku-aliases.ts
 * @purpose Mapping of colloquial/vendor-informal SKU names to Finale SKUs.
 *          Used by slack/request-detector and other pipelines that receive
 *          human-written SKU references (Slack messages, emails, Telegram)
 *          which rarely use the exact Finale product ID.
 *
 *          Why it exists: People say "0811 bags" but Finale has
 *          `SBD21410811`. Without alias resolution, the request-detector
 *          silently drops these as unmatched — exactly what happened with
 *          Parker McMahon's Slack request (2026-06-08).
 *
 *          Each entry maps one or more informal names → { finaleSku, vendor, label }.
 *          Matches are case-insensitive. When the user's text is tokenized
 *          and cleaned (uppercased, spaces stripped), it is checked against
 *          this map BEFORE falling back to direct Finale lookup.
 *
 * @author  Hermia
 * @created 2026-06-08
 * @deps    None (pure data module)
 */

export interface SkuAliasEntry {
    /** The canonical Finale product ID. */
    finaleSku: string;
    /** Friendly label shown in correlation output. */
    label: string;
    /** Known vendor name (for routing). */
    vendor: string;
    /** Informal names that map to this Finale SKU (lowercase). */
    aliases: string[];
}

/**
 * SKU alias table. Add new entries here when users reference SKUs by
 * colloquial names that don't match the Finale product ID.
 *
 * Maintenance: When a Slack/Telegram message reveals a new alias, add it.
 * Run `npm run ship:bot` to deploy. No database migration needed.
 */
export const SKU_ALIASES: SkuAliasEntry[] = [
    // ── Stock Depot Bags ────────────────────────────────────────────────
    {
        finaleSku: 'SBD21410811',
        label: 'Stock Depot — 8×11 Bag (2 mil)',
        vendor: 'Stock Depot',
        aliases: ['0811bags', '0811bag', '0811b', '811bags', '811bag', 'stock depot 811', 'stockdepot 0811'],
    },
    {
        finaleSku: 'SBD21410711',
        label: 'Stock Depot — 7×11 Bag (2 mil)',
        vendor: 'Stock Depot',
        aliases: ['0711bags', '0711bag', '0711b', '711bags', '711bag', 'stock depot 711', 'stockdepot 0711'],
    },
    // ── Packaging / Bags ────────────────────────────────────────────────
    {
        finaleSku: 'BAV5LBBAG',
        label: 'BuildAVeg 5lb Bag',
        vendor: 'Colorful Packaging',
        aliases: ['bav5lb', 'bav5lbbag'],
    },
    // Add more entries here as they surface in Slack/email messages
];

/**
 * Build a lookup map: cleaned-name → alias entry.
 * Normalizes by lowercasing and stripping non-alphanumeric characters.
 */
const _normalizeRe = /[^a-z0-9]/g;
function normalize(s: string): string {
    return s.toLowerCase().replace(_normalizeRe, '');
}
const _index = new Map<string, SkuAliasEntry>();
for (const entry of SKU_ALIASES) {
    // Index the final Finale SKU itself (e.g. "sbd21410811" → entry)
    _index.set(normalize(entry.finaleSku), entry);
    for (const alias of entry.aliases) {
        _index.set(normalize(alias), entry);
    }
}

/**
 * Resolve a colloquial SKU string to a Finale SKU.
 * Returns `null` if no alias matches — call Finale lookup as fallback.
 *
 * @param raw — whatever the user typed (e.g. "0811 BAGS", "BAV5LBBAG")
 * @returns The matched alias entry, or null.
 */
export function resolveSkuAlias(raw: string): SkuAliasEntry | null {
    return _index.get(normalize(raw)) ?? null;
}

/**
 * Expand a token that may be an alias into [{ aliasName, finaleSku }].
 * If not an alias, returns single entry with raw → null finale.
 */
export function expandSkuToken(raw: string): Array<{ aliasName: string; finaleSku: string | null; label?: string }> {
    const entry = resolveSkuAlias(raw);
    if (entry) {
        return [{ aliasName: raw, finaleSku: entry.finaleSku, label: entry.label }];
    }
    return [{ aliasName: raw, finaleSku: null }];
}
