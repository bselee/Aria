-- Core documents table
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    -- DocumentType enum
    status TEXT DEFAULT 'UNPROCESSED',
    source TEXT NOT NULL,
    -- email | upload | github
    source_ref TEXT,
    -- email message ID, file path, etc.
    vendor_id UUID REFERENCES vendors(id),
    extracted_data JSONB,
    raw_text TEXT,
    pdf_path TEXT,
    -- Supabase Storage path
    confidence TEXT,
    action_required BOOLEAN DEFAULT true,
    action_summary TEXT,
    linked_documents TEXT [],
    -- Related document IDs
    email_from TEXT,
    email_subject TEXT,
    email_date TEXT,
    github_issue_number INTEGER,
    github_issue_url TEXT,
    github_issue_state TEXT,
    github_last_synced TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
-- Vendors master table
CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    normalized_name TEXT,
    aliases TEXT [],
    website TEXT,
    payment_portal_url TEXT,
    remit_to_address TEXT,
    account_number TEXT,
    payment_terms TEXT,
    preferred_payment_method TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    ar_email TEXT,
    tax_id TEXT,
    category TEXT,
    notes TEXT,
    total_spend DECIMAL(12, 2) DEFAULT 0,
    document_count INTEGER DEFAULT 0,
    average_payment_days INTEGER,
    last_order_date DATE,
    last_enriched_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Invoices
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number TEXT UNIQUE,
    vendor_id UUID REFERENCES vendors(id),
    vendor_name TEXT,
    po_number TEXT,
    invoice_date DATE,
    due_date DATE,
    payment_terms TEXT,
    subtotal DECIMAL(10, 2),
    freight DECIMAL(10, 2),
    tax DECIMAL(10, 2),
    total DECIMAL(10, 2),
    amount_due DECIMAL(10, 2),
    status TEXT DEFAULT 'unmatched',
    matched_po_id UUID REFERENCES purchase_orders(id),
    discrepancies JSONB DEFAULT '[]',
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    document_id UUID REFERENCES documents(id),
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Purchase Orders
CREATE TABLE purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number TEXT UNIQUE NOT NULL,
    vendor_id UUID REFERENCES vendors(id),
    vendor_name TEXT,
    issue_date DATE,
    required_date DATE,
    ship_via TEXT,
    payment_terms TEXT,
    subtotal DECIMAL(10, 2),
    freight DECIMAL(10, 2),
    tax DECIMAL(10, 2),
    total DECIMAL(10, 2),
    status TEXT DEFAULT 'open',
    line_items JSONB,
    document_id UUID REFERENCES documents(id),
    raw_data JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Statement reconciliations
CREATE TABLE statement_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID REFERENCES vendors(id),
    vendor_name TEXT,
    statement_date DATE,
    vendor_balance DECIMAL(10, 2),
    our_balance DECIMAL(10, 2),
    discrepancy_amount DECIMAL(10, 2),
    discrepancy_count INTEGER DEFAULT 0,
    lines JSONB,
    status TEXT DEFAULT 'PENDING',
    document_id UUID REFERENCES documents(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Shipments
CREATE TABLE shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracking_number TEXT NOT NULL,
    carrier_slug TEXT,
    carrier_name TEXT,
    pro_number TEXT,
    bol_number TEXT,
    status TEXT,
    status_detail TEXT,
    vendor_id UUID REFERENCES vendors(id),
    po_numbers TEXT [],
    invoice_numbers TEXT [],
    origin TEXT,
    destination TEXT,
    ship_date DATE,
    estimated_delivery DATE,
    actual_delivery DATE,
    last_location TEXT,
    raw_events JSONB,
    document_id UUID REFERENCES documents(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Gmail accounts
CREATE TABLE gmail_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE gmail_tokens (
    account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expiry_date BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Indexes
CREATE INDEX documents_type_idx ON documents(type);
CREATE INDEX documents_vendor_idx ON documents(vendor_id);
CREATE INDEX documents_action_idx ON documents(action_required)
WHERE action_required = true;
CREATE INDEX documents_status_idx ON documents(status);
CREATE INDEX invoices_vendor_idx ON invoices(vendor_id);
CREATE INDEX invoices_status_idx ON invoices(status);
CREATE INDEX invoices_due_date_idx ON invoices(due_date);
CREATE INDEX shipments_status_idx ON shipments(status);
CREATE INDEX shipments_tracking_idx ON shipments(tracking_number);
-- Full-text search
CREATE INDEX documents_fts_idx ON documents USING gin(
    to_tsvector(
        'english',
        coalesce(raw_text, '') || ' ' || coalesce(action_summary, '')
    )
);
CREATE INDEX vendors_fts_idx ON vendors USING gin(
    to_tsvector(
        'english',
        name || ' ' || coalesce(array_to_string(aliases, ' '), '')
    )
);