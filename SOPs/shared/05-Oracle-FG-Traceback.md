# 05 — Oracle FG-Trace-Back Logic

**Domain:** Inventory Ordering tied to Finished Goods  
**Owner:** aria-purchasing  
**Last Updated:** 2026-06-15

## Rule
- Components are only ordered when feeding Finished Goods (FGs) with <42 days runway.
- Implemented in `build-risk.ts` (Step 2.5 + Step 6)

**Related Skill:** `oracle-fg-traceback`

---
**Status:** Core rule captured. Needs example traces.