// 1) Blast radius of the dead vendor_emails / vendor_domains filters:
//    how many AP forwards could only be resolved by address or domain, i.e.
//    returned null vendor before the `.overlaps` fix and now resolve.
// 2) Stale-lifecycle audit: needs_spec rows whose missing_template_skus are all
//    covered by an approved axiom_order_templates row — these should have been
//    re-assessed and never were, because the reassessment query always errored.
import { Client } from "pg";
import Database from "better-sqlite3";
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    // ---- 1) vendor resolution -------------------------------------------
    const vp = await pg.query("select vendor_name, orders_email, vendor_emails, vendor_domains from vendor_profiles");
    const byOrders = new Map<string, string>();
    const byEmail = new Map<string, string>();
    const byDomain = new Map<string, string>();
    for (const r of vp.rows) {
        if (r.orders_email) byOrders.set(String(r.orders_email).toLowerCase().trim(), r.vendor_name);
        for (const e of r.vendor_emails || []) if (e) byEmail.set(String(e).toLowerCase().trim(), r.vendor_name);
        for (const d of r.vendor_domains || []) if (d) byDomain.set(String(d).toLowerCase().trim(), r.vendor_name);
    }
    console.log(
        `vendor_profiles: ${vp.rowCount} rows, ${byOrders.size} orders_email, ${byEmail.size} vendor_emails, ${byDomain.size} vendor_domains`,
    );

    const db = new Database("aria-local.db", { readonly: true });
    const forwards = db
        .prepare("select gmail_message_id, email_from, matched_po_number, ocr_vendor_name from ap_local_forwards")
        .all() as any[];
    console.log(`ap_local_forwards: ${forwards.length} rows`);

    const bucket = { orders: 0, emailOnly: 0, domainOnly: 0, none: 0 };
    const recovered: Array<{ from: string; vendor: string; po: string | null; via: string }> = [];
    const recoveredByVendor = new Map<string, number>();
    for (const f of forwards) {
        const email = String(f.email_from || "").toLowerCase().trim();
        const at = email.lastIndexOf("@");
        const addr = at >= 0 ? (email.match(/<([^>]+)>/)?.[1] ?? email).toLowerCase().trim() : "";
        const domain = addr.includes("@") ? addr.split("@")[1] : "";
        if (byOrders.has(addr)) { bucket.orders++; continue; }
        const vEmail = byEmail.get(addr);
        const vDomain = domain ? byDomain.get(domain) : undefined;
        if (vEmail) {
            bucket.emailOnly++;
            recovered.push({ from: addr, vendor: vEmail, po: f.matched_po_number, via: "vendor_emails" });
            recoveredByVendor.set(vEmail, (recoveredByVendor.get(vEmail) || 0) + 1);
        } else if (vDomain) {
            bucket.domainOnly++;
            recovered.push({ from: addr, vendor: vDomain, po: f.matched_po_number, via: "vendor_domains" });
            recoveredByVendor.set(vDomain, (recoveredByVendor.get(vDomain) || 0) + 1);
        } else bucket.none++;
    }
    console.log(`\nresolution buckets: orders_email=${bucket.orders} vendor_emails=${bucket.emailOnly} vendor_domains=${bucket.domainOnly} unresolved=${bucket.none}`);
    console.log(`RECOVERED by the fix (previously null): ${bucket.emailOnly + bucket.domainOnly} forwards, ${recoveredByVendor.size} distinct vendors`);

    // does the recovered vendor agree with the PO the forward was matched to?
    const poVendors = await pg.query(
        "select po_number, vendor_name from purchase_orders where po_number = any($1::text[])",
        [[...new Set(recovered.map((r) => r.po).filter(Boolean))]],
    );
    const poVendor = new Map(poVendors.rows.map((r: any) => [r.po_number, r.vendor_name]));
    let agree = 0, conflict = 0, noPo = 0;
    const conflicts: any[] = [];
    for (const r of recovered) {
        if (!r.po) { noPo++; continue; }
        const pv = poVendor.get(r.po);
        if (!pv) { noPo++; continue; }
        if (String(pv).trim().toLowerCase() === r.vendor.trim().toLowerCase()) agree++;
        else { conflict++; if (conflicts.length < 8) conflicts.push({ ...r, po_vendor: pv }); }
    }
    console.log(`  recovered rows vs their matched PO vendor: agree=${agree} conflict=${conflict} no_po_or_unknown=${noPo}`);
    for (const c of conflicts) console.log(`  CONFLICT ${c.from} -> ${c.vendor} (${c.via}) but PO ${c.po} is ${c.po_vendor}`);
    console.log(`  top vendors recovered: ${[...recoveredByVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}(${n})`).join(", ")}`);

    // ---- 2) stale lifecycle audit ---------------------------------------
    const lc = await pg.query(
        "select po_number, vendor_name, status, missing_template_skus, created_at::date::text created from axiom_order_lifecycle where status = 'needs_spec' order by created_at",
    );
    const tpl = await pg.query("select finale_sku from axiom_order_templates where approved");
    const approvedSkus = new Set(tpl.rows.map((r: any) => String(r.finale_sku)));
    console.log(`\naxiom_order_lifecycle needs_spec rows: ${lc.rowCount}; approved templates: ${approvedSkus.size} SKUs`);
    const stale = lc.rows.filter((r: any) => (r.missing_template_skus || []).length > 0 && (r.missing_template_skus as string[]).every((s) => approvedSkus.has(String(s))));
    const partial = lc.rows.filter((r: any) => {
        const m = (r.missing_template_skus || []) as string[];
        return m.length > 0 && m.some((s) => approvedSkus.has(String(s))) && !m.every((s) => approvedSkus.has(String(s)));
    });
    console.log(`  FULLY covered by an approved template now (should have re-assessed): ${stale.length}`);
    for (const r of stale.slice(0, 15)) console.log(`  STALE ${r.po_number} ${r.vendor_name} created ${r.created} missing=${JSON.stringify(r.missing_template_skus)}`);
    console.log(`  PARTIALLY covered (still legitimately needs_spec): ${partial.length}`);

    db.close();
    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
