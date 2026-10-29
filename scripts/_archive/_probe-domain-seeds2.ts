// Second pass: normalize vendor names and junk labels, then decide which domains
// could be seeded safely. The first pass overcounted ambiguity — most of it was
// OCR noise (Unknown Vendor, "==Start of OCR for page 1==", QTY) and spelling
// variants (AAA COOPER TRANSPORTATION vs AAA Cooper Transportation).
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// Never seed these: consumer mailboxes, carrier portals, payment/ERP proxies.
// A single host here serves many counterparties, so a domain match would misroute.
const NEVER_SEED = new Set([
    "gmail.com", "yahoo.com", "icloud.com", "hotmail.com", "outlook.com", "aol.com", "msn.com",
    "notification.intuit.com", "intuit.com", "bill.com", "hq.bill.com", "billtrust.com",
    "sent-via.netsuite.com", "netsuite.com", "mg.sosinventory.com", "collectiontoolbox.com",
    "jas.collectiontoolbox.com", "fedex.com", "aaacooper.com", "buildasoil.com",
]);

const JUNK = /^(error|unknown vendor|from::|qty|invoice|consignee|buildasoil.*|==.*|here'?s the extracted|quantityumitemdescription.*|aci|act)$/i;

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
    const vp = await pg.query("select vendor_name, orders_email, vendor_emails, vendor_domains from vendor_profiles");
    const knownEmails = new Set<string>();
    const knownDomains = new Set<string>();
    const canonicalByKey = new Map<string, string>(); // normalized -> profile vendor name
    for (const r of vp.rows) {
        canonicalByKey.set(normalizeVendor(r.vendor_name), r.vendor_name);
        if (r.orders_email) knownEmails.add(String(r.orders_email).toLowerCase().trim());
        for (const e of r.vendor_emails || []) knownEmails.add(String(e).toLowerCase().trim());
        for (const d of r.vendor_domains || []) knownDomains.add(String(d).toLowerCase().trim());
    }

    const db = new Database("aria-local.db", { readonly: true });
    const rows = db.prepare("select email_from, ocr_vendor_name from ap_local_forwards").all() as any[];

    let unresolved = 0, withVendor = 0, junkOnly = 0;
    const byDomain = new Map<string, Map<string, { n: number; sample: string }>>();
    for (const r of rows) {
        const raw = String(r.email_from || "");
        const addr = (raw.match(/<([^>]+)>/)?.[1] ?? raw).toLowerCase().trim();
        if (!addr.includes("@")) continue;
        if (knownEmails.has(addr)) continue;
        const domain = addr.split("@")[1];
        if (!domain || knownDomains.has(domain)) continue;
        unresolved++;
        const vendor = String(r.ocr_vendor_name || "").trim();
        if (!vendor || JUNK.test(vendor)) { junkOnly++; continue; }
        withVendor++;
        const key = normalizeVendor(vendor);
        if (!key) { junkOnly++; continue; }
        if (!byDomain.has(domain)) byDomain.set(domain, new Map());
        const m = byDomain.get(domain)!;
        const cur = m.get(key) ?? { n: 0, sample: vendor };
        cur.n++;
        m.set(key, cur);
    }

    console.log(`unresolved-sender forwards: ${unresolved}`);
    console.log(`  with a usable vendor named in the PDF: ${withVendor}`);
    console.log(`  junk/empty vendor label: ${junkOnly}`);
    console.log(`  distinct domains: ${byDomain.size}\n`);

    const seeds: any[] = [], blocked: any[] = [], ambiguous: any[] = [];
    for (const [domain, dist] of byDomain) {
        const total = [...dist.values()].reduce((a, b) => a + (b as any).n, 0);
        const sorted = [...dist.entries()].sort((a, b) => b[1].n - a[1].n);
        const [key, top] = sorted[0];
        const single = sorted.length === 1;
        const entry = { domain, vendor: top.sample, key, n: top.n, total, inProfiles: canonicalByKey.has(key) };
        if (NEVER_SEED.has(domain)) { blocked.push(entry); continue; }
        if (single) seeds.push(entry);
        else ambiguous.push({ ...entry, detail: sorted.map(([k, v]) => `${v.sample}:${v.n}`).join(", ") });
    }

    seeds.sort((a, b) => b.total - a.total);
    console.log("=== SAFE SEED CANDIDATES (normalized-unanimous, non-proxy) ===");
    let recoverable = 0;
    for (const s of seeds) {
        recoverable += s.total;
        console.log(`  ${s.domain} -> ${s.vendor} (${s.total} fwd)${s.inProfiles ? "" : "  [needs a vendor_profiles row]"}`);
    }
    console.log(`  => ${seeds.length} domains, ${recoverable} forwards actually recoverable (${((recoverable / unresolved) * 100).toFixed(1)}% of unresolved)`);

    console.log("\n=== BLOCKED (proxy / consumer / carrier — must never be seeded) ===");
    for (const b of blocked.sort((a, b) => b.total - a.total).slice(0, 10))
        console.log(`  ${b.domain} -> ${b.vendor} (${b.total} fwd)`);

    console.log("\n=== STILL AMBIGUOUS after normalization ===");
    for (const a of ambiguous) console.log(`  ${a.domain}: ${a.detail}`);

    db.close();
    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
