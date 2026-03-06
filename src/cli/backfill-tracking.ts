/**
 * @file backfill-tracking.ts
 * @purpose Backfill tracking numbers from the last N days of Gmail PO threads.
 *          Scans full message bodies (not snippets) to catch complete tracking numbers.
 *          Safe to re-run — deduplicates before upserting.
 *
 * Usage:
 *   node --import tsx src/cli/backfill-tracking.ts
 *   node --import tsx src/cli/backfill-tracking.ts --days 30
 *   node --import tsx src/cli/backfill-tracking.ts --days 7 --dry-run
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { google } from "googleapis";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { createClient } from "../lib/supabase";
import { unifiedObjectGeneration } from "../lib/intelligence/llm";
import { z } from "zod";

// ── Arg parsing ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const daysBack = parseInt(args[args.indexOf("--days") + 1] || "14", 10);
const dryRun = args.includes("--dry-run");

// ── Tracking patterns ──────────────────────────────────────────────────────────
// PRO/BOL require whitespace after keyword to avoid false matches like "production"/"bolus".
// Generic requires at least 2 digits in captured number (validated below).
const TRACKING_PATTERNS: Record<string, RegExp> = {
    ups:     /\b1Z[0-9A-Z]{16}\b/gi,
    fedex:   /\b(96\d{18}|\d{15}|\d{12})\b/g,
    usps:    /\b(94|92|93|95)\d{20}\b/g,
    dhl:     /\bJD\d{18}\b/gi,
    generic: /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/gi,
    pro:     /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/gi,
    bol:     /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/gi,
};

// Tracking numbers must contain at least 2 digits — pure-word false positives get filtered
function isValidTrackingNumber(num: string): boolean {
    return (num.match(/\d/g)?.length ?? 0) >= 2;
}

// LTL keywords that trigger LLM fallback (only when --llm flag is passed)
const LTL_KEYWORDS = ["pro #", "pro-", "pro number", "bol", "bill of lading", "freight", "ltl", "pallet",
    "saia", "odfl", "old dominion", "dominion", "estes", "xpo", "dayton freight", "r&l carriers", "tforce"];
const useLLM = args.includes("--llm");

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
                // Strip HTML tags as last resort
                parts.push(decodeBase64(p.body.data).replace(/<[^>]+>/g, " "));
            }
            if (p.parts?.length) walk(p.parts);
        }
    };
    if (payload?.parts) walk(payload.parts);
    return parts.join("\n");
}

// ── Tracking extraction ────────────────────────────────────────────────────────
async function extractTracking(bodyText: string, snippet: string): Promise<string[]> {
    const fullText = snippet + "\n" + bodyText;
    const found: string[] = [];

    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            // generic/pro/bol have capture group [1]; others use full match[0]
            const num = ["generic", "pro", "bol"].includes(carrier) ? (match[1] || match[0]) : match[0];
            if (num && isValidTrackingNumber(num) && !found.some(t => t.includes(num))) {
                found.push(num);
            }
        }
    }

    // LTL LLM fallback — only when --llm flag passed (providers may be at quota)
    const lowerText = fullText.toLowerCase();
    if (useLLM && LTL_KEYWORDS.some(kw => lowerText.includes(kw))) {
        try {
            const schema = z.object({
                shipments: z.array(z.object({
                    carrierName: z.string(),
                    trackingNumber: z.string(),
                    type: z.enum(["PRO", "BOL", "OTHER"]),
                }))
            });
            const res = await unifiedObjectGeneration({
                system: "You are a tracking extraction agent. Locate freight/trucking PRO# or BOL# references. Return nothing if none found. Extract only actual numeric tracking codes (PRO/BOL numbers are digits only).",
                prompt: `Extract LTL/freight tracking numbers from this text:\n\n${fullText.slice(0, 5000)}`,
                schema,
                schemaName: "LTLBackfill"
            }) as { shipments: { carrierName: string; trackingNumber: string; type: string }[] };

            for (const s of res?.shipments ?? []) {
                if (!s.trackingNumber || !isValidTrackingNumber(s.trackingNumber)) continue;
                const encoded = `${s.carrierName}:::${s.trackingNumber}`;
                const existingIdx = found.findIndex(t => t === s.trackingNumber);
                if (existingIdx !== -1) {
                    found[existingIdx] = encoded;
                    console.log(`       ↑ Upgraded ${s.trackingNumber} → ${encoded}`);
                } else if (!found.some(t => t.includes(s.trackingNumber))) {
                    found.push(encoded);
                }
            }
        } catch (e: any) {
            console.warn(`       ⚠️  LLM LTL extraction failed: ${e.message}`);
        }
    }

    return found;
}

// ── Upsert helper ─────────────────────────────────────────────────────────────
async function upsertTracking(supabase: any, poNumber: string, allFound: string[], dryRun: boolean): Promise<string[]> {
    const { data: existingPO } = await supabase
        .from("purchase_orders")
        .select("tracking_numbers")
        .eq("po_number", poNumber)
        .maybeSingle();
    const oldTracking: string[] = existingPO?.tracking_numbers || [];
    const newTracking = allFound.filter(t => !oldTracking.some(o => o.includes(t.split(":::")[1] || t)));
    const merged = [...new Set([...oldTracking, ...allFound])];

    if (!dryRun && newTracking.length > 0) {
        const { error } = await supabase.from("purchase_orders").upsert({
            po_number: poNumber,
            tracking_numbers: merged,
            updated_at: new Date().toISOString(),
        }, { onConflict: "po_number" });
        if (error) console.error(`   ❌ Upsert failed for PO #${poNumber}:`, error.message);
        else console.log(`   ✅ Persisted ${newTracking.length} new tracking(s) for PO #${poNumber}: [${newTracking.join(", ")}]`);
    } else if (dryRun && newTracking.length > 0) {
        console.log(`   [DRY RUN] Would persist for PO #${poNumber}: [${newTracking.join(", ")}]`);
    }
    return newTracking;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n🔍 Tracking Backfill — last ${daysBack} days${dryRun ? " [DRY RUN]" : ""}${useLLM ? " [LLM enabled]" : ""}\n`);

    const auth = await getAuthenticatedClient("default");
    const gmail = google.gmail({ version: "v1", auth });
    const supabase = createClient();

    if (!supabase) {
        console.error("❌ Supabase unavailable");
        process.exit(1);
    }

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, "/");

    let totalNew = 0;

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
        const { data: thread } = await gmail.users.threads.get({
            userId: "me",
            id: threadId,
            format: "full",
        });
        if (!thread.messages?.length) continue;

        const firstMsg = thread.messages[0];
        const subject = firstMsg.payload?.headers?.find(h => h.name === "Subject")?.value || "";
        const poMatch = subject.match(/BuildASoil PO\s*#?\s*(\d+)/i);
        if (!poMatch) continue;
        const poNumber = poMatch[1];

        // Collect ALL tracking from ALL messages in thread
        const allFound: string[] = [];
        for (const msg of thread.messages) {
            const bodyText = extractBodyText(msg.payload);
            const snippet = msg.snippet || "";
            const extracted = await extractTracking(bodyText, snippet);
            for (const t of extracted) {
                if (!allFound.some(x => x.includes(t.split(":::")[1] || t))) {
                    allFound.push(t);
                }
            }
        }

        if (allFound.length === 0) {
            console.log(`   PO #${poNumber} — no tracking found   [${subject.slice(0, 60)}]`);
            continue;
        }

        if (allFound.length > 0) {
            console.log(`   PO #${poNumber} — found: [${allFound.join(", ")}]`);
            const newT = await upsertTracking(supabase, poNumber, allFound, dryRun);
            totalNew += newT.length;
        } else {
            console.log(`   PO #${poNumber} — no tracking   [${subject.slice(0, 55)}]`);
        }
    }

    // ── Phase 2: Inbox shipping notification scan ─────────────────────────────
    console.log(`\n── Phase 2: Inbox shipping notifications (last ${daysBack} days)\n`);
    const { data: shipSearch } = await gmail.users.messages.list({
        userId: "me",
        q: `in:anywhere after:${sinceStr} (subject:shipped OR subject:tracking OR subject:shipment OR subject:"your order" OR subject:"order shipped")`,
        maxResults: 100,
    });

    const shipMsgIds = (shipSearch?.messages ?? []).map(m => m.id!).filter(Boolean);
    console.log(`   Found ${shipMsgIds.length} potential shipping notification email(s).\n`);

    // Build vendor name → PO map from Phase 1 subjects
    // Subject format: "BuildASoil PO # 124414 - Sustainable Village - 2/27/2026"
    const poByVendorName = new Map<string, string>(); // normalized vendor words → po_number
    const vendorNormMap: { words: string[]; poNumber: string }[] = [];
    for (const threadId of threadIds) {
        const { data: th } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata" });
        const firstSubj = th?.messages?.[0]?.payload?.headers?.find(h => h.name === "Subject")?.value || "";
        const vMatch = firstSubj.match(/BuildASoil PO\s*#?\s*(\d+)\s*-\s*(.+?)\s*-\s*[\d/]+$/i);
        if (vMatch) {
            const poNum = vMatch[1];
            const vendorName = vMatch[2].trim().toLowerCase();
            // Tokenize: split on spaces, remove noise words
            const words = vendorName.split(/[\s,\.]+/).filter(w => w.length > 3);
            vendorNormMap.push({ words, poNumber: poNum });
        }
    }
    // Also load from Supabase vendor_name column for broader coverage
    const { data: supabasePOs } = await supabase
        .from("purchase_orders")
        .select("po_number, vendor_name")
        .not("vendor_name", "is", null)
        .order("created_at", { ascending: false })
        .limit(300);
    for (const po of supabasePOs ?? []) {
        if (po.vendor_name) {
            const words = po.vendor_name.toLowerCase().split(/[\s,\.]+/).filter((w: string) => w.length > 3);
            if (!vendorNormMap.some(v => v.poNumber === po.po_number)) {
                vendorNormMap.push({ words, poNumber: po.po_number });
            }
        }
    }

    // Match shipping email sender domain against vendor words
    // Requires ≥5 char words to avoid generic false positives ("soil", "corp", etc.)
    function matchVendorDomain(domain: string): string | null {
        const domainWords = domain.replace(/\.(com|net|org|io|co|us)$/, "")
            .replace(/^(send|info|noreply|store|mail|ship|hello|orders|notification|no-reply)\./i, "")
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

    let p2Matched = 0;
    let p2Unmatched: { subject: string; from: string; tracking: string[] }[] = [];

    for (const msgId of shipMsgIds) {
        const { data: msg } = await gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
        });
        if (!msg) continue;

        const headers = msg.payload?.headers ?? [];
        const subject = headers.find(h => h.name === "Subject")?.value || "";
        const fromHeader = headers.find(h => h.name === "From")?.value || "";
        const fromEmail = (fromHeader.match(/<([^>]+)>/) || [])[1] || fromHeader;
        const fromDomain = fromEmail.split("@")[1]?.toLowerCase() || "";

        const bodyText = extractBodyText(msg.payload);
        const snippet = msg.snippet || "";
        const allTracking = await extractTracking(bodyText, snippet);

        if (allTracking.length === 0) continue;

        // Skip emails sent FROM BuildASoil accounts (Will's own replies/forwards)
        if (fromEmail.toLowerCase().endsWith("@buildasoil.com")) continue;

        // Try to find PO # in subject/body first
        const poInText = (subject + " " + snippet + " " + bodyText).match(/\bPO\s*#?\s*(\d{5,6})\b/i);
        let matchedPO: string | null = poInText ? poInText[1] : null;

        // Fallback: fuzzy match vendor name from sender domain
        if (!matchedPO) matchedPO = matchVendorDomain(fromDomain);

        if (matchedPO) {
            console.log(`   [PO #${matchedPO}] From: ${fromEmail} | Tracking: [${allTracking.join(", ")}]`);
            const newT = await upsertTracking(supabase, matchedPO, allTracking, dryRun);
            totalNew += newT.length;
            p2Matched++;
        } else {
            p2Unmatched.push({ subject: subject.slice(0, 60), from: fromEmail, tracking: allTracking });
        }
    }

    if (p2Unmatched.length > 0) {
        console.log(`\n   ⚠️  ${p2Unmatched.length} shipping email(s) had tracking but couldn't be matched to a PO:`);
        for (const u of p2Unmatched) {
            console.log(`      From: ${u.from}`);
            console.log(`      Subject: ${u.subject}`);
            console.log(`      Tracking: [${u.tracking.join(", ")}]`);
            console.log();
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);
    console.log(`✅ Backfill complete`);
    console.log(`   Phase 1 (PO threads):          ${threadIds.length} threads scanned`);
    console.log(`   Phase 2 (inbox scan):           ${shipMsgIds.length} emails, ${p2Matched} matched to POs, ${p2Unmatched.length} unmatched`);
    console.log(`   Total new tracking persisted:   ${totalNew}`);
    if (dryRun) console.log(`   [DRY RUN — nothing was written]`);
}

main().catch(e => {
    console.error("Fatal:", e.message);
    process.exit(1);
});
