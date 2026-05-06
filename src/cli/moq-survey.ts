/**
 * @file    moq-survey.ts
 * @purpose One-shot MOQ candidate discovery. Combines three signals to surface
 *          which vendors might have an MOQ worth seeding into vendor_minimum_orders:
 *
 *            1. Finale PO history — most recent PO per vendor (current pattern,
 *               not historical floor). Will's framing: most vendors have NO MOQ;
 *               this is context, not a floor.
 *            2. Gmail rejection mining — both ap@buildasoil.com and bill.selee@
 *               searched for "minimum order", "below MOQ", "minimum quantity",
 *               etc. This is the only signal that actually proves an MOQ exists.
 *            3. Per-SKU STD Packing — Finale's orderIncrementQuantity is already
 *               surfaced as a per-SKU pack increment in the recommender. Noted
 *               here for context only (not a vendor MOQ).
 *
 *          Output: `.agents/plans/2026-05-05-moq-candidates.md` — a review doc.
 *          Default state per vendor is "no MOQ"; only flag confidence:high when
 *          there's an explicit rejection email.
 *
 *          Run: node --import tsx src/cli/moq-survey.ts [--days 365]
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({ path: ".env.local" });

import { gmail as gmailApi } from "@googleapis/gmail";
import { finaleClient } from "@/lib/finale/client";
import { getAuthenticatedClient } from "@/lib/gmail/auth";

// ──────────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith("--days="))?.split("=")[1]
    ?? (args[args.indexOf("--days") + 1] && args.includes("--days") ? args[args.indexOf("--days") + 1] : null);
const DAYS_BACK = daysArg ? Number(daysArg) : 365;

// ──────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────

function parseTotal(v: any): number {
    if (v == null) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "object" && v.amount != null) return parseTotal(v.amount);
    const s = String(v).replace(/[^0-9.\-]/g, "");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}

const STOPWORDS = new Set([
    "inc","llc","ltd","the","corp","company","co","industries",
    "supply","supplies","packaging","group","solutions","services",
    "products","international","global","wholesale","distributors",
    "distribution","systems","technologies","partners","holdings",
    "resources","enterprises","manufacturing","trading","supplyco",
    "trade","trading","import","imports","export","exports",
]);

// ──────────────────────────────────────────────────
// 1. PO history sweep
// ──────────────────────────────────────────────────

interface PoRow {
    orderId: string;
    orderDate: string;
    status: string;
    total: number;
    supplierName: string;
    supplierPartyId: string | null;
    lineCount: number;
    skus: string[];
}

interface VendorPoSummary {
    vendorName: string;
    vendorPartyId: string | null;
    poCount: number;
    mostRecentPO: PoRow | null;
    medianTotal: number;
    minTotal: number;
    maxTotal: number;
    allTotals: number[];
}

async function sweepPos(daysBack: number): Promise<PoRow[]> {
    const accountPath = (finaleClient as any).accountPath;
    const apiBase = (finaleClient as any).apiBase;
    const authHeader = (finaleClient as any).authHeader;

    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - daysBack);
    const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const endStr = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

    const PAGE_SIZE = 500;
    const MAX_PAGES = 8;
    const out: PoRow[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        const afterClause = cursor ? `, after: "${cursor}"` : "";
        const query = {
            query: `{
                orderViewConnection(
                    first: ${PAGE_SIZE}
                    type: ["PURCHASE_ORDER"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]${afterClause}
                ) {
                    pageInfo { hasNextPage endCursor }
                    edges { node {
                        orderId
                        orderDate
                        status
                        total
                        supplier { partyUrl name }
                        itemList(first: 200) {
                            edges { node { product { productId } } }
                        }
                    }}
                }
            }`,
        };

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(query),
        });
        const json: any = await res.json();
        const connection = json.data?.orderViewConnection;
        const edges: any[] = connection?.edges || [];

        for (const e of edges) {
            const po = e.node;
            const supplierUrl = po.supplier?.partyUrl ?? null;
            const supplierPartyId = supplierUrl ? supplierUrl.split("/").pop() : null;
            const skus = (po.itemList?.edges ?? [])
                .map((ie: any) => (ie.node?.product?.productId ?? "").toString())
                .filter(Boolean);
            out.push({
                orderId: po.orderId,
                orderDate: po.orderDate ?? "",
                status: po.status ?? "",
                total: parseTotal(po.total),
                supplierName: (po.supplier?.name ?? "").toString().trim(),
                supplierPartyId,
                lineCount: skus.length,
                skus,
            });
        }

        if (!connection?.pageInfo?.hasNextPage || !connection?.pageInfo?.endCursor) break;
        cursor = connection.pageInfo.endCursor;
    }
    return out;
}

function summarizeByVendor(rows: PoRow[]): VendorPoSummary[] {
    const groups = new Map<string, PoRow[]>();
    for (const r of rows) {
        const key = r.supplierPartyId ?? `name:${r.supplierName.toLowerCase()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
    }
    const out: VendorPoSummary[] = [];
    for (const [, list] of groups) {
        list.sort((a, b) => (a.orderDate < b.orderDate ? 1 : -1));
        const totals = list.map(p => p.total).filter(t => t > 0).sort((a, b) => a - b);
        const median = totals.length === 0
            ? 0
            : totals.length % 2 === 1
                ? totals[(totals.length - 1) >> 1]
                : (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2;
        const mostRecent = list[0] ?? null;
        out.push({
            vendorName: mostRecent?.supplierName ?? "Unknown",
            vendorPartyId: mostRecent?.supplierPartyId ?? null,
            poCount: list.length,
            mostRecentPO: mostRecent,
            medianTotal: Math.round(median * 100) / 100,
            minTotal: totals[0] ?? 0,
            maxTotal: totals[totals.length - 1] ?? 0,
            allTotals: totals,
        });
    }
    out.sort((a, b) => b.poCount - a.poCount);
    return out;
}

// ──────────────────────────────────────────────────
// 2. Gmail MOQ-rejection mining
// ──────────────────────────────────────────────────

interface MoqEmailHit {
    account: "ap" | "default";
    messageId: string;
    threadId: string;
    date: string;
    from: string;
    subject: string;
    snippet: string;
    matchedTerm: string;
}

// Tighter rejection-language phrases — avoid "minimum order" alone since
// it matches every "no minimum order!" promotional email in existence.
const MOQ_QUERY_TERMS = [
    `"below our minimum"`,
    `"below MOQ"`,
    `"does not meet our minimum"`,
    `"does not meet the minimum"`,
    `"minimum order requirement"`,
    `"minimum order quantity"`,
    `"minimum purchase requirement"`,
    `"order minimum is"`,
    `"too small to process"`,
    `"under our minimum"`,
    `"below the minimum"`,
];

async function mineGmailForMoq(account: "ap" | "default", daysBack: number): Promise<MoqEmailHit[]> {
    const auth = await getAuthenticatedClient(account);
    const gmail = gmailApi({ version: "v1", auth: auth as any });

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, "/");

    const hits: MoqEmailHit[] = [];
    const seen = new Set<string>();

    for (const term of MOQ_QUERY_TERMS) {
        // Filter promotional/marketing senders aggressively — they're 99% of the noise
        const q = `${term} after:${sinceStr} -in:sent -from:buildasoil.com -category:promotions -category:social -unsubscribe -newsletter`;
        let pageToken: string | undefined;
        let pageCount = 0;
        do {
            const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100, pageToken });
            const ids = (list.data.messages ?? []).map(m => m.id!).filter(Boolean);
            for (const id of ids) {
                if (seen.has(id)) continue;
                seen.add(id);
                try {
                    const full = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
                    const headers = full.data.payload?.headers ?? [];
                    const fromHdr = headers.find(h => h.name === "From")?.value ?? "";
                    const subj = headers.find(h => h.name === "Subject")?.value ?? "";
                    const dateHdr = headers.find(h => h.name === "Date")?.value ?? "";
                    if (/buildasoil\.com/i.test(fromHdr)) continue; // outbound, skip
                    hits.push({
                        account,
                        messageId: id,
                        threadId: full.data.threadId ?? "",
                        date: dateHdr,
                        from: fromHdr,
                        subject: subj,
                        snippet: (full.data.snippet ?? "").trim(),
                        matchedTerm: term.replace(/"/g, ""),
                    });
                } catch (err: any) {
                    console.warn(`  [gmail/${account}] message ${id} fetch failed: ${err.message}`);
                }
            }
            pageToken = list.data.nextPageToken ?? undefined;
            pageCount++;
        } while (pageToken && pageCount < 5);
    }

    return hits;
}

function fromAddrDomain(from: string): string {
    const m = from.match(/<([^>]+)>/) || from.match(/([^\s,]+@[^\s,]+)/);
    const addr = m ? m[1] : from;
    const dom = (addr.split("@")[1] ?? "").toLowerCase().replace(/[>\s].*$/, "");
    return dom;
}

// ──────────────────────────────────────────────────
// 3. Compose markdown
// ──────────────────────────────────────────────────

function fmt$(n: number): string {
    return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function composeMarkdown(
    vendors: VendorPoSummary[],
    emailHits: MoqEmailHit[],
    daysBack: number,
): string {
    const today = new Date().toISOString().slice(0, 10);

    // Index emails by sender domain
    const emailsByDomain = new Map<string, MoqEmailHit[]>();
    for (const h of emailHits) {
        const dom = fromAddrDomain(h.from);
        if (!dom) continue;
        if (!emailsByDomain.has(dom)) emailsByDomain.set(dom, []);
        emailsByDomain.get(dom)!.push(h);
    }

    function matchEmailsToVendor(vendorName: string): MoqEmailHit[] {
        const words = vendorName
            .toLowerCase()
            .split(/[\s,./()&]+/)
            .filter(w => w.length > 3 && !STOPWORDS.has(w));
        if (words.length === 0) return [];
        const matched: MoqEmailHit[] = [];
        for (const [dom, list] of emailsByDomain) {
            // Match domain root (strip TLD), require >=4 char word match against root
            const root = dom.replace(/\.(com|net|org|co|io|us|biz|info)$/i, "").split(".").pop() ?? dom;
            if (words.some(w => root.includes(w) || w.includes(root))) matched.push(...list);
        }
        return matched;
    }

    let md = `# MOQ Candidate Survey — ${today}\n\n`;
    md += `**Window:** last ${daysBack} days · **Vendors with PO activity:** ${vendors.length} · **MOQ-language emails found:** ${emailHits.length}\n\n`;
    md += `## How to read this\n\n`;
    md += `- **Default state = no MOQ.** Most vendors don't have one; the table reflects that.\n`;
    md += `- "Most recent PO" = the current price/qty pattern Will sees with this vendor.\n`;
    md += `- "Email evidence" lists messages containing MOQ rejection language. Only these warrant seeding \`vendor_minimum_orders\`.\n`;
    md += `- Per-SKU **STD Packing** (Finale "Std reorder in qty of") is already used by the recommender for pack rounding — not surfaced here per vendor.\n\n`;

    md += `## Vendors with email evidence (review priority)\n\n`;
    const vendorsWithEvidence = vendors
        .map(v => ({ v, hits: matchEmailsToVendor(v.vendorName) }))
        .filter(x => x.hits.length > 0);

    if (vendorsWithEvidence.length === 0) {
        md += `_No vendors matched email rejection language by name overlap. Check the "Unmatched email evidence" section below — those hits couldn't be auto-tied to a Finale vendor._\n\n`;
    } else {
        md += `| Vendor | POs | Most Recent | Recent Total | Hits | Suggested action |\n`;
        md += `|---|---|---|---|---|---|\n`;
        for (const { v, hits } of vendorsWithEvidence) {
            const recent = v.mostRecentPO
                ? `${v.mostRecentPO.orderDate.slice(0, 10)} (${v.mostRecentPO.lineCount} lines)`
                : "—";
            const recentTotal = v.mostRecentPO ? fmt$(v.mostRecentPO.total) : "—";
            md += `| **${v.vendorName}** | ${v.poCount} | ${recent} | ${recentTotal} | ${hits.length} | seed MOQ — see evidence below |\n`;
        }
        md += `\n### Evidence detail\n\n`;
        for (const { v, hits } of vendorsWithEvidence) {
            md += `#### ${v.vendorName}\n\n`;
            md += `- Most recent PO: ${v.mostRecentPO?.orderDate.slice(0, 10) ?? "—"} — ${v.mostRecentPO ? fmt$(v.mostRecentPO.total) : "—"} (${v.mostRecentPO?.lineCount ?? 0} lines)\n`;
            md += `- All POs in window: ${v.poCount} · median ${fmt$(v.medianTotal)} · range ${fmt$(v.minTotal)}–${fmt$(v.maxTotal)}\n`;
            md += `- vendor_party_id: \`${v.vendorPartyId ?? "—"}\`\n\n`;
            for (const h of hits.slice(0, 5)) {
                md += `  - **${h.matchedTerm}** · ${h.account}@ · ${h.from} · ${h.date.slice(0, 16)}\n`;
                md += `    - Subj: ${h.subject}\n`;
                md += `    - "${h.snippet.slice(0, 200).replace(/\s+/g, " ")}"\n`;
            }
            md += `\n`;
        }
    }

    md += `## All vendors — most recent PO snapshot\n\n`;
    md += `Sorted by PO count desc. **Default seed action = none.** Only seed when the vendor appears above with email evidence.\n\n`;
    md += `| Vendor | POs | Most Recent | Recent Total | Median | Range | party_id |\n`;
    md += `|---|---|---|---|---|---|---|\n`;
    for (const v of vendors) {
        const recent = v.mostRecentPO
            ? `${v.mostRecentPO.orderDate.slice(0, 10)} (${v.mostRecentPO.lineCount}L)`
            : "—";
        const recentTotal = v.mostRecentPO ? fmt$(v.mostRecentPO.total) : "—";
        md += `| ${v.vendorName} | ${v.poCount} | ${recent} | ${recentTotal} | ${fmt$(v.medianTotal)} | ${fmt$(v.minTotal)}–${fmt$(v.maxTotal)} | \`${v.vendorPartyId ?? "—"}\` |\n`;
    }

    // Unmatched email evidence
    const matchedHitIds = new Set<string>();
    for (const v of vendors) {
        for (const h of matchEmailsToVendor(v.vendorName)) matchedHitIds.add(h.messageId);
    }
    const unmatched = emailHits.filter(h => !matchedHitIds.has(h.messageId));
    if (unmatched.length > 0) {
        md += `\n## Unmatched email evidence\n\n`;
        md += `These messages contained MOQ language but couldn't be tied to a Finale vendor by name overlap. Could be promotional fluff ("no minimum order!") or a vendor we don't have in Finale yet.\n\n`;
        md += `| Account | Date | From | Term | Subject |\n`;
        md += `|---|---|---|---|---|\n`;
        for (const h of unmatched.slice(0, 50)) {
            md += `| ${h.account} | ${h.date.slice(0, 10)} | ${h.from.replace(/\|/g, "\\|")} | ${h.matchedTerm} | ${h.subject.replace(/\|/g, "\\|").slice(0, 80)} |\n`;
        }
        if (unmatched.length > 50) md += `\n_…${unmatched.length - 50} more truncated._\n`;
    }

    md += `\n---\n\n_Generated by \`src/cli/moq-survey.ts\` on ${today}._\n`;
    return md;
}

// ──────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────

async function main() {
    console.log(`[moq-survey] Window: last ${DAYS_BACK} days`);

    console.log(`[moq-survey] Sweeping Finale POs…`);
    const rows = await sweepPos(DAYS_BACK);
    console.log(`  → ${rows.length} POs`);
    const vendors = summarizeByVendor(rows);
    console.log(`  → ${vendors.length} unique vendors`);

    console.log(`[moq-survey] Mining ap@ for MOQ rejection language…`);
    let apHits: MoqEmailHit[] = [];
    try { apHits = await mineGmailForMoq("ap", DAYS_BACK); }
    catch (err: any) { console.warn(`  ap@ mine failed: ${err.message}`); }
    console.log(`  → ${apHits.length} ap@ hits`);

    console.log(`[moq-survey] Mining bill.selee@ (default) for MOQ rejection language…`);
    let defaultHits: MoqEmailHit[] = [];
    try { defaultHits = await mineGmailForMoq("default", DAYS_BACK); }
    catch (err: any) { console.warn(`  default@ mine failed: ${err.message}`); }
    console.log(`  → ${defaultHits.length} default@ hits`);

    const allHits = [...apHits, ...defaultHits];
    const md = composeMarkdown(vendors, allHits, DAYS_BACK);

    const outDir = path.resolve(".agents/plans");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const outPath = path.join(outDir, `${today}-moq-candidates.md`);
    fs.writeFileSync(outPath, md);
    console.log(`\n✓ Wrote ${outPath}`);
    console.log(`  ${vendors.length} vendors · ${allHits.length} email hits`);
}

main().catch(err => {
    console.error("[moq-survey] fatal:", err);
    process.exit(1);
});
