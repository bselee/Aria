-- Migration: create_ap_activity_log
-- Purpose: Track decisions and actions taken by the AP Agent on all emails.
CREATE TABLE IF NOT EXISTS public.ap_activity_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    email_from text NOT NULL,
    email_subject text NOT NULL,
    intent text NOT NULL,
    -- INVOICE, STATEMENT, ADVERTISEMENT, HUMAN_INTERACTION
    action_taken text NOT NULL,
    -- "Forwarded to Bill.com", "Archived", "Labeled as Statement", "Ignored"
    notified_slack boolean DEFAULT false,
    metadata jsonb -- Any extra data, e.g., the PDF filename or anomalies
);
-- Enable RLS
ALTER TABLE public.ap_activity_log ENABLE ROW LEVEL SECURITY;
-- Allow all operations for authenticated/service role (we only ever access this from the server)
CREATE POLICY "Enable all operations for service role" ON public.ap_activity_log USING (true) WITH CHECK (true);