import type { InvoiceData } from "@/lib/pdf/invoice-parser";
import type { POData } from "@/lib/pdf/po-parser";
import type { StatementData } from "@/lib/pdf/statement-parser";
import type { BillOfLadingData } from "@/lib/pdf/bol-parser";

export type DocumentType =
    | "INVOICE"
    | "PURCHASE_ORDER"
    | "VENDOR_STATEMENT"
    | "BILL_OF_LADING"
    | "PACKING_SLIP"
    | "FREIGHT_QUOTE"
    | "REMITTANCE_ADVICE"
    | "CREDIT_MEMO"
    | "CONTRACT"
    | "PRODUCT_SPEC"
    | "SDS"                    // Safety Data Sheet (critical for BuildASoil)
    | "COA"                    // Certificate of Analysis
    | "TRACKING_NOTIFICATION"
    | "UNKNOWN";

export type DocumentStatus =
    | "UNPROCESSED"
    | "EXTRACTED"
    | "MATCHED"               // Invoice matched to PO
    | "DISCREPANCY"           // Matched but amounts differ
    | "APPROVED"
    | "PAID"
    | "DISPUTED"
    | "ARCHIVED";

export interface ProcessedDocument {
    id: string;
    type: DocumentType;
    status: DocumentStatus;
    source: "email" | "upload" | "github" | "crawl";
    sourceRef: string;        // email message ID, file path, GitHub URL, etc.
    vendorId?: string;
    extractedData: InvoiceData | POData | StatementData | BillOfLadingData | unknown;
    rawText: string;
    pdfPath?: string;         // Local/Supabase Storage path
    confidence: "high" | "medium" | "low";
    actionRequired: boolean;
    actionSummary?: string;
    linkedDocuments: string[]; // Other doc IDs this relates to (invoice ↔ PO ↔ BOL)
    createdAt: string;
    processedAt: string;
}
