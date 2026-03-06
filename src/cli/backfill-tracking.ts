/**
 * @file backfill-tracking.ts
 * @purpose Backfill tracking numbers from the last N days of Gmail.
 *          Phase 1: PO-labeled threads (label:PO)
 *          Phase 2: Inbox parcel shipping notifications (subject:shipped/tracking/etc.)
 *          Phase 3: Freight/LTL emails (subject:freight/pro/bol/pickup/delivery)
 *
 *          LTL carrier name is detected via keyword matching (no LLM required).
 *          PRO/BOL numbers stored as "CarrierName:::PRO#" for clickable links + status.
 *          Safe to re-run — deduplicates before upserting.
 *
 * Usage:
 *   node --import tsx src/cli/backfill-tracking.ts
 *   node --import tsx src/cli/backfill-tracking.ts --days 60
 *   node --import tsx src/cli/backfill-tracking.ts --days 30 --dry-run
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { google } from "googleapis";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { createClient } from "../lib/supabase";

// ── Arg parsing ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const daysBack = parseInt(args[args.indexOf("--days") + 1] || "14", 10);
const dryRun = args.includes("--dry-run");

// ── Tracking patterns ──────────────────────────────────────────────────────────
const TRACKING_PATTERNS: Record<string, RegExp> = {
    ups:     /\b1Z[0-9A-Z]{16}\b/gi,
    fedex:   /\b(96\d{18}|\d{15}|\d{12})\b/g,
    usps:    /\b(94|92|93|95)\d{20}\b/g,
    dhl:     /\bJD\d{18}\b/gi,
    // generic: '#' or ':' required — prevents "tracking information" false positives
    generic: /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/gi,
    // PRO/BOL: whitespace required after keyword — prevents "production"/"bolus" false matches
    pro:     /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/gi,
    bol:     /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/gi,
};

// ── LTL carrier keyword detection ─────────────────────────────────────────────
// Ordered by specificity (longer matches before short ones to avoid false prefix matches)
const LTL_CARRIER_KEYWORDS: [RegExp, string][] = [
    [/\bold\s+dominion\s+freight\b/i,  "Old Dominion"],
    [/\bold\s+dominion\b/i,            "Old Dominion"],
    [/\bodfl\b/i,                      "Old Dominion"],
    [/\bdayton\s+freight\b/i,          "Dayton Freight"],
    [/\bfedex\s+freight\b/i,           "FedEx Freight"],
    [/\br\s*&\s*l\s+carriers?\b/i,     "R&L Carriers"],
    [/\brl\s+carriers?\b/i,            "R&L Carriers"],
    [/\bxpo\s+logistics\b/i,           "XPO Logistics"],
    [/\bxpo\b/i,                       "XPO Logistics"],
    [/\btforce\s+freight\b/i,          "TForce Freight"],
    [/\bups\s+freight\b/i,             "TForce Freight"],
    [/\byrc\s+freight\b/i,             "YRC Freight"],
    [/\byellow\s+freight\b/i,          "Yellow Freight"],
    [/\bcentral\s+transport\b/i,       "Central Transport"],
    [/\babf\s+freight\b/i,             "ABF Freight"],
    [/\barcbest\b/i,                   "ArcBest"],
    [/\bestes\s+express\b/i,           "Estes"],
    [/\bestes\b/i,                     "Estes"],
    [/\bsaia\b/i,                      "Saia"],
];

function detectLTLCarrier(text: string): string | null {
    for (const [pattern, name] of LTL_CARRIER_KEYWORDS) {
        if (pattern.test(text)) return name;
    }
    return null;
}

// ── Validation ────────────────────────────────────────────────────────────────
function isValidTrackingNumber(num: string): boolean {
    return (num.match(/\d/g)?.length ?? 0) >= 2;
}

// ── Body decode helpers ────────────────────────────────────────────────────────
function decodeBase64(data: string): string {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractBodyText(payload: any): string {
    const parts: string[] = [];
    if (payload?.body?.data) parts.push(decodeBase64(payload.body.data));
    const walk = (items: any[]) => {
        for (const p of items ?? []) {
            if (p.mimeType === "text/plain" && p.body?.data) parts.push(decodeBase64(p.body.data));
            if (p.mimeType === "text/html" && p.body?.data && parts.length === 0) {
                parts.push(decodeBase64(p.body.data).replace(/<[^>]+>/g, " "));
            }
            if (p.parts?.length) walk(p.parts);
        }
    };
    if (payload?.parts) walk(payload.parts);
    return parts.join("\n");
}

// ── Tracking extraction ────────────────────────────────────────────────────────
// Returns tracking numbers, LTL ones encoded as "CarrierName:::PRO#"
function extractTracking(bodyText: string, snippet: string, subject = ""): string[] {
    const fullText = subject + "\n" + snippet + "\n" + bodyText;
    const found: string[] = [];
    const ltlCarrier = detectLTLCarrier(fullText);

    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const num = ["generic", "pro", "bol"].includes(carrier) ? (match[1] || match[0]) : match[0];
            if (!num || !isValidTrackingNumber(num)) continue;
            if (found.some(t => (t.split(":::")[1] || t) === num)) continue;

            // For PRO/BOL numbers, encode with carrier name if detected in context
            if ((carrier === "pro" || carrier === "bol") && ltlCarrier) {
                found.push(`${ltlCarrier}:::${num}`);
            } else {
                found.push(num);
            }
        }
    }

    return found;
}

// ── Upsert helper ─────────────────────────────────────────────────────────────
async function upsertTracking(
    supabase: any,
    poNumber: string,
    allFound: string[],
    dryRun: boolean
): Promise<string[]> {
    const { data: existingPO } = await supabase
        .from("purchase_orders")
        .select("tracking_numbers")
        .eq("po_number", poNumber)
        .maybeSingle();
    const oldTracking: string[] = existingPO?.tracking_numbers || [];

    // Dedup: treat "CarrierName:::PRO" and bare "PRO" as the same number
    const newTracking = allFound.filter(t => {
        const rawNum = t.split(":::")[1] || t;
        return !oldTracking.some(o => (o.split(":::")[1] || o) === rawNum);
    });
    const merged = [...new Set([...oldTracking, ...allFound])];

    if (newTracking.length === 0) return [];

    if (!dryRun) {
        const { error } = await supabase.from("purchase_orders").upsert({
            po_number: poNumber,
            tracking_numbers: merged,
            updated_at: new Date().toISOString(),
        }, { onConflict: "po_number" });
        if (error) console.error(`   ❌ Upsert failed for PO #${poNumber}:`, error.message);
        else console.log(`   ✅ Persisted ${newTracking.length} new for PO #${poNumber}: [${newTracking.join(", ")}]`);
    } else {
        console.log(`   [DRY RUN] Would persist for PO #${poNumber}: [${newTracking.join(", ")}]`);
    }
    return newTracking;
}

// ── Vendor matching helpers ────────────────────────────────────────────────────
function buildVendorNormMap(threadSubjects: { subject: string }[], supabasePOs: any[]) {
    const map: { words: string[]; poNumber: string }[] = [];

    for (const { subject } of threadSubjects) {
        const vMatch = subject.match(/BuildASoil PO\s*#?\s*(\d+)\s*-\s*(.+?)\s*-\s*[\d/]+$/i);
        if (vMatch) {
            map.push({
                poNumber: vMatch[1],
                words: vMatch[2].trim().toLowerCase().split(/[\s,\.]+/).filter(w => w.length > 3),
            });
        }
    }
    for (const po of supabasePOs ?? []) {
        if (po.vendor_name && !map.some(v => v.poNumber === po.po_number)) {
            map.push({
                poNumber: po.po_number,
                words: po.vendor_name.toLowerCase().split(/[\s,\.]+/).filter((w: string) => w.length > 3),
            });
        }
    }
    return map;
}

function matchVendorDomain(domain: string, vendorNormMap: { words: string[]; poNumber: string }[]): string | null {
    const domainWords = domain
        .replace(/\.(com|net|org|io|co|us)$/, "")
        .replace(/^(send|info|noreply|store|mail|ship|hello|orders|notification|no-reply|shipping)\./i, "")
        .split(/[.\-_]/).filter(w => w.length >= 5);
    if (domainWords.length === 0) return null;
    for (const v of vendorNormMap) {
        const longWords = v.words.filter(w => w.length >= 5);
        if (longWords.length === 0) continue;
        const overlap = domainWords.filter(dw => longWords.some(vw => vw.includes(dw) || dw.includes(vw)));
        if (overlap.length > 0) return v.poNumber;
    }
    return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n🔍 Tracking Backfill — last ${daysBack} days${dryRun ? " [DRY RUN]" : ""}\n`);

    const auth = await getAuthenticatedClient("default");
    const gmail = google.gmail({ version: "v1", auth });
    const supabase = createClient();
    if (!supabase) { console.error("❌ Supabase unavailable"); process.exit(1); }

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, "/");

    let totalNew = 0;
    const threadSubjects: { subject: string }[] = [];

    // ── Phase 1: PO-labeled threads ──────────────────────────────────────────
    console.log(`── Phase 1: PO thread replies (label:PO after:${sinceStr})\n`);
    const { data: poSearch } = await gmail.users.messages.list({
        userId: "me",
        q: `label:PO after:${sinceStr}`,
        maxResults: 100,
    });

    const seenThreads = new Set<string>();
    const threadIds: string[] = [];
    for (const m of poSearch?.messages ?? []) {
        if (m.threadId && !seenThreads.has(m.threadId)) {
            seenThreads.add(m.threadId);
            threadIds.push(m.threadId);
        }
    }
    console.log(`   ${threadIds.length} unique PO threads to scan.\n`);

    for (const threadId of threadIds) {
        const { data: thread } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
        if (!thread.messages?.length) continue;

        const firstMsg = thread.messages[0];
        const subject = firstMsg.payload?.headers?.find(h => h.name === "Subject")?.value || "";
        const poMatch = subject.match(/BuildASoil PO\s*#?\s*(\d+)/i);
        if (!poMatch) continue;
        const poNumber = poMatch[1];
        threadSubjects.push({ subject });

        const allFound: string[] = [];
        for (const msg of thread.messages) {
            const bodyText = extractBodyText(msg.payload);
            const extracted = extractTracking(bodyText, msg.snippet || "", subject);
            for (const t of extracted) {
                const rawNum = t.split(":::")[1] || t;
                if (!allFound.some(x => (x.split(":::")[1] || x) === rawNum)) allFound.push(t);
            }
        }

        if (allFound.length === 0) {
            console.log(`   PO #${poNumber} — no tracking   [${subject.slice(0, 65)}]`);
        } else {
            console.log(`   PO #${poNumber} — found: [${allFound.join(", ")}]`);
            const newT = await upsertTracking(supabase, poNumber, allFound, dryRun);
            totalNew += newT.length;
        }
    }

    // Load Supabase POs for vendor matching
    const { data: supabasePOs } = await supabase
        .from("purchase_orders").select("po_number, vendor_name")
        .not("vendor_name", "is", null).order("created_at", { ascending: false }).limit(300);
    const vendorNormMap = buildVendorNormMap(threadSubjects, supabasePOs);

    // ── Phase 2: Inbox parcel shipping notifications ──────────────────────────
    console.log(`\n── Phase 2: Parcel shipping notifications (last ${daysBack} days)\n`);
    const { data: parcelSearch } = await gmail.users.messages.list({
        userId: "me",
        q: `in:anywhere after:${sinceStr} (subject:shipped OR subject:tracking OR subject:shipment OR subject:"your order" OR subject:"order shipped" OR subject:"on its way" OR subject:"out for delivery" OR subject:"your shipment" OR subject:delivered)`,
        maxResults: 150,
    });

    let p2Matched = 0;
    let p2Unmatched: { subject: string; from: string; tracking: string[] }[] = [];

    for (const m of parcelSearch?.messages ?? []) {
        const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
        if (!msg) continue;

        const headers = msg.payload?.headers ?? [];
        const subject = headers.find(h => h.name === "Subject")?.value || "";
        const fromHeader = headers.find(h => h.name === "From")?.value || "";
        const fromEmail = (fromHeader.match(/<([^>]+)>/) || [])[1] || fromHeader;
        const fromDomain = fromEmail.split("@")[1]?.toLowerCase() || "";

        if (fromEmail.toLowerCase().endsWith("@buildasoil.com")) continue;

        const bodyText = extractBodyText(msg.payload);
        const allTracking = extractTracking(bodyText, msg.snippet || "", subject);
        if (allTracking.length === 0) continue;

        const poInText = (subject + " " + (msg.snippet || "") + " " + bodyText).match(/\bPO\s*#?\s*(\d{5,6})\b/i);
        let matchedPO: string | null = poInText ? poInText[1] : matchVendorDomain(fromDomain, vendorNormMap);

        if (matchedPO) {
            console.log(`   [PO #${matchedPO}] From: ${fromEmail} | Tracking: [${allTracking.join(", ")}]`);
            const newT = await upsertTracking(supabase, matchedPO, allTracking, dryRun);
            totalNew += newT.length;
            p2Matched++;
        } else {
            p2Unmatched.push({ subject: subject.slice(0, 65), from: fromEmail, tracking: allTracking });
        }
    }

    if (p2Unmatched.length > 0) {
        console.log(`\n   ⚠️  ${p2Unmatched.length} parcel email(s) unmatched to a PO:`);
        for (const u of p2Unmatched) {
            console.log(`      From: ${u.from}`);
            console.log(`      Subject: ${u.subject}`);
            console.log(`      Tracking: [${u.tracking.join(", ")}]`);
            console.log();
        }
    }

    // ── Phase 3: Freight / LTL email scan ────────────────────────────────────
    console.log(`\n── Phase 3: Freight / LTL emails (last ${daysBack} days)\n`);
    const { data: freightSearch } = await gmail.users.messages.list({
        userId: "me",
        q: `in:anywhere after:${sinceStr} (subject:freight OR subject:"pro #" OR subject:"bill of lading" OR subject:pickup OR subject:ltl OR subject:pallet OR subject:"delivery notice" OR subject:"freight shipment" OR subject:truck OR saia OR "old dominion" OR estes OR xpo OR "r&l carriers" OR "dayton freight" OR "marion ag")`,
        maxResults: 150,
    });

    let p3Matched = 0;
    let p3Unmatched: { subject: string; from: string; tracking: string[] }[] = [];

    for (const m of freightSearch?.messages ?? []) {
        if (!m.id) continue;
        const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        if (!msg) continue;

        const headers = msg.payload?.headers ?? [];
        const subject = headers.find(h => h.name === "Subject")?.value || "";
        const fromHeader = headers.find(h => h.name === "From")?.value || "";
        const fromEmail = (fromHeader.match(/<([^>]+)>/) || [])[1] || fromHeader;
        const fromDomain = fromEmail.split("@")[1]?.toLowerCase() || "";

        if (fromEmail.toLowerCase().endsWith("@buildasoil.com")) continue;

        const bodyText = extractBodyText(msg.payload);
        const allTracking = extractTracking(bodyText, msg.snippet || "", subject);
        if (allTracking.length === 0) continue;

        // PRO/BOL numbers without carrier name? Log them so we can see.
        const hasLTL = allTracking.some(t => t.includes(":::"));
        const hasBarePRO = allTracking.some(t => !t.includes(":::") && /^\d{7,15}$/.test(t));

        const poInText = (subject + " " + (msg.snippet || "") + " " + bodyText).match(/\bPO\s*#?\s*(\d{5,6})\b/i);
        let matchedPO: string | null = poInText ? poInText[1] : matchVendorDomain(fromDomain, vendorNormMap);

        if (matchedPO) {
            const ltlLabel = hasLTL ? " [LTL]" : hasBarePRO ? " [PRO-no-carrier]" : "";
            console.log(`   [PO #${matchedPO}]${ltlLabel} From: ${fromEmail}`);
            console.log(`      Subject: ${subject.slice(0, 65)}`);
            console.log(`      Tracking: [${allTracking.join(", ")}]`);
            const newT = await upsertTracking(supabase, matchedPO, allTracking, dryRun);
            totalNew += newT.length;
            p3Matched++;
        } else {
            p3Unmatched.push({ subject: subject.slice(0, 65), from: fromEmail, tracking: allTracking });
        }
    }

    if (p3Unmatched.length > 0) {
        console.log(`\n   ⚠️  ${p3Unmatched.length} freight email(s) unmatched to a PO:`);
        for (const u of p3Unmatched) {
            console.log(`      From: ${u.from}`);
            console.log(`      Subject: ${u.subject}`);
            console.log(`      Tracking: [${u.tracking.join(", ")}]`);
            console.log();
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`✅ Backfill complete`);
    console.log(`   Phase 1 (PO threads):       ${threadIds.length} threads scanned`);
    console.log(`   Phase 2 (parcel inbox):      ${(parcelSearch?.messages ?? []).length} emails, ${p2Matched} matched, ${p2Unmatched.length} unmatched`);
    console.log(`   Phase 3 (freight inbox):     ${(freightSearch?.messages ?? []).length} emails, ${p3Matched} matched, ${p3Unmatched.length} unmatched`);
    console.log(`   Total new tracking persisted: ${totalNew}`);
    if (dryRun) console.log(`   [DRY RUN — nothing was written]`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
