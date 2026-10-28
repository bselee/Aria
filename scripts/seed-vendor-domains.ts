// Seed vendor_profiles.vendor_domains from evidence, so vendor-scoped PO
// inference stops falling back to "any vendor" for senders we can identify.
//
// Rules (all measured, see scripts/_probe-domain-seeds2.ts):
//  - candidate = a sender domain whose PDF-named vendors are ALL the same vendor
//    after normalization (case/punctuation/LLC-INC-CO-LTD suffix stripped)
//  - the vendor must already have a vendor_profiles row — this script never
//    creates vendor master data
//  - consumer mailboxes, payment/ERP proxies and carrier portals are refused:
//    one host serves many counterparties (notification.intuit.com carries 27
//    forwards across 8+ vendors), so a domain match would misroute
//  - append only, idempotent: an existing entry is never duplicated or replaced
//
// Usage: node --import tsx --env-file=.env.local scripts/seed-vendor-domains.ts [--apply]
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const APPLY = process.argv.includes("--apply");

const NEVER_SEED = new Set([
    "gmail.com", "yahoo.com", "icloud.com", "hotmail.com", "outlook.com", "aol.com", "msn.com",
    "notification.intuit.com", "intuit.com", "bill.com", "hq.bill.com", "billtrust.com",
    "sent-via.netsuite.com", "netsuite.com", "mg.sosinventory.com", "collectiontoolbox.com",
    "jas.collectiontoolbox.com", "fedex.com", "aaacooper.com", "buildasoil.com",
]);
const JUNK = /^(error|unknown vendor|from:?|qty|invoice|consignee|buildasoil.*|==.*|here'?s the extracted|quantityumitemdescription.*|aci|act)$/i;

function normalizeVendor(v: string): string {
    return String(v || "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]+/g, " ")
        .replace(/\b(LLC|LLP|INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|USA)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const vp = await pg.query("select vendor_name, vendor_emails, vendor_domains from vendor_profiles");
    const canonical = new Map<string, string>();
    const knownEmails = new Set<string>();
    const knownDomains = new Set<string>();
    for (const r of vp.rows) {
        canonical.set(normalizeVendor(r.vendor_name), r.vendor_name);
        for (const e of r.vendor_emails || []) knownEmails.add(String(e).toLowerCase().trim());
        for (const d of r.vendor_domains || []) knownDomains.add(String(d).toLowerCase().trim());
    }

    const db = new Database("aria-local.db", { readonly: true });
    const rows = db.prepare("select email_from, ocr_vendor_name from ap_local_forwards").all() as any[];

    const byDomain = new Map<string, Map<string, { n: number; sample: string }>>();
    for (const r of rows) {
        const raw = String(r.email_from || "");
        const addr = (raw.match(/<([^>]+)>/)?.[1] ?? raw).toLowerCase().trim();
        if (!addr.includes("@") || knownEmails.has(addr)) continue;
        const domain = addr.split("@")[1];
        if (!domain || knownDomains.has(domain)) continue;
        const vendor = String(r.ocr_vendor_name || "").trim();
        if (!vendor || JUNK.test(vendor)) continue;
        const key = normalizeVendor(vendor);
        if (!key) continue;
        if (!byDomain.has(domain)) byDomain.set(domain, new Map());
        const m = byDomain.get(domain)!;
        const cur = m.get(key) ?? { n: 0, sample: vendor };
        cur.n++;
        m.set(key, cur);
    }

    const planned: Array<{ domain: string; vendor: string; n: number }> = [];
    const skippedNoRow: Array<{ domain: string; vendor: string; n: number }> = [];
    const refused: Array<{ domain: string; vendor: string; n: number }> = [];

    for (const [domain, dist] of byDomain) {
        if (dist.size !== 1) continue; // ambiguous after normalization
        const [key, top] = [...dist.entries()][0];
        const entry = { domain, vendor: top.sample, n: top.n };
        if (NEVER_SEED.has(domain)) { refused.push(entry); continue; }
        const profileName = canonical.get(key);
        if (!profileName) { skippedNoRow.push(entry); continue; }
        planned.push({ domain, vendor: profileName, n: top.n });
    }

    planned.sort((a, b) => b.n - a.n);
    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${planned.length} domain seed(s) planned`);
    for (const p of planned) console.log(`  ${p.domain} -> ${p.vendor} (${p.n} forwards)`);
    console.log(`\nrefused (proxy/consumer/carrier, never seeded): ${refused.length}`);
    for (const r of refused.sort((a, b) => b.n - a.n)) console.log(`  ${r.domain} -> ${r.vendor} (${r.n}) — refused`);
    console.log(`\nskipped (no vendor_profiles row — vendor master data, not created here): ${skippedNoRow.length}`);
    for (const s of skippedNoRow.sort((a, b) => b.n - a.n)) console.log(`  ${s.domain} -> ${s.vendor} (${s.n}) — skipped`);

    if (!APPLY) {
        console.log(`\nre-run with --apply to write ${planned.length} domain(s)`);
        db.close();
        await pg.end();
        return;
    }

    let touched = 0;
    for (const p of planned) {
        const r = await pg.query(
            `update vendor_profiles
                set vendor_domains = case
                        when vendor_domains is null then array[$1]::text[]
                        else vendor_domains || $1
                    end
              where vendor_name = $2
                and not ($1 = any(coalesce(vendor_domains, '{}'::text[])))`,
            [p.domain, p.vendor],
        );
        touched += r.rowCount ?? 0;
        console.log(`  ${p.domain} -> ${p.vendor}: ${r.rowCount} row(s)`);
    }
    console.log(`\nrows touched: ${touched}`);
    db.close();
    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
