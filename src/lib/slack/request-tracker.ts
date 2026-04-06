import { WebClient } from "@slack/web-api";
import { createClient } from "../supabase";

export interface SlackRequestRow {
    id: string;
    channel_id: string;
    channel_name: string;
    message_ts: string;
    thread_ts: string | null;
    requester_user_id: string;
    requester_name: string;
    original_text: string;
    items_requested: string[] | null;
    matched_skus: string[] | null;
    status: string;
    quantity: number | null;
    extracted_urls: string[] | null;
    completion_po_numbers: string[] | null;
    completed_at: string | null;
    completed_via: string | null;
    created_at: string;
    updated_at: string;
}

export interface RecentPurchaseOrder {
    po_number: string;
    status: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    issue_date?: string | null;
    line_items: Array<Record<string, unknown>> | null;
}

export interface SlackRequestCompletionMatch {
    requestId: string;
    poNumbers: string[];
    matchedSkus: string[];
}

export interface TrackedSlackRequestGroups {
    open: SlackRequestRow[];
    recentCompletedAuto: SlackRequestRow[];
    recentCompletedManual: SlackRequestRow[];
}

export interface TrackedSlackRequestInput {
    channel_id: string;
    channel_name: string;
    message_ts: string;
    thread_ts?: string | null;
    requester_user_id: string;
    requester_name: string;
    original_text: string;
    items_requested?: string[] | null;
    matched_skus?: string[] | null;
    quantity?: number | null;
    extracted_urls?: string[] | null;
}

export interface AutoCompletedSlackRequest {
    id: string;
    channel_id: string;
    message_ts: string;
    poNumbers: string[];
    matchedSkus: string[];
}

function normalizeSku(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.toUpperCase() : null;
}

function extractLineItemSkus(lineItems: Array<Record<string, unknown>> | null | undefined): Set<string> {
    const skus = new Set<string>();

    for (const item of lineItems ?? []) {
        const candidates = [
            item.sku,
            item.productId,
            item.product_id,
            item.itemId,
            item.item_id,
        ];

        for (const candidate of candidates) {
            const sku = normalizeSku(candidate);
            if (sku) skus.add(sku);
        }
    }

    return skus;
}

function resolvePOTimestamp(po: RecentPurchaseOrder): number {
    const source = po.updated_at ?? po.created_at ?? po.issue_date ?? null;
    return source ? new Date(source).getTime() : 0;
}

function isCommittedStatus(status: string | null | undefined): boolean {
    const normalized = String(status ?? "").toLowerCase();
    return normalized === "committed" || normalized === "completed";
}

export function findRecentCompletionMatches(input: {
    requests: SlackRequestRow[];
    purchaseOrders: RecentPurchaseOrder[];
    now?: string | Date;
    lookbackHours?: number;
}): SlackRequestCompletionMatch[] {
    const now = input.now ? new Date(input.now).getTime() : Date.now();
    const cutoff = now - (input.lookbackHours ?? 48) * 60 * 60 * 1000;
    const matches: SlackRequestCompletionMatch[] = [];

    for (const request of input.requests) {
        if (request.status !== "pending") continue;

        const wanted = [...new Set((request.matched_skus ?? [])
            .map((sku) => normalizeSku(sku))
            .filter(Boolean) as string[])];

        if (wanted.length === 0) continue;

        const poNumbers = new Set<string>();
        const matchedSkus = new Set<string>();

        for (const po of input.purchaseOrders) {
            if (!isCommittedStatus(po.status)) continue;
            if (resolvePOTimestamp(po) < cutoff) continue;

            const lineSkus = extractLineItemSkus(po.line_items);
            const overlap = wanted.filter((sku) => lineSkus.has(sku));
            if (overlap.length === 0) continue;

            poNumbers.add(po.po_number);
            overlap.forEach((sku) => matchedSkus.add(sku));
        }

        if (poNumbers.size > 0) {
            matches.push({
                requestId: request.id,
                poNumbers: [...poNumbers].sort(),
                matchedSkus: [...matchedSkus].sort(),
            });
        }
    }

    return matches;
}

export async function listTrackedSlackRequests(): Promise<TrackedSlackRequestGroups> {
    const db = createClient();
    if (!db) {
        return {
            open: [],
            recentCompletedAuto: [],
            recentCompletedManual: [],
        };
    }

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const [openRes, autoRes, manualRes] = await Promise.all([
        db.from("slack_requests").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(15),
        db.from("slack_requests").select("*").eq("status", "completed_auto").gte("completed_at", cutoff).order("completed_at", { ascending: false }).limit(10),
        db.from("slack_requests").select("*").eq("status", "completed_manual").gte("completed_at", cutoff).order("completed_at", { ascending: false }).limit(10),
    ]);

    return {
        open: (openRes.data ?? []) as SlackRequestRow[],
        recentCompletedAuto: (autoRes.data ?? []) as SlackRequestRow[],
        recentCompletedManual: (manualRes.data ?? []) as SlackRequestRow[],
    };
}

export async function completeTrackedSlackRequestManually(requestId: string): Promise<SlackRequestRow> {
    const db = createClient();
    if (!db) throw new Error("Supabase not configured.");

    const completedAt = new Date().toISOString();
    const { data, error } = await db
        .from("slack_requests")
        .update({
            status: "completed_manual",
            completed_at: completedAt,
            completed_via: "manual",
            updated_at: completedAt,
        })
        .eq("id", requestId)
        .select("*")
        .single();

    if (error || !data) {
        throw new Error(error?.message || `Request not found: ${requestId}`);
    }

    return data as SlackRequestRow;
}

export async function addSlackReaction(input: {
    channelId: string;
    messageTs: string;
    reaction: string;
}): Promise<void> {
    const token = process.env.SLACK_ACCESS_TOKEN;
    if (!token) return;

    const client = new WebClient(token);
    try {
        await client.reactions.add({
            channel: input.channelId,
            timestamp: input.messageTs,
            name: input.reaction,
        });
    } catch (err: any) {
        if (!String(err?.data?.error || err?.message || "").includes("already_reacted")) {
            throw err;
        }
    }
}

export async function upsertTrackedSlackRequest(input: TrackedSlackRequestInput): Promise<void> {
    const db = createClient();
    if (!db) return;

    const now = new Date().toISOString();

    await db.from("slack_requests").upsert({
        channel_id: input.channel_id,
        channel_name: input.channel_name,
        message_ts: input.message_ts,
        thread_ts: input.thread_ts ?? null,
        requester_user_id: input.requester_user_id,
        requester_name: input.requester_name,
        original_text: input.original_text,
        items_requested: input.items_requested ?? null,
        matched_skus: input.matched_skus ?? null,
        quantity: input.quantity ?? null,
        extracted_urls: input.extracted_urls ?? null,
        status: "pending",
        eyes_reacted_at: now,
        updated_at: now,
    }, { onConflict: "channel_id,message_ts" });
}

export async function autoCompleteTrackedSlackRequests(options?: {
    lookbackHours?: number;
}): Promise<AutoCompletedSlackRequest[]> {
    const db = createClient();
    if (!db) return [];

    const { data: requests, error: requestError } = await db
        .from("slack_requests")
        .select("*")
        .eq("status", "pending")
        .not("matched_skus", "is", null)
        .limit(100);

    if (requestError) {
        throw new Error(requestError.message);
    }

    const cutoff = new Date(Date.now() - (options?.lookbackHours ?? 48) * 60 * 60 * 1000).toISOString();

    const { data: purchaseOrders, error: poError } = await db
        .from("purchase_orders")
        .select("po_number,status,created_at,updated_at,issue_date,line_items")
        .in("status", ["committed", "completed"])
        .gte("updated_at", cutoff)
        .limit(200);

    if (poError) {
        throw new Error(poError.message);
    }

    const matches = findRecentCompletionMatches({
        requests: (requests ?? []) as SlackRequestRow[],
        purchaseOrders: (purchaseOrders ?? []) as RecentPurchaseOrder[],
        lookbackHours: options?.lookbackHours ?? 48,
    });

    const completedAt = new Date().toISOString();
    const completed: AutoCompletedSlackRequest[] = [];

    for (const match of matches) {
        const request = (requests ?? []).find((row: any) => row.id === match.requestId) as SlackRequestRow | undefined;
        if (!request) continue;

        const { error } = await db
            .from("slack_requests")
            .update({
                status: "completed_auto",
                completed_at: completedAt,
                completed_via: "auto",
                completion_po_numbers: match.poNumbers,
                matched_skus: match.matchedSkus,
                updated_at: completedAt,
            })
            .eq("id", match.requestId)
            .eq("status", "pending");

        if (error) {
            throw new Error(error.message);
        }

        completed.push({
            id: request.id,
            channel_id: request.channel_id,
            message_ts: request.message_ts,
            poNumbers: match.poNumbers,
            matchedSkus: match.matchedSkus,
        });
    }

    return completed;
}
