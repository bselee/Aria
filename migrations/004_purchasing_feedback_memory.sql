alter table if exists purchasing_automation_state
    add column if not exists feedback_memory jsonb not null default '{}'::jsonb;
