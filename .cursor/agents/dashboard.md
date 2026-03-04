---
name: dashboard
description: |
  Expert agent for the Next.js dashboard UI and API routes. Use when working on:
  - src/app/dashboard/ (page.tsx, layout.tsx)
  - src/components/dashboard/ (all dashboard React components)
  - src/app/api/dashboard/ (all dashboard API routes)
  - src/app/api/webhooks/github/route.ts
  - Dashboard chat (Gemini 2.5 Flash — NOT the Telegram bot)
  - Drag-and-drop panel layout (SortablePanel)
  - Invoice queue, build risk, reorder, purchasing, receivings panels
  - Persistent panel state, snooze system, localStorage merge fix
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Dashboard Agent

You are an expert on Aria's Next.js dashboard — the web UI for Will at `src/app/dashboard/`.

## CRITICAL: Dashboard Chat Uses Gemini, NOT OpenAI
`src/app/api/dashboard/chat/route.ts` uses **Gemini 2.5 Flash** (`@ai-sdk/google`).
This is COMPLETELY separate from the Telegram bot stack.
Env: `GOOGLE_GENERATIVE_AI_API_KEY`

## Dashboard Components (`src/components/dashboard/`)

| Component | Purpose |
|-----------|---------|
| `AgentTerminal.tsx` | Main chat interface — mirrors Telegram bot commands |
| `ChatMirror.tsx` | Shows live Telegram chat history |
| `BuildRiskPanel.tsx` | Displays morning build risk report |
| `BuildSchedulePanel.tsx` | Google Calendar builds view |
| `InvoiceQueuePanel.tsx` | Pending invoice approvals |
| `ReorderPanel.tsx` | Reorder items + per-vendor Draft PO buttons |
| `PurchasingPanel.tsx` | Purchasing intelligence: velocity, runway, urgency, snooze, bulk Draft PO |
| `ReceivedItemsPanel.tsx` | Recent Finale receivings |
| `ActivityFeed.tsx` | Live ops activity log |
| `SortablePanel.tsx` | Drag-and-drop panel wrapper (dnd-kit) |

## API Routes (`src/app/api/dashboard/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/chat` | POST | Gemini 2.5 Flash chat handler |
| `/invoice-action` | POST | Forward invoice to Bill.com or trigger reconciliation |
| `/reorder` | GET/POST | GET: reorder items (10-min cache) / POST: create draft PO |
| `/purchasing` | GET/POST | GET: purchasing intelligence (30-min cache, `?bust`, `?daysBack=730`) / POST: create draft PO |
| `/receivings` | GET | Recent Finale receivings |
| `/send` | POST | Send Telegram message from dashboard |
| `/upload` | POST | Upload PDF for AP processing |
| `/watch` | GET | SSE stream for live activity |

## Invoice Action Route (`/api/dashboard/invoice-action/route.ts`)
- Calls `apAgent.forwardToBillCom` and `apAgent.processInvoiceBuffer` (both must be `public`)
- Auth wrapping: use `google.gmail({ version: 'v1', auth })` not raw `OAuth2Client`

## Drag-and-Drop Panels
- Uses `@dnd-kit/core` and `@dnd-kit/sortable`
- Panel positions persisted to localStorage
- `SortablePanel.tsx` wraps each panel

## Styling
- Tailwind CSS (`tailwind.config.ts`)
- Dark terminal aesthetic — follows existing patterns

## PurchasingPanel Details

**Snooze system** (`aria-dash-purchasing-snooze` localStorage):
- Vendor key: `v:${vendorPartyId}` | Item key: `productId`
- Values: `{ until: number | "forever" }`
- `vendorEffectivelySnoozed()`: vendor snoozed if vendor-level OR all items individually snoozed
- Snoozed vendors: `opacity-40`, strikethrough name, "↩ restore" button (clears vendor + all item snoozes)
- Snoozed items: `opacity-35`, strikethrough name, snooze label, `↩` instead of `···`
- "X snoozed" badge in header with Eye toggle (`showSnoozed`)
- Expired entries auto-purged on mount

**Urgency color coding:**
- `critical` → rose
- `warning` → amber
- `watch` → blue
- `ok` → zinc

**localStorage merge fix (page.tsx):**
After restoring saved layout, check each DEFAULT_LAYOUT panel ID — if missing from all columns, insert into its default column. Prevents newly-added panels from being silently dropped by stale saves.
```typescript
for (const [col, ids] of Object.entries(DEFAULT_LAYOUT) as [ColumnId, string[]][]) {
    for (const id of ids) {
        const inSaved = (Object.values(restored) as string[][]).flat().includes(id);
        if (!inSaved) restored[col].push(id);
    }
}
```

## Common Issues
1. **Chat not responding** → Check `GOOGLE_GENERATIVE_AI_API_KEY`; Gemini may have quota issues
2. **Panel layout not persisting** → Check localStorage key; may conflict with browser privacy settings
3. **Invoice action fails** → Verify `apAgent` methods are `public`; check Gmail auth wrapper uses `google.gmail()`
4. **Reorder panel empty** → `/api/dashboard/reorder` has 10-min cache; module-level variable persists across requests
5. **Purchasing panel empty** → `/api/dashboard/purchasing` has 30-min cache; `?bust=1` forces refresh; full scan takes several minutes
6. **Panel not appearing after add** → Stale localStorage layout silently drops new panels — localStorage merge fix in page.tsx handles this
7. **SSE stream drops** → `/watch` route uses SSE; check that Next.js isn't buffering the response
8. **Build not running** → `npm run build` — check for TypeScript errors (ignore `finale/client.ts`)
