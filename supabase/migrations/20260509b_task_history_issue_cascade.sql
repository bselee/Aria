-- Migration: task_history.issue_id should ON DELETE CASCADE, not SET NULL
-- Created: 2026-05-09
-- Purpose: Original 20260509 set FK action to SET NULL. But task_history rows
--          can have task_id=NULL (issue-only events), so SET NULL on issue_id
--          would leave both NULL — violating the task_or_issue CHECK on the
--          implicit UPDATE postgres performs during cascade.
--
--          Issue-scoped events belong to their issue; when the issue is
--          deleted (rare — usually only via test/smoke cleanup), the events
--          should go with it. CASCADE is the right semantic.
--
-- Rollback:
--   ALTER TABLE task_history DROP CONSTRAINT task_history_issue_id_fkey;
--   ALTER TABLE task_history ADD CONSTRAINT task_history_issue_id_fkey
--     FOREIGN KEY (issue_id) REFERENCES agent_issue(id) ON DELETE SET NULL;

ALTER TABLE public.task_history
    DROP CONSTRAINT IF EXISTS task_history_issue_id_fkey;

ALTER TABLE public.task_history
    ADD CONSTRAINT task_history_issue_id_fkey
    FOREIGN KEY (issue_id) REFERENCES public.agent_issue(id) ON DELETE CASCADE;
