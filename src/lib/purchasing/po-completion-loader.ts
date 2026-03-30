import type { SupabaseClient } from "@supabase/supabase-js";

export interface APActivityRow {
    intent: string;
    created_at: string;
    metadata: Record<string, any> | null;
}

export interface POCompletionSignal {
    hasMatchedInvoice: boolean;
    reconciliationVerdict: string | null;
    freightResolved: boolean;
    unresolvedBlockers: string[];
    lastActivityAt: string | null;
}

const RESOLVED_CHANGE_VERDICTS = new Set(["auto_approve", "no_change", "duplicate"]);

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

export function summarizePOCompletionSignal(row: APActivityRow): POCompletionSignal {
    const metadata = row.metadata || {};
    const verdict = typeof metadata.verdict === "string"
        ? metadata.verdict.toLowerCase()
        : (metadata.status === "pending" ? "pending" : null);
    const feeChanges = Array.isArray(metadata.feeChanges) ? metadata.feeChanges : [];
    const priceChanges = Array.isArray(metadata.priceChanges) ? metadata.priceChanges : [];
    const errors = Array.isArray(metadata.errors) ? metadata.errors : [];

    const unresolvedBlockers: string[] = [];
    if (row.intent === "RECONCILIATION_ERROR") unresolvedBlockers.push("reconciliation_error");
    if (verdict === "needs_approval" || verdict === "pending") unresolvedBlockers.push("needs_approval");
    if (verdict === "rejected") unresolvedBlockers.push("rejected");
    if (verdict === "no_match") unresolvedBlockers.push("no_match");
    if (errors.length > 0) unresolvedBlockers.push("apply_error");
    if (priceChanges.some((change: any) => !RESOLVED_CHANGE_VERDICTS.has((change?.verdict || "").toLowerCase()))) {
        unresolvedBlockers.push("price_review");
    }

    const freightChanges = feeChanges.filter((change: any) => `${change?.type || change?.feeType || ""}`.toUpperCase() === "FREIGHT");
    const freightResolved = freightChanges.length === 0 ||
        freightChanges.every((change: any) => RESOLVED_CHANGE_VERDICTS.has((change?.verdict || "").toLowerCase()));
    if (!freightResolved) unresolvedBlockers.push("freight_review");

    return {
        hasMatchedInvoice: row.intent === "RECONCILIATION" && !!metadata.orderId,
        reconciliationVerdict: verdict,
        freightResolved,
        unresolvedBlockers: unique(unresolvedBlockers),
        lastActivityAt: row.created_at || null,
    };
}

export function buildPOCompletionSignalIndex(rows: APActivityRow[], poNumbers: string[]): Map<string, POCompletionSignal> {
    const wanted = new Set(poNumbers.filter(Boolean));
    const index = new Map<string, POCompletionSignal>();
    const sorted = rows
        .filter(row => wanted.has(`${row.metadata?.orderId || ""}`))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    for (const row of sorted) {
        const orderId = `${row.metadata?.orderId || ""}`;
        if (!orderId || index.has(orderId)) continue;
        index.set(orderId, summarizePOCompletionSignal(row));
    }

    return index;
}

export async function loadPOCompletionSignalIndex(
    supabase: SupabaseClient | null | undefined,
    poNumbers: string[],
    lookbackDays = 120
): Promise<Map<string, POCompletionSignal>> {
    if (!supabase || poNumbers.length === 0) return new Map();

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);

    const { data } = await supabase
        .from("ap_activity_log")
        .select("intent, created_at, metadata")
        .in("intent", ["RECONCILIATION", "RECONCILIATION_ERROR"])
        .gte("created_at", cutoff.toISOString())
        .order("created_at", { ascending: false })
        .limit(1000);

    return buildPOCompletionSignalIndex((data || []) as APActivityRow[], poNumbers);
}
