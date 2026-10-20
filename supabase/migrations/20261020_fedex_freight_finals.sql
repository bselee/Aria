-- fedex_freight_finals: durable ledger of FedEx Freight FINAL invoice amounts,
-- gleaned from the "New Invoices Available" notice email body (account /
-- invoice number / amount triple) at arrival. Capturing the triple at arrival
-- means the final amount survives the ~6-week mailbox retention window, so a
-- multi-PO freight split can always re-derive its targets from this table
-- instead of waiting on a Billtrust CSV export.
--
-- Only the three necessary fields are stored (plus the audit timestamps and a
-- dedup key). Vendor/PO/ship-date are resolved later by joining invoice_number
-- (= freight bill number = PRO) against LTL Select / the mailbox PDF / Billtrust.
CREATE TABLE IF NOT EXISTS fedex_freight_finals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number  TEXT NOT NULL,
    invoice_number  TEXT NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (account, invoice) — a notice may list the same invoice only once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fedex_freight_finals_acct_inv
    ON fedex_freight_finals (account_number, invoice_number);

CREATE INDEX IF NOT EXISTS idx_fff_invoice
    ON fedex_freight_finals (invoice_number);

-- Rollback:
-- DROP TABLE IF EXISTS fedex_freight_finals;
