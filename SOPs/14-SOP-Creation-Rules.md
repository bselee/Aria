# 14 — SOP Creation Rules

**Domain:** SOP Database Governance  
**Owner:** Hermia  
**Last Updated:** 2026-06-15  
**Purpose:** Standardize how all future SOPs are authored and maintained.

## Required Structure (Every SOP)
1. **Title** — Clear, numbered (e.g., `01 — AP Invoicing Pipeline`)
2. **Domain** — One primary area (AP, Slack, Purchasing, etc.)
3. **Owner** — Profile or person responsible
4. **Last Updated** — Date stamp
5. **Supersedes** (if applicable) — Link to old process
6. **Core Content** — Decision trees, rules, CLI/commands, technical details
7. **Kaizen Notes** — Improvements, open items, last review date
8. **Related Skills** — Cross-links to `SKILL.md` files

## Content Rules
- Use short paragraphs and bullet points
- Include exact commands, paths, and config keys
- Explicitly note superseded processes
- Add examples where decision logic is complex
- Keep voice consistent with Bill style where comms-related (no emojis, ≤25w where applicable)

## Update Rules
- Every task completion triggers Kaizen review of affected SOPs
- Update `Last Updated` date
- Append changes to Kaizen section
- Link new SOPs from `00-Index.md`

## Creation Triggers
- New recurring process discovered
- Existing process changes (supersedes note required)
- Profile or skill update that affects workflow
- Quarterly review (minimum)

## Maintenance
- Central Kaizen log lives in this vault (`11-Kaizen-Process.md`)
- All profiles reference this rules file when creating SOPs
- Heavy SOPs may be converted to dedicated skills (task 7)

---
**Status:** Rules established. All future SOPs must follow this template.