---
description: Mandatory vendor invoice archive integration — every new vendor reconciler or intake process MUST archive invoices to vendor_invoices
---

# Vendor Invoice Archive Integration

Every new script, reconciler, or intake process that touches vendor invoices **MUST** call `upsertVendorInvoice()` from `src/lib/storage/vendor-invoices.ts` to archive the invoice into the unified `vendor_invoices` Supabase table.

This is **non-negotiable**. If it processes invoices, it feeds the archive.

## Required Steps

### 1. Import the helper
```ts
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';
```

### 2. Call `upsertVendorInvoice()` after processing
```ts
await upsertVendorInvoice({
    vendor_name: 'Vendor Name',           // REQUIRED — normalized vendor name
    invoice_number: inv.invoiceNumber,     // REQUIRED — dedup key with vendor_name
    invoice_date: '2026-03-17',            // ISO date string or null
    due_date: null,                        // ISO date string or null
    po_number: matchedPoId || null,        // Finale PO if matched
    subtotal: inv.subtotal,                // Numbers, not strings
    freight: inv.shipping,
    tax: inv.tax,
    total: inv.total,
    status: 'received',                    // 'received' | 'reconciled' | 'paid' | 'disputed' | 'void'
    source: 'portal_scrape',              // SEE SOURCE VALUES BELOW
    source_ref: `script-name-run-id`,     // Trace back to the specific run
    line_items: inv.items.map(i => ({     // Optional but preferred
        sku: i.sku,
        description: i.description,
        qty: i.quantity,
        unit_price: i.unitPrice,
        ext_price: i.extendedPrice,
    })),
    raw_data: inv as unknown as Record<string, unknown>,  // Full payload for audit
});
```

### 3. Valid `source` values
| Source              | Use when                                      |
|---------------------|-----------------------------------------------|
| `email_attachment`  | Invoice came via email (AP agent, Gmail watch) |
| `portal_scrape`     | Scraped from vendor portal (ULINE, Axiom)     |
| `csv_import`        | Parsed from CSV file (FedEx billing)           |
| `sandbox_drop`      | Dropped into Sandbox folder manually           |
| `payment_confirm`   | Payment confirmation email                     |
| `manual`            | Hand-entered or imported manually              |

### 4. Error handling
Wrap in try/catch — dedup collisions are expected and harmless:
```ts
try {
    await upsertVendorInvoice({ ... });
} catch { /* dedup collision or non-critical failure */ }
```

## Currently Wired Intake Channels

| File                        | Vendor(s)      | Source             |
|-----------------------------|----------------|--------------------|
| `ap-agent.ts`               | All email      | `email_attachment` |
| `attachment-handler.ts`     | All email      | `email_attachment` |
| `reconcile-uline.ts`        | ULINE          | `portal_scrape`    |
| `reconcile-fedex.ts`        | FedEx          | `csv_import`       |
| `reconcile-teraganix.ts`    | TeraGanix      | `email_attachment` |
| `reconcile-axiom.ts`        | Axiom Print    | `portal_scrape`    |

## Checklist for New Vendor Scripts

- [ ] Import `upsertVendorInvoice`
- [ ] Call it after invoice data is extracted/parsed
- [ ] Use correct `source` value from table above
- [ ] Include `source_ref` for traceability
- [ ] Include `line_items` if available
- [ ] Include `raw_data` for full audit trail
- [ ] Add entry to the table above in this workflow doc
