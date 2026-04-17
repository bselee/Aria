# Oversight & Skill Crystallization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add autonomous oversight, self-healing, and skill crystallization to Aria

**Architecture:** Three new components (OversightAgent, SkillCrystallizer, MemoryLayerManager) wrap existing agents via Supabase queues, cron hooks, and shared interfaces. Existing code untouched.

**Tech Stack:** TypeScript, Supabase, Pinecone, SQLite (local-db.ts)

---

## Database Migrations

### Task 1: Create agent_heartbeats table

**Files:**
- Create: `supabase/migrations/20260417_create_agent_heartbeats.sql`

**Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL UNIQUE,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN')),
  current_task TEXT,
  metrics JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_status ON agent_heartbeats(status);
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_name ON agent_heartbeats(agent_name);
```

**Step 2: Run migration**

```bash
node _run_migration.js supabase/migrations/20260417_create_agent_heartbeats.sql
```

---

### Task 2: Create skills table

**Files:**
- Create: `supabase/migrations/20260417_create_skills.sql`

**Step 1: Write migration**

```sql
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
```

---

### Task 3: Create task_history table

**Files:**
- Create: `supabase/migrations/20260417_create_task_history.sql`

**Step 1: Write migration**

```sql
CREATE TABLE IF NOT EXISTS task_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'shadow')),
  skill_id UUID REFERENCES skills(id),
  execution_trace JSONB DEFAULT '[]',
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_history_agent_name ON task_history(agent_name);
CREATE INDEX IF NOT EXISTS idx_task_history_status ON task_history(status);
CREATE INDEX IF NOT EXISTS idx_task_history_created_at ON task_history(created_at DESC);
```

---

## OversightAgent

### Task 4: Create OversightAgent skeleton

**Files:**
- Create: `src/lib/intelligence/oversight-agent.ts`

**Step 1: Write types and class**

```typescript
export type AgentStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface AgentHeartbeat {
  id: string;
  agent_name: string;
  last_heartbeat_at: Date;
  status: AgentStatus;
  current_task: string | null;
  metrics: Record<string, unknown>;
  updated_at: Date;
}

export interface RecoveryAction {
  action: 'retry' | 'restart_process' | 'reset_state' | 'escalate';
  description: string;
  success: boolean;
}

export class OversightAgent {
  private checkInterval: number;
  private heartbeatTimeout: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  
  constructor(checkIntervalMs = 5 * 60 * 1000, heartbeatTimeoutMs = 15 * 60 * 1000) {
    this.checkInterval = checkIntervalMs;
    this.heartbeatTimeout = heartbeatTimeoutMs;
  }
  
  async registerHeartbeat(agentName: string, currentTask?: string, metrics?: Record<string, unknown>): Promise<void>;
  async checkAllHeartbeats(): Promise<void>;
  async handleDownAgent(agentName: string): Promise<RecoveryAction[]>;
  async start(): void;
  async stop(): void;
}
```

---

### Task 5: Implement heartbeat registration

**Files:**
- Modify: `src/lib/intelligence/oversight-agent.ts`

**Step 1: Write heartbeat registration**

```typescript
async registerHeartbeat(agentName: string, currentTask?: string, metrics?: Record<string, unknown>): Promise<void> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  
  await supabase.from('agent_heartbeats').upsert({
    agent_name: agentName,
    last_heartbeat_at: now,
    status: 'HEALTHY',
    current_task: currentTask ?? null,
    metrics: metrics ?? {},
  }, {
    onConflict: 'agent_name',
  });
}
```

---

### Task 6: Implement heartbeat check and self-healing

**Files:**
- Modify: `src/lib/intelligence/oversight-agent.ts`

**Step 1: Write heartbeat check**

```typescript
async checkAllHeartbeats(): Promise<void> {
  const supabase = getSupabase();
  const { data: heartbeats } = await supabase.from('agent_heartbeats').select('*');
  
  if (!heartbeats) return;
  
  const now = new Date();
  
  for (const hb of heartbeats) {
    const elapsed = now.getTime() - new Date(hb.last_heartbeat_at).getTime();
    
    if (elapsed > this.heartbeatTimeout && hb.status !== 'DOWN') {
      await this.updateStatus(hb.agent_name, 'DOWN');
      await this.handleDownAgent(hb.agent_name);
    } else if (elapsed > this.heartbeatTimeout / 2 && hb.status === 'HEALTHY') {
      await this.updateStatus(hb.agent_name, 'DEGRADED');
    }
  }
}
```

**Step 2: Write self-healing logic**

```typescript
async handleDownAgent(agentName: string): Promise<RecoveryAction[]> {
  const actions: RecoveryAction[] = [];
  
  // Attempt 1: Retry via safeRun re-invocation
  const retry = await this.attemptRetry(agentName);
  actions.push(retry);
  if (retry.success) return actions;
  
  // Attempt 2: Restart child process (for reconcilers)
  const restart = await this.restartProcess(agentName);
  actions.push(restart);
  if (restart.success) return actions;
  
  // Attempt 3: Reset state
  const reset = await this.resetState(agentName);
  actions.push(reset);
  if (reset.success) return actions;
  
  // Escalate
  await this.escalate(agentName, actions);
  return actions;
}
```

---

## SkillCrystallizer

### Task 7: Create SkillCrystallizer

**Files:**
- Create: `src/lib/intelligence/skill-crystallizer.ts`

**Step 1: Write types and class**

```typescript
export interface SkillStep {
  order: number;
  action: 'tool_call' | 'llm_call' | 'db_query' | 'api_call' | 'wait' | 'decision';
  name: string;
  params: Record<string, unknown>;
  result_pattern?: string;
  error_pattern?: string;
}

export interface CrystallizeRequest {
  agentName: string;
  taskType: string;
  inputSummary: string;
  outputSummary: string;
  executionTrace: SkillStep[];
}

export class SkillCrystallizer {
  async crystallize(request: CrystallizeRequest): Promise<string>;
  async getPendingSkills(): Promise<Skill[]>;
  async approveSkill(skillId: string): Promise<void>;
  async rejectSkill(skillId: string, feedback: string): Promise<void>;
  async findMatchingSkill(trigger: string): Promise<Skill | null>;
}
```

---

### Task 8: Implement skill matching

**Files:**
- Modify: `src/lib/intelligence/skill-crystallizer.ts`

**Step 1: Write skill matching**

```typescript
async findMatchingSkill(trigger: string): Promise<Skill | null> {
  const supabase = getSupabase();
  
  // Get approved skills, ordered by confidence desc
  const { data: skills } = await supabase
    .from('skills')
    .select('*')
    .eq('review_status', 'approved')
    .eq('archived', false)
    .order('confidence', { ascending: false })
    .limit(10);
  
  if (!skills || skills.length === 0) return null;
  
  // Simple keyword matching on trigger
  const triggerWords = trigger.toLowerCase().split(/\s+/);
  let bestMatch: Skill | null = null;
  let bestScore = 0;
  
  for (const skill of skills) {
    const skillWords = skill.trigger.toLowerCase().split(/\s+/);
    const overlap = triggerWords.filter(w => skillWords.includes(w)).length;
    const score = overlap / Math.max(triggerWords.length, skillWords.length);
    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = skill;
    }
  }
  
  return bestMatch;
}
```

---

## MemoryLayerManager

### Task 9: Create MemoryLayerManager

**Files:**
- Create: `src/lib/intelligence/memory-layer-manager.ts`

**Step 1: Write layer interface**

```typescript
export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface MemoryRecord {
  layer: MemoryLayer;
  category: string;
  key: string;
  data: unknown;
  ttlSeconds?: number;
  createdAt: Date;
}

export class MemoryLayerManager {
  // L0: Meta Rules
  async loadMetaRules(): Promise<MetaRule[]>;
  
  // L1: Insight Index
  async index(key: string, metadata: Record<string, unknown>): Promise<void>;
  async search(query: string, limit?: number): Promise<SearchResult[]>;
  
  // L2: Global Facts
  async remember(category: string, data: unknown, ttlSeconds?: number): Promise<void>;
  async recall(category: string, query: string): Promise<MemoryRecord[]>;
  
  // L4: Session Archive
  async archiveSession(sessionId: string, summary: SessionSummary): Promise<void>;
  async loadRecentSessions(limit?: number): Promise<SessionSummary[]>;
}
```

---

## Integration

### Task 10: Wire OversightAgent into OpsManager

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`

**Step 1: Add heartbeat to safeRun**

```typescript
// In safeRun(), after successful execution:
await this.oversightAgent?.registerHeartbeat(this.agentName, null, { lastSuccess: new Date() });

// On error:
await this.oversightAgent?.registerHeartbeat(this.agentName, null, { lastError: String(error) });
```

---

## Dashboard

### Task 11: Create oversight panel

**Files:**
- Create: `src/components/dashboard/OversightPanel.tsx`

**Step 1: Write basic panel**

```typescript
export function OversightPanel() {
  const [agents, setAgents] = useState<AgentHeartbeat[]>([]);
  const [pendingSkills, setPendingSkills] = useState<Skill[]>([]);
  
  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    fetchData();
    return () => clearInterval(interval);
  }, []);
  
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Agent Status</h2>
      <AgentStatusGrid agents={agents} />
      <h2 className="text-lg font-semibold">Pending Skills</h2>
      <PendingSkillsReview skills={pendingSkills} />
    </div>
  );
}
```

---

## Implementation Order

1. Tasks 1-3: Database migrations
2. Tasks 4-6: OversightAgent
3. Tasks 7-8: SkillCrystallizer
4. Task 9: MemoryLayerManager
5. Task 10: Integration into OpsManager
6. Task 11: Dashboard panel
