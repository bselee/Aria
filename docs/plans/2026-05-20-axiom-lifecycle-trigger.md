# Axiom Lifecycle Trigger Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start an Axiom workflow when a draft Axiom PO is created, using SKU templates as the gate before any website/order automation.

**Architecture:** Add database tables for approved Axiom order templates and PO lifecycle rows. Add a small lifecycle service that assesses draft PO SKUs, blocks duplicates, flags missing templates, and creates a dashboard task. Wire `FinaleClient.createDraftPurchaseOrder()` to call the service only when the vendor resolves to Axiom Print.

**Tech Stack:** TypeScript, Vitest, Supabase, Finale REST client, existing `agent_task` dashboard hub.

---

### Task 1: Lifecycle Schema

**Files:**
- Create: `supabase/migrations/20260520_create_axiom_order_lifecycle.sql`

**Steps:**
1. Add `axiom_order_templates` keyed by Finale SKU with approved Axiom spec JSON.
2. Add `axiom_order_lifecycle` keyed by PO number with status, items, missing-template SKUs, and duplicate blockers.
3. Add indexes for open lifecycle rows and SKU overlap.

### Task 2: Lifecycle Assessment

**Files:**
- Create: `src/lib/axiom/lifecycle.ts`
- Test: `src/lib/axiom/lifecycle.test.ts`

**Steps:**
1. Write tests for missing template, all templates ready, and duplicate active SKU.
2. Implement pure assessment logic.
3. Implement best-effort Supabase upsert and dashboard task creation.

### Task 3: Draft PO Hook

**Files:**
- Modify: `src/lib/finale/client.ts`

**Steps:**
1. After draft PO creation or reuse, resolve vendor name.
2. If vendor is Axiom Print, call the lifecycle service with PO number and items.
3. Keep it best-effort: log failures, never block PO creation.

### Task 4: Verification

**Commands:**
- `npm test -- --run src/lib/axiom/lifecycle.test.ts src/lib/finale/client.test.ts`
- `npm test -- --run src/lib/finale/freight-adjustment.test.ts src/app/api/dashboard/invoice-queue/route.test.ts src/app/api/axiom-sku-mappings/route.test.ts src/components/dashboard/command-board/AxiomSkuMappingPanel.test.tsx src/lib/finale/reconciler.test.ts`
- `git diff --check`
