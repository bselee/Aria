CREATE TABLE sys_chat_logs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  source      text NOT NULL CHECK (source IN ('telegram', 'slack')),
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  metadata    jsonb
);

CREATE INDEX idx_sys_chat_logs_created_at ON sys_chat_logs (created_at DESC);

ALTER TABLE sys_chat_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON sys_chat_logs
  USING (true) WITH CHECK (true);

COMMENT ON TABLE sys_chat_logs IS 'Live mirror of Telegram bot conversations and Slack watchdog detections for the dashboard.';
