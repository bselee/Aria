-- Tracks when Aria sent a follow-up ETA request to a vendor.
-- NULL = follow-up not yet sent. Set to now() when email is dispatched.
-- Prevents duplicate pestering across syncPOConversations() runs (every 30 min).

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz NULL;

COMMENT ON COLUMN purchase_orders.follow_up_sent_at IS
    'When Aria sent a follow-up email requesting ETA. NULL = not yet sent.';
