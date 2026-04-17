CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]',
  confidence NUMERIC(5,4) DEFAULT 1.0,
  times_invoked INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto', 'manual')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  rejection_feedback TEXT,
  archived BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_skills_review_status ON skills(review_status) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_skills_agent_name ON skills(agent_name);
CREATE INDEX IF NOT EXISTS idx_skills_confidence ON skills(confidence) WHERE archived = FALSE;
