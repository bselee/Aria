import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { loadActivePurchases } from "@/lib/purchasing/active-purchases";
import { loadDraftedPORecSummaries } from "@/lib/purchasing/calibration";
import { createClient } from "@/lib/db";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { syncPOETA } from "@/lib/purchasing/po-eta-sync";

export const dynamic = "force-dynamic";

function headerValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string | undefined {
    return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function canUseStoredMessageIdWithGmailApi(value: string): boolean {
    return Boolean(value) && !value.startsWith("/") && !value.includes("://");
}

function replySubject(orderId: string, originalSubject?: string, hasThread = false): string {
    const normalized = originalSubject?.replace(/^(re:\s*)+/i, "").trim();
    if (normalized) return `Re: ${normalized}`;
    return hasThread
        ? `Re: Purchase Order ${orderId}`
        : `Purchase Order ${orderId} Follow-up: Tracking Details Required`;
}

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

            // Transition lifecycle state machine
            try {
                const { transitionLifecycleState } = await import("@/lib/purchasing/po-lifecycle");
                await transitionLifecycleState(orderId, "SENT", "dashboard-active-purchases", {
                    source: "manual",
                    verifiedAt: now,
                });
            } catch (tlErr: any) {
                console.warn(`[active-purchases] Lifecycle transition failed for ${orderId}:`, tlErr.message);
            }

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

            const poMessageId = typeof poDetails?.po_email_message_id === "string"
                ? poDetails.po_email_message_id.trim()
                : "";

            // Initialize Gmail
            const auth = await getAuthenticatedClient("default");
            const gmail = GmailApi({ version: "v1", auth });

            // Try to resolve Gmail thread ID. Gmail fallback stores the Gmail API
            // message id, not the RFC822 Message-ID header, so resolve that first
            // and only use RFC822 search as a fallback.
            let threadId: string | undefined;
            let replyReferenceMessageId: string | undefined;
            let originalSubject: string | undefined;
            if (poMessageId && canUseStoredMessageIdWithGmailApi(poMessageId)) {
                try {
                    const getRes = await gmail.users.messages.get({
                        userId: "me",
                        id: poMessageId,
                        format: "metadata",
                        metadataHeaders: ["Message-ID", "Subject"],
                    });
                    threadId = getRes.data.threadId ?? undefined;
                    replyReferenceMessageId = headerValue(getRes.data.payload?.headers, "Message-ID");
                    originalSubject = headerValue(getRes.data.payload?.headers, "Subject");
                } catch {
                    try {
                        const q = `rfc822msgid:${poMessageId}`;
                        const listRes = await gmail.users.messages.list({ userId: "me", q });
                        if (listRes.data.messages && listRes.data.messages.length > 0) {
                            const foundMessage = listRes.data.messages[0];
                            threadId = foundMessage.threadId;
                            replyReferenceMessageId = poMessageId;
                            if (foundMessage.id) {
                                const getRes = await gmail.users.messages.get({
                                    userId: "me",
                                    id: foundMessage.id,
                                    format: "metadata",
                                    metadataHeaders: ["Subject"],
                                });
                                originalSubject = headerValue(getRes.data.payload?.headers, "Subject");
                            }
                        }
                    } catch (searchErr) {
                        console.warn("Failed to find Gmail thread for message ID:", poMessageId, searchErr);
                    }
                }
            }

            if (!threadId) {
                try {
                    const listRes = await gmail.users.messages.list({
                        userId: "me",
                        q: `subject:${orderId} newer_than:365d`,
                        maxResults: 1,
                    });
                    const foundMessage = listRes.data.messages?.[0];
                    if (foundMessage?.id) {
                        const getRes = await gmail.users.messages.get({
                            userId: "me",
                            id: foundMessage.id,
                            format: "metadata",
                            metadataHeaders: ["Message-ID", "Subject"],
                        });
                        threadId = getRes.data.threadId ?? foundMessage.threadId ?? undefined;
                        replyReferenceMessageId = headerValue(getRes.data.payload?.headers, "Message-ID");
                        originalSubject = headerValue(getRes.data.payload?.headers, "Subject");
                    }
                } catch (subjectSearchErr) {
                    console.warn("Failed to find Gmail thread by PO subject:", orderId, subjectSearchErr);
                }
            }

            const subject = replySubject(orderId, originalSubject, Boolean(threadId || replyReferenceMessageId));

            // Build raw RFC 2822 message
            const lines = [
                `From: bill.selee@buildasoil.com`,
                `To: ${recipientEmail}`,
                `Subject: ${subject}`,
                `MIME-Version: 1.0`,
                `Content-Type: text/plain; charset=UTF-8`,
            ];
            if (replyReferenceMessageId) {
                lines.push(`In-Reply-To: ${replyReferenceMessageId}`);
                lines.push(`References: ${replyReferenceMessageId}`);
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

        // Action 5: Set ETA (update expected delivery date)
        console.log("[active-purchases POST] action:", action, "checking set_eta");
        if (action === "set_eta") {
            const etaDate = String(body.etaDate || "").trim();
            if (!etaDate || !/^\d{4}-\d{2}-\d{2}$/.test(etaDate)) {
                return NextResponse.json({ error: "etaDate required (YYYY-MM-DD)" }, { status: 400 });
            }

            // Push to Finale directly using already-imported FinaleClient
            try {
                const finale = new FinaleClient();
                await finale.updateOrderDueDate(orderId, etaDate);
            } catch (e: any) {
                console.warn("[set_eta] Finale dueDate push failed:", e.message);
            }

            // Also store in purchase_orders as vendor_stated_eta override
            const { error: upsertErr } = await db.from("purchase_orders").upsert({
                po_number: orderId,
                vendor_stated_eta: etaDate,
                vendor_stated_eta_confidence: "high",
                vendor_stated_eta_extracted_at: now,
                vendor_stated_eta_rationale: "Manually set from dashboard",
                updated_at: now,
            }, { onConflict: "po_number" });

            if (upsertErr) throw upsertErr;

            return NextResponse.json({
                ok: true,
                orderId,
                etaProfile: {
                    expectedDate: etaDate,
                    source: "vendor_reply_eta",
                    confidence: "high",
                    label: `ETA ${etaDate} - manual`,
                },
            });
        }

        // Action 6: Approve Reconciliation
        if (action === "approve_reconciliation") {
            const invoiceId = String(body.invoiceId || "").trim();

            // 1. Apply reconciliation to Finale — this is the actual work
            //    Load the reconciliation result from ap_pending_approvals
            const { data: approval } = await db
                .from("ap_pending_approvals")
                .select("reconciliation_result, invoice_number, order_id")
                .eq("order_id", orderId)
                .eq("status", "pending")
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (approval?.reconciliation_result) {
                try {
                    const { applyReconciliation } = await import("@/lib/finale/reconciler");
                    const { FinaleClient } = await import("@/lib/finale/client");
                    const finale = new FinaleClient();
                    const result = approval.reconciliation_result as any;
                    const applyResult = await applyReconciliation(result, finale);
                    console.log(`[approve_reconciliation] Applied to Finale: ${applyResult.applied.length} changes for ${orderId}`);
                } catch (err: any) {
                    console.error(`[approve_reconciliation] Finale apply failed for ${orderId}:`, err.message);
                    // Continue — still mark as approved in DB even if Finale fails
                }
            }

            // 2. Update ap_pending_approvals status
            await db
                .from("ap_pending_approvals")
                .update({ status: "approved", updated_at: now })
                .eq("order_id", orderId)
                .eq("status", "pending");

            // 3. Update invoices table: status = 'matched_approved' where po_number = orderId
            const { error: invErr } = await db
                .from("invoices")
                .update({ status: "matched_approved", updated_at: now })
                .eq("po_number", orderId);

            if (invErr) throw invErr;

            // 4. Update purchase_orders: lifecycle_stage = 'reconciled'
            const { error: poErr } = await db
                .from("purchase_orders")
                .upsert({
                    po_number: orderId,
                    lifecycle_stage: "reconciled",
                    updated_at: now,
                }, { onConflict: "po_number" });

            if (poErr) throw poErr;

            return NextResponse.json({ ok: true, orderId, applied: !!approval?.reconciliation_result });
        }

        // Action 7b: Resend PO Email — re-sends the PO to the vendor via Gmail
        if (action === "resend_po_email") {
            // Fetch PO details from Finale to get vendor email
            const finale = new FinaleClient();
            let vendorEmail = "";

            // Try to get vendor email from purchase_orders or vendor_profiles
            try {
                const { data: poData } = await db
                    .from("purchase_orders")
                    .select("vendor_email, vendor_name, po_sent_to_email")
                    .eq("po_number", orderId)
                    .maybeSingle();

                vendorEmail = poData?.po_sent_to_email || poData?.vendor_email || "";

                // If no email on the PO, look up from vendor_profiles
                if (!vendorEmail && poData?.vendor_name) {
                    const { data: vp } = await db
                        .from("vendor_profiles")
                        .select("orders_email")
                        .ilike("vendor_name", `%${poData.vendor_name.split(/\s+/).find((w: string) => w.length > 3) || poData.vendor_name}%`)
                        .maybeSingle();
                    vendorEmail = vp?.orders_email || "";
                }
            } catch (e) {
                console.warn("[resend_po_email] Could not look up vendor email:", e);
            }

            if (!vendorEmail) {
                return NextResponse.json({ error: "No vendor email found for this PO" }, { status: 400 });
            }

            let gmailResult: any = null;
            try {
                const { sendGmailPdfEmail } = await import("@/lib/gmail/send-email");
                const { renderPurchaseOrderPdf } = await import("@/lib/purchasing/po-email-pdf");

                // Fetch PO details to build the email
                const poDetails = await finale.getOrderDetails(orderId);
                const review = {
                    orderId,
                    vendorName: poDetails?.supplierName || poDetails?.vendorName || "",
                    orderDate: poDetails?.orderDate || "",
                    total: poDetails?.totalAmount || 0,
                    items: (poDetails?.orderItemList || []).map((item: any) => ({
                        productId: item.productId,
                        productName: item.internalName || item.description || "",
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                    })),
                    finaleUrl: poDetails?.orderUrl || "",
                    vendorPartyId: "",
                };

                const pdfBuffer = await renderPurchaseOrderPdf(review);

                const { subject, body } = await (async () => {
                    const { generatePOEmailBody } = await import("@/lib/purchasing/po-sender");
                    return generatePOEmailBody(review);
                })();

                gmailResult = await sendGmailPdfEmail({
                    to: vendorEmail,
                    cc: "bill.selee@buildasoil.com",
                    subject,
                    body,
                    pdfBuffer,
                    pdfFilename: `BuildASoil-PO-${orderId}.pdf`,
                });

                // Log the send
                await db.from("po_sends").insert({
                    po_number: orderId,
                    sent_at: now,
                    sent_to_email: vendorEmail,
                    triggered_by: "dashboard-resend",
                    gmail_message_id: gmailResult.messageId,
                    gmail_thread_id: gmailResult.threadId,
                    created_at: now,
                });

                // Update purchase_orders tracking
                await db.from("purchase_orders").upsert({
                    po_number: orderId,
                    po_sent_verified_at: now,
                    po_sent_verified_source: "dashboard-resend",
                    updated_at: now,
                }, { onConflict: "po_number" });

                // Transition lifecycle state
                try {
                    const { transitionLifecycleState } = await import("@/lib/purchasing/po-lifecycle");
                    await transitionLifecycleState(orderId, "SENT", "dashboard-resend", {
                        source: "resend_po_email",
                        resentAt: now,
                    });
                } catch (tlErr: any) {
                    console.warn(`[resend_po_email] Lifecycle transition failed:`, tlErr.message);
                }
            } catch (sendErr: any) {
                console.error("[resend_po_email] Failed to resend:", sendErr);
                return NextResponse.json({ error: `Failed to resend: ${sendErr.message}` }, { status: 500 });
            }

            return NextResponse.json({
                ok: true,
                orderId,
                sentTo: vendorEmail,
                gmailMessageId: gmailResult?.messageId || null,
            });
        }

        // Action 7: Close stale PO — mark lifecycle as closed_stale without cancelling in Finale
        if (action === "close_stale") {
            const { error: upErr } = await db.from("purchase_orders").upsert({
                po_number: orderId,
                lifecycle_stage: "closed_stale",
                updated_at: now,
            }, { onConflict: "po_number" });

            if (upErr) throw upErr;

            // Audit log entry for the change
            await db.from("ap_activity_log").insert({
                email_from: "dashboard",
                email_subject: `PO ${orderId} closed as stale`,
                intent: "PO_CLOSED_STALE",
                action_taken: `Manually closed stale PO ${orderId} — no vendor response after escalation. PO remains open in Finale.`,
                metadata: { orderId, closedAt: now, reason: body.reason || "stale" },
            });

            return NextResponse.json({ ok: true, orderId, lifecycle_stage: "closed_stale" });
        }

        return NextResponse.json({ error: "unhandled action" }, { status: 400 });

    } catch (err: any) {
        console.error("Active purchases POST API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
