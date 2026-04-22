# Generic Agent Remediation Design

**Date:** 2026-04-21
**Status:** Approved

## Goal

Stabilize the broken GenericAgent-inspired installation in Aria by removing schema drift, aligning the dashboard and runtime to the existing ops control plane, and adding only the narrow learning features that have immediate operational value.

## Scope

This remediation includes two phases delivered together:

1. **Phase A: Infrastructure stabilization**
   - Use one heartbeat schema and status model everywhere.
   - Replace fake recovery with real recovery hooks and control-plane requests.
   - Wire runtime heartbeats into actual scheduled pipelines rather than only `ops-manager`.
   - Persist task history reliably.
   - Align dashboard queries and runtime code to the real schema.

2. **Phase B: Narrow GenericAgent-inspired value**
   - Persist pending skills against the actual `skills` table schema.
   - Track invocation counts, success counts, and confidence.
   - Add shadow-mode execution records for approved-but-untrusted skills.

This remediation explicitly does **not** attempt full semantic skill routing, full L0-L4 memory replacement, or broad autonomous self-evolution across all subsystems.

## Design

### 1. Heartbeat and Control Plane

Aria already has an operational control plane built around `agent_heartbeats`, `ops_control_requests`, and `ops_health_summary`. That existing path becomes the source of truth.

The remediation will standardize on:

- `agent_heartbeats.heartbeat_at`
- lowercase status values: `healthy`, `degraded`, `starting`, `stopped`
- `metadata` as the extensible payload container

The newer uppercase heartbeat model (`last_heartbeat_at`, `current_task`, `metrics`) will be removed from runtime usage. Current task and metrics will move into `metadata.currentTask` and `metadata.metrics`.

### 2. OversightAgent

`OversightAgent` will stop pretending a timestamp rewrite is recovery.

It will become a light coordinator with:

- heartbeat registration against the unified schema
- per-agent recovery registrations
- real retry callbacks for in-process recoverable agents
- optional control-plane commands for restart-like recovery
- optional reset hooks for clearing local state
- escalation only after real recovery attempts fail

Because Aria already has a watchdog/control-plane path, process-level restart requests should flow through `ops_control_requests` rather than shelling out to `pm2` or `curl`.

### 3. Runtime Wiring

The current install only records heartbeats for `ops-manager`. That is not enough.

This remediation will wire logical heartbeat updates into the real scheduled work:

- `ops-manager`
- default inbox pipeline
- AP pipeline
- nightshift loop entrypoint

The heartbeats are for logical agents/pipelines, not a claim that these are separate OS processes.

### 4. Task History

`task_history` is the durable substrate for later skill learning and operator review. It must not depend on Pinecone availability.

The remediation will make task-history persistence reliable by:

- recording scheduled task runs directly and/or through a helper that always attempts the Supabase write
- treating Pinecone archival as best-effort sidecar behavior, not the gate for audit persistence

### 5. Skills

The `skills` runtime will be aligned to the actual table schema:

- `name`
- `description`
- `trigger`
- `steps`
- `confidence`
- `times_invoked`
- `times_succeeded`
- `review_status`
- `archived`

The current incompatible runtime shape (`task_type`, `input_summary`, `output_summary`, `execution_trace`) will be removed from the skill persistence API.

### 6. Shadow Mode

Shadow mode is valuable here because Aria touches financial workflows.

The implementation will keep shadow mode narrow:

- approved skills can be executed in shadow mode
- shadow runs record to `task_history`
- shadow runs do not mutate external systems
- confidence changes only when the caller explicitly reports real outcomes

This preserves the GenericAgent-inspired safety benefit without expanding scope into autonomous skill routing.

## Approaches Considered

### Option 1: Rebuild around the newer oversight schema

Pros:
- matches the recent design docs more literally

Cons:
- conflicts with the existing ops control plane
- would require rewriting views, DB helpers, dashboard, and watchdog assumptions
- adds more migration risk than value

### Option 2: Standardize on the existing ops control plane and adapt oversight to it

Pros:
- smallest stable change
- preserves working health-summary and control-request machinery
- reduces schema drift immediately

Cons:
- requires translating the newer conceptual model into the older storage shape

### Option 3: Remove oversight/skills entirely for now

Pros:
- lowest short-term code risk

Cons:
- throws away useful work
- loses the chance to add durable task-history and skill-review primitives

## Recommendation

Use **Option 2**.

Keep the working ops control plane, adapt the broken install to it, and add only the narrow GenericAgent-inspired pieces that create immediate value:

- stable heartbeats
- real recovery hooks
- reliable task history
- pending skills
- counters and confidence
- shadow-mode records

## Testing Strategy

The remediation will be test-first and focused on behavior:

- oversight heartbeat writes use the unified schema
- recovery attempts call real registered hooks and fall through correctly
- task-history persistence succeeds even when Pinecone is unavailable
- skill persistence uses the actual `skills` schema
- dashboard data mapping expects the unified heartbeat shape
- runtime wiring records more than one logical agent heartbeat

## Non-Goals

- semantic skill retrieval via Pinecone
- automatic skill routing across the system
- full replacement of existing `memory.ts` and `vendor-memory.ts`
- generalized agent self-modification
