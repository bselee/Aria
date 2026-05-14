export type ProcessState = "new" | "opened" | "waiting_on_vendor" | "handled" | "learned";

export type ActivityLog = {
    id: string;
    created_at: string;
    email_from: string | null;
    email_subject: string | null;
    intent: string;
    action_taken: string;
    metadata: any;
    reviewed_at: string | null;
    reviewed_action: string | null;
    human_note?: string | null;
    human_note_by?: string | null;
    human_note_at?: string | null;
    process_state?: ProcessState | null;
    resolution?: string | null;
    learning_candidate?: boolean | null;
};

export type CronRun = {
    id: string;
    job_name: string;
    started_at: string;
    finished_at: string | null;
    status: string | null;
    failure_reason: string | null;
};

export type StreamRow =
    | { kind: "ap"; row: ActivityLog }
    | { kind: "cron"; row: CronRun };

export type ActivityLink = {
    label: string;
    href: string;
};

export type CorrelationExplanation = {
    title: string;
    confidence: string;
    positiveSignals: string[];
    negativeSignals: string[];
};

export function extractEmail(from: string | null | undefined): string | null {
    if (!from) return null;
    const angle = from.match(/<([^>]+)>/);
    const candidate = angle ? angle[1] : from;
    const email = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return email ? email[0] : null;
}

export function getActivityIntentLabel(intent: string | null | undefined): string {
    const normalized = (intent ?? "").toUpperCase();
    if (normalized === "HUMAN_INTERACTION" || normalized === "HUMAN_INTERACT" || normalized === "EYES_NEEDED") {
        return "EYES_NEEDED";
    }
    return normalized;
}

export function getDefaultProcessState(row: StreamRow): ProcessState | null {
    if (row.kind === "cron") return null;
    if (row.row.process_state) return row.row.process_state;
    return getAttentionRank(row) === null ? null : "new";
}

export function getAttentionRank(row: StreamRow): number | null {
    if (row.kind === "cron") {
        return row.row.status === "failed" || row.row.status === "error" ? 5 : null;
    }

    const log = row.row;
    if (log.process_state === "handled" || log.process_state === "learned") return null;

    const label = getActivityIntentLabel(log.intent);
    const action = (log.action_taken ?? "").toLowerCase();

    if (label.includes("ERROR") || label.includes("FAIL")) return 10;
    if (label === "EYES_NEEDED" || label === "PREPAYMENT") return 20;
    if (
        label === "RECONCILIATION"
        && (
            action.includes("approval")
            || action.includes("review")
            || action.includes("flagged")
            || action.includes("pending")
            || log.reviewed_action === "paused"
        )
    ) {
        return 30;
    }

    return null;
}

export function isAttentionRow(row: StreamRow): boolean {
    return getAttentionRank(row) !== null;
}

export function getNextHumanAction(row: StreamRow): string | null {
    if (row.kind === "cron") {
        if (row.row.status === "failed" || row.row.status === "error") {
            return `next: inspect ${row.row.job_name} failure`;
        }
        return null;
    }

    if (!isAttentionRow(row)) return null;

    const log = row.row;
    const label = getActivityIntentLabel(log.intent);
    const email = extractEmail(log.email_from);

    if (label === "EYES_NEEDED") {
        return `next: review/reply to email${email ? ` from ${email}` : ""}`;
    }
    if (label === "RECONCILIATION") {
        const invoice = log.metadata?.invoiceNumber ?? log.metadata?.invoice_number;
        return `next: review reconciliation${invoice ? ` for invoice ${invoice}` : ""}`;
    }
    if (label === "PREPAYMENT") {
        return `next: review payment request${email ? ` from ${email}` : ""}`;
    }
    return "next: investigate";
}

export function getActivityLink(row: StreamRow): ActivityLink | null {
    if (row.kind === "cron") return null;

    const log = row.row;
    const label = getActivityIntentLabel(log.intent);
    const email = extractEmail(log.email_from);
    const subject = log.email_subject?.trim();

    if (label === "EYES_NEEDED" && (email || subject)) {
        const terms = [email ? `from:${email}` : null, subject].filter(Boolean).join(" ");
        return {
            label: "open email",
            href: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(terms)}`,
        };
    }

    const orderId = log.metadata?.orderId ?? log.metadata?.poNumber;
    if (orderId) {
        const accountPath = process.env.NEXT_PUBLIC_FINALE_ACCOUNT_PATH || "buildasoilorganics";
        const encoded = btoa(`/${accountPath}/api/order/${orderId}`);
        return {
            label: `PO ${orderId}`,
            href: `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encoded}`,
        };
    }

    return null;
}

export function getCorrelationExplanation(row: StreamRow): CorrelationExplanation | null {
    if (row.kind !== "ap") return null;
    const log = row.row;
    if (getActivityIntentLabel(log.intent) !== "RECONCILIATION") return null;

    const metadata = log.metadata ?? {};
    const invoice = metadata.invoiceNumber ?? metadata.invoice_number ?? "unknown invoice";
    const orderId = metadata.orderId ?? metadata.poNumber ?? "unknown PO";
    const positiveSignals: string[] = [];
    const negativeSignals: string[] = [];

    if (metadata.vendorName) positiveSignals.push(`vendor matched ${metadata.vendorName}`);
    if (metadata.orderId || metadata.poNumber) positiveSignals.push(`invoice linked to PO ${orderId}`);

    const changes = [
        ...(Array.isArray(metadata.priceChanges) ? metadata.priceChanges : []),
        ...(Array.isArray(metadata.feeChanges) ? metadata.feeChanges : []),
    ];
    const autoApproved = changes.filter((change: any) => change?.verdict === "auto_approve").length;
    const needsReview = changes.filter((change: any) => {
        const verdict = String(change?.verdict ?? "");
        return verdict.includes("review") || verdict.includes("approval") || verdict === "rejected";
    }).length;

    if (autoApproved > 0) positiveSignals.push(`${autoApproved} line/fee signal${autoApproved === 1 ? "" : "s"} auto-approved`);
    if (needsReview > 0) negativeSignals.push(`${needsReview} line/fee signal${needsReview === 1 ? "" : "s"} need review`);

    const impact = Number(metadata.totalDollarImpact ?? metadata.totalImpact ?? metadata.dollarImpact ?? 0);
    if (impact !== 0) negativeSignals.push(`$${Math.abs(impact).toFixed(2)} total impact`);

    return {
        title: `Invoice ${invoice} -> PO ${orderId}`,
        confidence: String(metadata.confidence ?? metadata.matchConfidence ?? "unknown"),
        positiveSignals,
        negativeSignals,
    };
}

export function getTeachPayload(row: StreamRow): Record<string, unknown> | null {
    if (row.kind !== "ap") return null;
    const log = row.row;
    const metadata = log.metadata ?? {};

    return {
        event: "activity_human_correction",
        activityLogId: log.id,
        intent: getActivityIntentLabel(log.intent),
        vendor: metadata.vendorName ?? extractEmail(log.email_from) ?? null,
        invoiceNumber: metadata.invoiceNumber ?? metadata.invoice_number ?? null,
        suggestedPo: metadata.orderId ?? metadata.poNumber ?? null,
        subject: log.email_subject,
        humanNote: log.human_note ?? null,
        resolution: log.resolution ?? null,
    };
}
