-- Migration: Add gmail_thread_id to po_sends
-- Purpose: Store the Gmail thread ID when a PO is emailed, so the
--          po-reply-watcher can check for vendor replies in the same thread.
--          Also backfills from existing gmail_message_id where possible.
-- Author:  Hermia
-- Created: 2026-06-18

ALTER TABLE public.po_sends
ADD COLUMN IF NOT EXISTS gmail_thread_id text;
