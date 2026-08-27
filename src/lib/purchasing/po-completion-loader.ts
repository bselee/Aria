export interface APActivityRow {
    intent: string;
    created_at: string;
    metadata: Record<string, any> | null;
}

export interface POCompletionSignal {
    hasMatchedInvoice: boolean;
    reconciliationVerdict: string | null;
    freightResolved: boolean;
    allFeesResolved: boolean;   // freight + tax + tariff + shipping + labor
    unresolvedBlockers: string[];
    lastActivityAt: string | null;
}

const RESOLVED_CHANGE_VERDICTS = new Set(["auto_approve", "no_change", "duplicate"]);
// Fee types the reconciler can apply to a Finale PO. A fee change with a
// non-resolved verdict keeps the PO out of "complete" regardless of pattern —
// the safety rule "never complete until freight/tax/fees are applied".
const GATED_FEE_TYPES = new Set(["FREIGHT", "SHIPPING", "TAX", "TARIFF", "LABOR", "DISCOUNT_20"]);

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

    // Any fee type (freight/tax/tariff/shipping/labor/discount) with an
    // unresolved verdict is a blocker. Previously only FREIGHT was gated —
    // a PO could reach "complete" with tax/tariff still pending approval.
    const gatedFees = feeChanges.filter((change: any) => {
        const type = `${change?.type || change?.feeType || ""}`.toUpperCase();
        return GATED_FEE_TYPES.has(type);
    });
    const feesResolved = gatedFees.length === 0 ||
        gatedFees.every((change: any) => RESOLVED_CHANGE_VERDICTS.has((change?.verdict || "").toLowerCase()));
    if (!feesResolved) unresolvedBlockers.push("fee_review");

    // Keep the legacy freight-specific field for backward callers.
    const freightChanges = gatedFees.filter((change: any) =>
        `${change?.type || change?.feeType || ""}`.toUpperCase() === "FREIGHT");
    const freightResolved = freightChanges.length === 0 ||
        freightChanges.every((change: any) => RESOLVED_CHANGE_VERDICTS.has((change?.verdict || "").toLowerCase()));

    return {
        hasMatchedInvoice: row.intent === "RECONCILIATION" && !!metadata.orderId,
        reconciliationVerdict: verdict,
        freightResolved,
        allFeesResolved: feesResolved,
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
    client: any | null | undefined,
    poNumbers: string[],
    lookbackDays = 120
): Promise<Map<string, POCompletionSignal>> {
    if (!client || poNumbers.length === 0) return new Map();

    try {
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);

        const { data, error } = await client
            .from("ap_activity_log")
            .select("intent, created_at, metadata")
            .in("intent", ["RECONCILIATION", "RECONCILIATION_ERROR"])
            .gte("created_at", cutoff.toISOString())
            .order("created_at", { ascending: false })
            .limit(1000);

        if (error) {
            console.warn("[po-completion] load failed:", error.message || error);
            return new Map();
        }

        return buildPOCompletionSignalIndex((data || []) as APActivityRow[], poNumbers);
    } catch (e: any) {
        console.warn("[po-completion] load failed:", e?.message || e);
        return new Map();
    }
}
