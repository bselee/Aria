ALTER TABLE public.ap_activity_log
ADD COLUMN IF NOT EXISTS notified_slack boolean DEFAULT false;