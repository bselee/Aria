export type StatementSourceType = "email_statement" | "download_statement";
export type StatementArtifactKind = "pdf" | "csv" | "none";
export type StatementIntakeStatus =
    | "ready"
    | "processing"
    | "reconciled"
    | "needs_review"
    | "error"
    | "ignored";
export type StatementRunStatus =
    | "queued"
    | "processing"
    | "completed"
    | "needs_review"
    | "error";

export interface StatementIntakeRecord {
    id: string;
    vendorName: string;
    sourceType: StatementSourceType;
    sourceRef: string;
    artifactPath: string | null;
    artifactKind: StatementArtifactKind;
    statementDate: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    status: StatementIntakeStatus;
    adapterKey: string;
    fingerprint: string;
    rawMetadata: Record<string, unknown>;
    discoveredAt: string;
    queuedBy: string;
    lastError: string | null;
}

export type NormalizedStatementDocumentType =
    | "invoice"
    | "payment"
    | "credit"
    | "adjustment"
    | "debit_memo";

export interface NormalizedStatementLine {
    referenceNumber: string;
    documentType: NormalizedStatementDocumentType;
    date: string;
    amount: number;
    balance: number;
    poNumber?: string | null;
    trackingNumber?: string | null;
    notes?: string | null;
}

export interface NormalizedStatement {
    vendorName: string;
    statementDate: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    accountNumber?: string | null;
    totals: {
        openingBalance?: number | null;
        totalCharges?: number | null;
        totalCredits?: number | null;
        endingBalance?: number | null;
    };
    lines: NormalizedStatementLine[];
    sourceMeta: {
        adapterKey: string;
        sourceRef: string;
        artifactPath?: string | null;
        [key: string]: unknown;
    };
}

export type StatementLineStatus =
    | "verified"
    | "missing"
    | "amount_mismatch"
    | "duplicate_candidate"
    | "needs_review";

export interface StatementReconciliationLineResult {
    referenceNumber: string;
    status: StatementLineStatus;
    amount: number;
    matchedInvoiceIds: string[];
    matchedInvoiceNumbers: string[];
    matchedPoNumbers: string[];
    vendorAmount: number;
    ourAmount: number | null;
    delta: number | null;
    notes: string[];
}

export interface StatementReconciliationRunSummary {
    matchedCount: number;
    missingCount: number;
    mismatchCount: number;
    duplicateCount: number;
    needsReviewCount: number;
    confidence: "high" | "medium" | "low";
}

export interface StatementReconciliationRunRecord {
    id: string;
    intakeId: string;
    vendorName: string;
    adapterKey: string;
    runStatus: StatementRunStatus;
    triggerSource: string;
    startedAt: string | null;
    finishedAt: string | null;
    summary: StatementReconciliationRunSummary;
    normalizedStatement: NormalizedStatement | null;
    results: StatementReconciliationLineResult[] | null;
    matchedCount: number;
    missingCount: number;
    mismatchCount: number;
    duplicateCount: number;
    needsReviewCount: number;
    lastError: string | null;
    createdAt: string;
}

export interface ArchivedVendorInvoice {
    id: string;
    vendor_name: string;
    invoice_number: string | null;
    invoice_date: string | null;
    po_number: string | null;
    total: number | null;
}
