/**
 * @file    src/lib/purchasing/po-reply-watcher.ts
 * @purpose Watches Gmail threads for vendor replies to sent POs. For each
 *          PO email thread, checks for messages FROM the vendor's domain
 *          sent AFTER the PO was dispatched. When a vendor reply is detected,
 *          updates purchase_orders (vendor_acknowledged_at, human_reply_detected_at,
 *          lifecycle_stage='ACKNOWLEDGED') and inserts a po_lifecycle_transitions row.
 *
 *          Designed as a lightweight cron job — no LLM calls, Gmail API only.
 *          Backfills gmail_thread_id for older PO sends that predate the
 *          thread_id storage addition (2026-06-18).
 *
 * @author  Hermia
 * @created 2026-06-18
 * @deps    @googleapis/gmail, @/lib/gmail/auth, @/lib/db, @/lib/storage/local-db
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "@/lib/db";
import { upsertShipmentEvidence } from "@/lib/tracking/shipment-intelligence";
import { syncPOETA } from "./po-eta-sync";

/** Sent emails from our side come from these addresses. */
const OUR_ADDRESSES = new Set([
    "bill.selee@buildasoil.com",
    "ap@buildasoil.com",
    "buildasoilap@bill.com",
]);

/** How far back to look for sent POs (days). */
const LOOKBACK_DAYS = 30;

/** PO sends older than this won't be checked again once acknowledged. */
const MIN_ACK_GAP_HOURS = 2;

export interface VendorReplyDetection {
    poNumber: string;
    vendorName: string;
    vendorEmail: string;
    sentAt: string;
    replySnippet: string;
    replyFrom: string;
    replyAt: string;
    threadId: string;
    gmailMessageId: string;
}

/**
 * Normalise an email address for comparison — lowercase, strip +aliases.
 */
function normaliseEmail(email: string): string {
    const lower = email.toLowerCase().trim();
    const atIdx = lower.indexOf("@");
    if (atIdx === -1) return lower;
    const local = lower.slice(0, atIdx);
    const domain = lower.slice(atIdx);
    const plusIdx = local.indexOf("+");
    return (plusIdx !== -1 ? local.slice(0, plusIdx) : local) + domain;
}

/**
 * Given a vendor email (e.g. "orders@evergreengrowers.com"), extract the domain
 * for matching sender addresses in thread replies.
 */
function vendorEmailDomain(vendorEmail: string): string {
    const atIdx = vendorEmail.indexOf("@");
    return atIdx !== -1 ? vendorEmail.slice(atIdx + 1).toLowerCase() : vendorEmail.toLowerCase();
}

/**
 * Walk Gmail MIME parts to extract plain-text body content.
 */
function extractTextFromPayload(payload: any): string {
    if (!payload) return "";
    if (payload.mimeType === "text/plain" && typeof payload.body?.data === "string") {
        return Buffer.from(payload.body.data, "base64url").toString("utf-8");
    }
    if (payload.parts && Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
            const text = extractTextFromPayload(part);
            if (text) return text;
        }
    }
    return "";
}

/**
 * Extract tracking numbers from reply body text using regex.
 * Returns an array of unique tracking numbers found.
 */
function extractTrackingNumbers(text: string): string[] {
    const found: string[] = [];
    // UPS: 1Z followed by 16 alphanumeric characters
    const upsRe = /(1Z[A-Z0-9]{16})/gi;
    let m;
    while ((m = upsRe.exec(text)) !== null) found.push(m[1].toUpperCase());
    // FedEx: 12-15 digits or 96XXXXXXXXXXXXXXX format
    const fedexRe = /\b(96\d{18}|\d{15}|\d{12})\b/g;
    while ((m = fedexRe.exec(text)) !== null) found.push(m[1]);
    // USPS: 20-22 digits
    const uspsRe = /\b(94|92|93|95)\d{20}\b/g;
    while ((m = uspsRe.exec(text)) !== null) found.push(m[1]);
    // DHL: JD + 18 digits
    const dhlRe = /\bJD\d{18}\b/gi;
    while ((m = dhlRe.exec(text)) !== null) found.push(m[1].toUpperCase());
    // LTL PRO numbers
    const proRe = /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/gi;
    while ((m = proRe.exec(text)) !== null) found.push(m[1]);
    // Generic tracking keyword patterns
    const genericRe = /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/gi;
    while ((m = genericRe.exec(text)) !== null) found.push(m[1].toUpperCase());

    return [...new Set(found)];
}

/**
 * Extract ETA dates from vendor reply body text.
 * Matches patterns like: "ETA 7/15", "expected ship date July 20, 2026",
 * "delivery by Aug 1", "shipping 07/15/2026".
 * Returns the earliest date found, or null if none detected.
 */
function extractETADate(text: string): string | null {
    const patterns: RegExp[] = [
        // "ETA 7/15/2026" or "ETA: July 20" or "ETA 07/15"
        /\bETA[\s:]*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
        /\bETA[\s:]*(\w+\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
        // "expected ship date 7/15" or "expected delivery July 20"
        /\bexpected\s+(?:ship|delivery|arrival)\s+(?:date|by)?[\s:]*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
        /\bexpected\s+(?:ship|delivery|arrival)\s+(?:date|by)?[\s:]*(\w+\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
        // "delivery by Aug 1" or "arriving on July 20, 2026"
        /\b(?:delivery|arriving|ships?)\s+(?:by|on|date)[\s:]*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
        /\b(?:delivery|arriving|ships?)\s+(?:by|on|date)[\s:]*(\w+\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
        // "shipping 07/15/2026" or "will ship 7/15"
        /\b(?:will\s+)?(?:ship|shipping|send)\s+(?:on|date|by)?[\s:]*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
        // "tracking will be available by 7/20"
        /\b(?:available|ready)\s+by\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/i,
    ];

    const candidates: Date[] = [];

    for (const re of patterns) {
        const m = re.exec(text);
        if (m) {
            const parsed = new Date(m[1]);
            if (!isNaN(parsed.getTime()) && parsed > new Date()) {
                candidates.push(parsed);
            }
        }
    }

    if (candidates.length === 0) return null;

    // Return earliest date
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0].toISOString().slice(0, 10);
}

/**
 * Check if a Gmail message is from us (our sent addresses).
 */
function isFromUs(fromHeader: string): boolean {
    const match = fromHeader.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+)/);
    if (!match) return true; // can't parse — treat as ours to be safe
    return OUR_ADDRESSES.has(normaliseEmail(match[1]));
}

/**
 * Run one pass of the PO reply watcher.
 *
 * 1. Queries po_sends for unacknowledged sends (last 21 days, has gmail_message_id)
 * 2. For each, resolves gmail_thread_id (backfill if missing)
 * 3. Checks the Gmail thread for vendor replies
 * 4. Updates purchase_orders + po_lifecycle_transitions on detection
 *
 * @returns Array of detections from this pass (empty if none found).
 */
export async function runPOReplyWatcher(): Promise<VendorReplyDetection[]> {
    const detections: VendorReplyDetection[] = [];

    // ── 1. Query sends ──────────────────────────────────────────────
    const supabase = createClient();
    if (!supabase) {
        console.warn("[po-reply-watcher] No Supabase client — skipping.");
        return detections;
    }

    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
    const { data: sends, error: sendErr } = await supabase
        .from("po_sends")
        .select("po_number, vendor_name, sent_to_email, sent_at, gmail_message_id, gmail_thread_id")
        .gte("sent_at", cutoff)
        .not("gmail_message_id", "is", null)
        .order("sent_at", { ascending: false })
        .limit(100);

    if (sendErr || !sends) {
        console.warn("[po-reply-watcher] Failed to fetch po_sends:", sendErr?.message);
        return detections;
    }

    if (sends.length === 0) {
        return detections;
    }

    // Deduplicate by PO number (keep most recent send)
    const byPO = new Map<string, (typeof sends)[number]>();
    for (const s of sends) {
        if (!byPO.has(s.po_number)) byPO.set(s.po_number, s);
    }

    // ── 2. Fetch current lifecycle state for all candidate POs ──────
    const poNumbers = [...byPO.values()].map(s => s.po_number);
    const { data: lifecycleRows, error: lcErr } = await supabase
        .from("purchase_orders")
        .select("po_number, lifecycle_state, vendor_acknowledged_at")
        .in("po_number", poNumbers);

    const acknowledgedPOs = new Set<string>();
    if (lifecycleRows) {
        for (const row of lifecycleRows) {
            if (row.vendor_acknowledged_at) acknowledgedPOs.add(row.po_number);
            // Also skip if already ACKNOWLEDGED or beyond
            if (["ACKNOWLEDGED", "INVOICED", "RECONCILED", "RECEIVED", "COMPLETED"].includes(row.lifecycle_state)) {
                acknowledgedPOs.add(row.po_number);
            }
        }
    }

    // ── 3. Auth Gmail (default account — bill.selee@buildasoil.com) ──
    let gmail: any;
    try {
        const auth = await getAuthenticatedClient("default");
        gmail = GmailApi({ version: "v1", auth });
    } catch (err: any) {
        console.warn("[po-reply-watcher] Gmail auth failed:", err.message);
        return detections;
    }

    // ── 4. Check each thread ────────────────────────────────────────

    for (const send of [...byPO.values()]) {
        if (acknowledgedPOs.has(send.po_number)) continue;

        let threadId: string | null = send.gmail_thread_id ?? null;

        // Resolve threadId from the Gmail message if not stored (backfills older sends)
        if (!threadId) {
            try {
                const msg = await gmail.users.messages.get({
                    userId: "me",
                    id: send.gmail_message_id,
                    format: "minimal",
                });
                threadId = msg.data.threadId ?? null;
                if (threadId) {
                    // Persist for future runs
                    supabase
                        .from("po_sends")
                        .update({ gmail_thread_id: threadId })
                        .eq("po_number", send.po_number)
                        .eq("gmail_message_id", send.gmail_message_id)
                        .then(() => {}, () => {});
                }
            } catch (err: any) {
                console.warn(`[po-reply-watcher] Failed to resolve threadId for ${send.po_number}:`, err.message);
                continue;
            }
        }

        if (!threadId) continue;

        // Fetch the full thread
        let thread: any;
        try {
            const t = await gmail.users.threads.get({
                userId: "me",
                id: threadId,
                format: "full",
            });
            thread = t.data;
        } catch (err: any) {
            console.warn(`[po-reply-watcher] Failed to fetch thread ${threadId} for ${send.po_number}:`, err.message);
            continue;
        }

        if (!thread?.messages?.length) continue;

        // Parse PO sent time for comparison
        const sentTime = new Date(send.sent_at).getTime();
        const vendorDomain = vendorEmailDomain(send.sent_to_email);

        // Scan thread messages for vendor replies
        for (const msg of thread.messages) {
            // Skip unless message was sent AFTER the PO
            const msgTime = Number(msg.internalDate);
            if (isNaN(msgTime) || msgTime < sentTime) continue;

            // Extract From header
            const headers = msg.payload?.headers || [];
            const fromHeader = headers.find(
                (h: { name: string; value: string }) => h.name?.toLowerCase() === "from"
            );
            if (!fromHeader) continue;

            // Skip if from us
            if (isFromUs(fromHeader.value)) continue;

            // Check if from vendor domain
            const fromLower = fromHeader.value.toLowerCase();
            if (!fromLower.includes(vendorDomain)) continue;

            // Found a vendor reply!
            const snippet =
                (typeof msg.snippet === "string" ? msg.snippet.slice(0, 120) : "") ||
                "(no text preview)";

            const detection: VendorReplyDetection = {
                poNumber: send.po_number,
                vendorName: send.vendor_name,
                vendorEmail: send.sent_to_email,
                sentAt: send.sent_at,
                replySnippet: snippet,
                replyFrom: fromHeader.value,
                replyAt: new Date(msgTime).toISOString(),
                threadId,
                gmailMessageId: send.gmail_message_id,
            };

            detections.push(detection);

            // ── Update purchase_orders ──────────────────────────
            console.log(
                `[po-reply-watcher] DETECTED vendor reply for ${send.po_number}: "${snippet.slice(0, 80)}"`
            );

            // Extract reply body, tracking numbers, and ETA dates
            const replyBody = extractTextFromPayload(msg.payload);
            const foundTracking = extractTrackingNumbers(replyBody);
            const foundETA = extractETADate(replyBody);

            try {
                // Build update payload
                const updatePayload: Record<string, any> = {
                    lifecycle_stage: "ACKNOWLEDGED",
                    vendor_acknowledged_at: new Date(msgTime).toISOString(),
                    human_reply_detected_at: new Date(msgTime).toISOString(),
                    last_movement_summary: snippet,
                    updated_at: new Date().toISOString(),
                };

                // Merge tracking numbers if found
                if (foundTracking.length > 0) {
                    const { data: existingPO } = await supabase
                        .from("purchase_orders")
                        .select("tracking_numbers")
                        .eq("po_number", send.po_number)
                        .maybeSingle();

                    const existingTNs: string[] = existingPO?.tracking_numbers || [];
                    const merged = [...new Set([...existingTNs, ...foundTracking])];
                    updatePayload.tracking_numbers = merged;

                    console.log(
                        `[po-reply-watcher] Extracted ${foundTracking.length} tracking number(s) from vendor reply for ${send.po_number}: ${foundTracking.join(", ")}`
                    );

                    // Register each tracking number for carrier polling
                    for (const tn of foundTracking) {
                        try {
                            await upsertShipmentEvidence({
                                trackingNumber: tn,
                                statusCategory: "in_transit",
                                statusDisplay: "Vendor reply — awaiting carrier scan",
                                poNumbers: [send.po_number],
                                vendorNames: [send.vendor_name],
                                source: "po-reply-watcher",
                            } as any);
                        } catch (regErr: any) {
                            console.warn(`[po-reply-watcher] Shipment registration failed for ${tn}:`, regErr.message);
                        }
                    }
                }

                // Store vendor-stated ETA if found
                if (foundETA) {
                    updatePayload.vendor_stated_eta = foundETA;
                    updatePayload.vendor_stated_eta_confidence = "high";
                    console.log(
                        `[po-reply-watcher] Extracted ETA ${foundETA} from vendor reply for ${send.po_number}`
                    );

                    // Push ETA to Finale
                    try {
                        await syncPOETA(send.po_number, foundETA, "vendor-reply");
                    } catch (etaErr: any) {
                        console.warn(`[po-reply-watcher] ETA sync failed for ${send.po_number}:`, etaErr.message);
                    }
                }

                await supabase
                    .from("purchase_orders")
                    .update(updatePayload)
                    .eq("po_number", send.po_number);
            } catch (updErr: any) {
                console.warn(`[po-reply-watcher] Failed to update purchase_orders for ${send.po_number}:`, updErr.message);
            }

            // ── Insert lifecycle transition (deduped) ─────────
            try {
                // Check if ACKNOWLEDGED transition already exists for this PO
                const { data: existing } = await supabase
                    .from("po_lifecycle_transitions")
                    .select("id")
                    .eq("po_number", send.po_number)
                    .eq("to_state", "ACKNOWLEDGED")
                    .eq("triggered_by", "po-reply-watcher")
                    .maybeSingle();

                if (!existing) {
                    await supabase
                        .from("po_lifecycle_transitions")
                        .insert({
                            po_number: send.po_number,
                            from_state: "SENT",
                            to_state: "ACKNOWLEDGED",
                            transitioned_at: new Date().toISOString(),
                            triggered_by: "po-reply-watcher",
                            metadata: {
                                replyFrom: fromHeader.value,
                                replyAt: new Date(msgTime).toISOString(),
                                replySnippet: snippet,
                                threadId,
                                gmailMessageId: msg.id,
                                ...(foundTracking.length > 0 ? { trackingExtracted: foundTracking } : {}),
                            },
                        });
                }
            } catch (insErr: any) {
                console.warn(`[po-reply-watcher] Failed to insert lifecycle transition for ${send.po_number}:`, insErr.message);
            }

            // Also update local SQLite cache for crash-safe recovery
            try {
                const { getLocalDb } = await import("@/lib/storage/local-db");
                const db = getLocalDb();
                db.prepare(
                    `INSERT OR REPLACE INTO po_lifecycle_cache (po_number, lifecycle_state, last_transitioned_at, triggered_by)
                     VALUES (?, 'ACKNOWLEDGED', ?, 'po-reply-watcher')`
                ).run(send.po_number, new Date().toISOString());
            } catch (localErr: any) {
                // Best-effort — Supabase write already succeeded
            }

            // ── Push latest ETA to Finale (fire-and-forget) ─────
            try {
                const { syncPOETA } = await import("@/lib/purchasing/po-eta-sync");
                syncPOETA(send.po_number, null, "vendor-reply-detected").catch(() => {});
            } catch (_) {
                // ETA sync module not available — non-blocking
            }

            break; // One reply per thread is sufficient — stop scanning
        }
    }

    if (detections.length > 0) {
        const summary = detections
            .map(d => `  ${d.poNumber} — ${d.vendorName}: "${d.replySnippet.slice(0, 50)}"`)
            .join("\n");
        console.log(`[po-reply-watcher] ${detections.length} vendor reply(s) detected:\n${summary}`);
    }

    return detections;
}
