# 13 — Memory & SOP Database Management

**Domain:** Persistent Context  
**Owner:** Hermia  
**Last Updated:** 2026-06-15

## Current Setup
- Built-in provider (always active)
- Explicit MEMORY.md + USER.md per profile (filesystem-backed)
- Durable facts only (no stale data >7 days)
- SOP vault as structured knowledge layer on top
- Simple, transparent, zero-dependency

## Honcho Evaluation (Task 2 — Completed)

### What Honcho Offers
- **Honcho** (plurality.ai) is an open-source memory layer for LLM agents
- Semantic/vector search over past conversations and facts
- Temporal awareness (recency weighting, decay functions)
- Episodic + semantic memory types (hierarchical)
- User-level memory isolation; SQLite or pgvector backends
- API server model with session management

### Comparison: Built-in vs. Honcho

| Criterion | Built-in (Current) | Honcho |
|-----------|--------------------|--------|
| Setup complexity | None (files) | Requires server process + DB dependency |
| Recall fidelity | Explicit facts only | Semantic search over all history |
| Scalability (1 user, 1 org) | ✅ Sufficient | Over-engineered |
| Scalability (multi-user, multi-org) | ❌ Would need rework | ✅ Built-in |
| Temporal awareness | Manual (facts tag dates) | Automatic decay + recency scoring |
| Transparency | Plain text, instantly verifiable | Vector DB, less inspectable |
| Reliability | Filesystem (always works) | Requires Honcho service uptime |
| Maintenance burden | Zero | Dependency updates, DB migrations, service health |

### Decision: **Stay with Built-in Provider**

**Rationale:**
1. **Current scale doesn't justify Honcho.** Single user, single organization, well-structured SOP vault. The builtin's explicit MEMORY.md + USER.md files are transparent, auditable, and require zero infrastructure.
2. **The SOP vault already provides the structured RAG layer.** Honcho's primary advantage (semantic search) is largely redundant when every SOP is a well-organized Markdown file with clear headings and indexed in `00-Index.md`.
3. **Simplicity wins.** Honcho introduces a server process, database, API surface, and ongoing maintenance for marginal benefit at the current operational scale.

### When to Revisit
Switch to Honcho (or equivalent) if any of these scaling issues appear:
1. **Multi-user memory isolation required** — different users need independent, queryable conversation histories.
2. **Cross-session fact retrieval becomes a bottleneck** — the explicit MEMORY.md pattern grows unwieldy beyond ~50 facts.
3. **Conversation-level recall needed** — needing to answer "what did we discuss about vendor X three weeks ago?" via semantic search.
4. **Multiple Hermes profiles share memory** — profiles need to query each other's persistent state dynamically.

## Improvement Path (Remaining Tasks)
- [x] Evaluate Honcho (Task 2 — see above)
- [x] Proactive memory tool calls (Task 3 — new rule below)
- [ ] Central Kaizen log (this vault)
- [ ] Profile MEMORY.md sync
- [ ] RAG over SOPs
- [ ] Skill-ify heavy SOPs

## Task 3 — Proactive Memory Tool Rule (Completed)
**New Standing Rule:**  
Whenever a new durable fact is discovered during any task (pipeline detail, voice rule, superseded process, config key, etc.), immediately call the `memory` tool to persist it. Do not rely on conversation context alone.

This ensures the injected MEMORY section stays current without user reminders.

---
**Status:** Tasks 2 and 3 complete. Built-in provider retained. Proactive memory rule now active.