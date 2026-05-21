import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { loadActivePurchases } from "@/lib/purchasing/active-purchases";
import { loadDraftedPORecSummaries } from "@/lib/purchasing/calibration";
import { createClient } from "@/lib/supabase";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
    try {
        const finale = new FinaleClient();
        const activePos = await loadActivePurchases(finale, 60);

        // Phase C — attach rec backreferences (recommended vs drafted qty per SKU).
        // Best-effort: a Supabase miss returns the active POs without rec links.
        const recsByPO = await loadDraftedPORecSummaries(activePos.map(p => p.orderId));
        const enriched = activePos.map(po => ({
            ...po,
            recLinks: recsByPO.get(po.orderId) ?? [],
        }));

        return NextResponse.json({
            purchases: enriched,
            cachedAt: new Date().toISOString(),
        });

    } catch (err: any) {
        console.error("Active purchases API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const action = String(body.action || "").trim();

        if (!action) {
            return NextResponse.json({ error: "action is required" }, { status: 400 });
        }

        const orderId = String(body.orderId || "").trim();
        if (!orderId) {
            return NextResponse.json({ error: "orderId required" }, { status: 400 });
        }

        const db = createClient();
        if (!db) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        const now = new Date().toISOString();

        // Action 1: Mark Sent Verified
        if (action === "mark_sent_verified") {
            const evidence = {
                type: "manual",
                at: now,
                detail: "Marked sent verified from Active Purchases",
                by: "dashboard",
            };

            const { error } = await db.from("purchase_orders").upsert({
                po_number: orderId,
                po_sent_verified_at: now,
                po_sent_verified_source: "manual",
                po_sent_verified_evidence: [evidence],
                lifecycle_stage: "sent",
                updated_at: now,
            }, { onConflict: "po_number" });

            if (error) throw error;

            return NextResponse.json({
                ok: true,
                orderId,
                sentVerification: {
                    verified: true,
                    sentAt: now,
                    source: "manual",
                    evidence: [evidence],
                },
            });
        }

        // Action 2: Toggle Tracking Paused
        if (action === "toggle_tracking_paused") {
            // Get current status
            const { data: poData } = await db
                .from("purchase_orders")
                .select("tracking_paused")
                .eq("po_number", orderId)
                .maybeSingle();

            const nextPaused = !(poData?.tracking_paused || false);

            const { error } = await db.from("purchase_orders").upsert({
                po_number: orderId,
                tracking_paused: nextPaused,
                updated_at: now,
            }, { onConflict: "po_number" });

            if (error) throw error;

            return NextResponse.json({
                ok: true,
                orderId,
                trackingPaused: nextPaused,
            });
        }

        // Action 3: Add Tracking Number manually (with search tracking source pattern)
        if (action === "add_tracking_number") {
            const trackingNumber = String(body.trackingNumber || "").trim();
            const trackingSource = String(body.trackingSource || "").trim();
            const vendorName = String(body.vendorName || "").trim();

            if (!trackingNumber) {
                return NextResponse.json({ error: "trackingNumber required" }, { status: 400 });
            }

            // Get current tracking numbers
            const { data: poData } = await db
                .from("purchase_orders")
                .select("tracking_numbers")
                .eq("po_number", orderId)
                .maybeSingle();

            let trackingList: string[] = poData?.tracking_numbers || [];
            if (!trackingList.includes(trackingNumber)) {
                trackingList = [...trackingList, trackingNumber];
            }

            const upsertPayload: any = {
                po_number: orderId,
                tracking_numbers: trackingList,
                lifecycle_stage: "moving_with_tracking",
                updated_at: now,
            };

            if (trackingSource) {
                upsertPayload.tracking_source = trackingSource;
            }

            const { error: updateErr } = await db
                .from("purchase_orders")
                .upsert(upsertPayload, { onConflict: "po_number" });

            if (updateErr) throw updateErr;

            // Also learn the pattern: save typical_tracking_source in vendor_profiles
            if (vendorName && trackingSource) {
                try {
                    await db
                        .from("vendor_profiles")
                        .update({
                            typical_tracking_source: trackingSource,
                            updated_at: now,
                        })
                        .ilike("vendor_name", vendorName);
                } catch (vErr) {
                    console.warn("Failed to update typical_tracking_source for vendor:", vErr);
                }
            }

            return NextResponse.json({
                ok: true,
                orderId,
                trackingNumbers: trackingList,
                trackingSource: trackingSource || null,
            });
        }

        // Action 4: Send Dogged Follow-Up Email
        if (action === "send_follow_up_email") {
            const recipientEmail = String(body.recipientEmail || "").trim();
            const emailBody = String(body.emailBody || "").trim();

            if (!recipientEmail) {
                return NextResponse.json({ error: "recipientEmail required" }, { status: 400 });
            }
            if (!emailBody) {
                return NextResponse.json({ error: "emailBody required" }, { status: 400 });
            }

            // Fetch PO email details to thread it if possible
            const { data: poDetails } = await db
                .from("purchase_orders")
                .select("po_email_message_id")
                .eq("po_number", orderId)
                .maybeSingle();

            const poMessageId = poDetails?.po_email_message_id;

            // Initialize Gmail
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });

            // Try to resolve Gmail thread ID
            let threadId: string | undefined;
            if (poMessageId) {
                try {
                    const q = `rfc822msgid:${poMessageId}`;
                    const listRes = await gmail.users.messages.list({ userId: "me", q });
                    if (listRes.data.messages && listRes.data.messages.length > 0) {
                        threadId = listRes.data.messages[0].threadId;
                    }
                } catch (gErr) {
                    console.warn("Failed to find Gmail thread for message ID:", poMessageId, gErr);
                }
            }

            const subject = poMessageId ? `Re: Purchase Order ${orderId}` : `Purchase Order ${orderId} Follow-up: Tracking Details Required`;

            // Build raw RFC 2822 message
            const lines = [
                `From: bill.selee@buildasoil.com`,
                `To: ${recipientEmail}`,
                `Subject: ${subject}`,
                `MIME-Version: 1.0`,
                `Content-Type: text/plain; charset=UTF-8`,
            ];
            if (poMessageId) {
                lines.push(`In-Reply-To: ${poMessageId}`);
                lines.push(`References: ${poMessageId}`);
            }
            lines.push("", emailBody);
            const rawEmail = lines.join("\r\n");

            const requestBody: any = {
                raw: Buffer.from(rawEmail).toString("base64url"),
            };
            if (threadId) {
                requestBody.threadId = threadId;
            }

            const sendRes = await gmail.users.messages.send({
                userId: "me",
                requestBody,
            });

            // Update database tracking request state
            await db
                .from("purchase_orders")
                .upsert({
                    po_number: orderId,
                    tracking_requested_at: now,
                    lifecycle_stage: "ap_follow_up",
                    updated_at: now,
                }, { onConflict: "po_number" });

            // Create activity log entry
            try {
                await db.from("ap_activity_log").insert({
                    intent: "PO_FOLLOW_UP_SENT",
                    po_number: orderId,
                    metadata: {
                        recipient: recipientEmail,
                        subject,
                        gmail_message_id: sendRes.data.id,
                        gmail_thread_id: sendRes.data.threadId,
                        by: "dashboard",
                    },
                    created_at: now,
                });
            } catch (actErr) {
                console.warn("Failed to log activity:", actErr);
            }

            return NextResponse.json({
                ok: true,
                orderId,
                messageId: sendRes.data.id,
                threadId: sendRes.data.threadId,
            });
        }

        return NextResponse.json({ error: "unhandled action" }, { status: 400 });

    } catch (err: any) {
        console.error("Active purchases POST API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
