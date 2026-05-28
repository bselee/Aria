/**
 * @file    src/lib/intelligence/ap/types.ts
 * @purpose Shared types for the AP pipeline modules.
 * @author  Will / Antigravity / Hermia
 * @created 2026-05-28
 * @deps    zod
 * @extracted-from src/lib/intelligence/ap-agent.ts
 */

import { z } from 'zod';

// ─── Email Classification ───────────────────────────────────────────────────

export const EMAIL_CLASSIFICATION = z.enum([
    'INVOICE', 'STATEMENT', 'ADVERTISEMENT', 'HUMAN_INTERACTION',
]);
export type EmailClassification = z.infer<typeof EMAIL_CLASSIFICATION>;

// ─── Invoice Source ─────────────────────────────────────────────────────────

export const INVOICE_SOURCE = z.enum([
    'email_attachment', 'portal_scrape', 'csv_import',
    'sandbox_drop', 'payment_confirm', 'manual',
    'email_dropship',
]);
export type InvoiceSource = z.infer<typeof INVOICE_SOURCE>;

// ─── Reconciliation Identity ────────────────────────────────────────────────

export interface ReconciliationIdentity {
    orderId: string;
    invoiceNumber: string;
    vendorName: string;
    matchStrategy: 'po_number' | 'vendor_date' | 'fuzzy_sku';
    confidence: 'high' | 'medium' | 'low';
}

// ─── OCR Retry Decision ─────────────────────────────────────────────────────

export interface OCRRetryDecision {
    shouldRetry: boolean;
    reasons: string[];
    parseScore: number;
    hasCoreSignals: boolean;
}
