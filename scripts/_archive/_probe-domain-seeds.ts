// Can we close the 982-forward blind spot with evidence-based domain seeds?
// Group unresolved-sender forwards by domain and see which vendor the PDF named.
// A domain whose sender vendors agree is a safe candidate for vendor_domains[];
// a domain serving several vendors is not, and must stay unresolved.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PROXY_DOMAINS = new Set([
    "notification.intuit.com",
    "intuit.com",
    "buildasoil.com",
    "gmail.com",
]);

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const vp = await pg.query("select vendor_name, orders_email, vendor_emails, vendor_domains from vendor_profiles");
    const knownEmails = new Set<string>();
    const knownDomains = new Set<string>();
    const vendorNames = new Set<string>();
    for (const r of vp.rows) {
        vendorNames.add(String(r.vendor_name));
        if (r.orders_email) knownEmails.add(String(r.orders_email).toLowerCase().trim());
        for (const e of r.vendor_emails || []) knownEmails.add(String(e).toLowerCase().trim());
        for (const d of r.vendor_domains || []) knownDomains.add(String(d).toLowerCase().trim());
    }

    const db = new Database("aria-local.db", { readonly: true });
    const rows = db
        .prepare("select email_from, ocr_vendor_name from ap_local_forwards")
        .all() as any[];

    const byDomain = new Map<string, Map<string, number>>();
    let unresolved = 0,
        noVendor = 0;
    for (const r of rows) {
        const raw = String(r.email_from || "");
        const addr = (raw.match(/<([^>]+)>/)?.[1] ?? raw).toLowerCase().trim();
        if (!addr.includes("@")) continue;
        if (knownEmails.has(addr)) continue;
        const domain = addr.split("@")[1];
        if (!domain || knownDomains.has(domain)) continue;
        unresolved++;
        const vendor = String(r.ocr_vendor_name || "").trim();
        if (!vendor) {
            noVendor++;
            continue;
        }
        if (!byDomain.has(domain)) byDomain.set(domain, new Map());
        const m = byDomain.get(domain)!;
        m.set(vendor, (m.get(vendor) || 0) + 1);
    }

    console.log(`unresolved-sender forwards: ${unresolved} (of which ${noVendor} have no vendor named in the PDF)`);
    console.log(`domains seen: ${byDomain.size}\n`);

    const candidates: Array<{ domain: string; vendor: string; n: number; total: number; inProfiles: boolean; proxy: boolean }> = [];
    const ambiguous: Array<{ domain: string; detail: string }> = [];
    for (const [domain, dist] of byDomain) {
        const total = [...dist.values()].reduce((a, b) => a + b, 0);
        const [vendor, n] = [...dist.entries()].sort((a, b) => b[1] - a[1])[0];
        if (dist.size === 1) {
            candidates.push({ domain, vendor, n, total, inProfiles: vendorNames.has(vendor), proxy: PROXY_DOMAINS.has(domain) });
        } else {
            ambiguous.push({ domain, detail: [...dist.entries()].map(([v, c]) => `${v}:${c}`).join(", ") });
        }
    }

    candidates.sort((a, b) => b.n - a.n);
    console.log("=== UNANIMOUS domain -> vendor (candidate seeds) ===");
    for (const c of candidates)
        console.log(
            `  ${c.domain} -> ${c.vendor} (${c.n} forwards)${c.inProfiles ? "" : "  [NO PROFILE ROW]"}`,
        );
    console.log(`\n=== AMBIGUOUS domains (must stay unresolved) ===`);
    for (const a of ambiguous) console.log(`  ${a.domain}: ${a.detail}`);

    db.close();
    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
