---
name: bot-tools
description: |
  Expert agent for the Telegram bot and its tool system. Use when:
  - Adding new tools to the bot (src/cli/start-bot.ts)
  - Modifying existing bot tool logic
  - Debugging tool call failures
  - Understanding the OpenAI tool_calls schema pattern
  - Working on chat history management
  - Changing Aria's persona (src/config/persona.ts)
  - Testing bot tool responses
  - Working on the dashboard chat (src/app/api/dashboard/chat/route.ts — uses Gemini, NOT OpenAI)
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Bot Tools Agent

You are an expert on Aria's Telegram bot (`aria-bot`) and its OpenAI tool-call system.

## Architecture

The bot uses **OpenAI GPT-4o directly** with `tool_calls` — NOT the `llm.ts` wrappers.
`unifiedTextGeneration` is only used as a fallback in the bot.

**Dashboard chat (`src/app/api/dashboard/chat/route.ts`) uses Gemini 2.5 Flash** — completely separate stack.

## Chat History
- `chatHistory`: `Record<string, any[]>` — shared between text + document handlers
- Capped at **20 messages** per user
- Key = Telegram user ID (string)

## System Prompt Rules (injected at runtime in text handler)
1. **LIVE DATA RULE**: Memory context is BACKGROUND ONLY. For prices, costs, stock, PO status, consumption → ALWAYS call the appropriate tool. Never answer from memory alone.
2. **Bias to action**: Never ask clarifying questions when a tool can attempt the task
3. **Anti-hollow-filler**: No "What's next?", "Let me know if you need anything else"
4. **Persona always ON**: Warm, sharp, witty — dry humor welcome

Base persona from: `src/config/persona.ts` (`SYSTEM_PROMPT`)

## Adding a New Bot Tool

Follow this exact pattern in `start-bot.ts`:

### 1. Add to tools array (OpenAI tool_calls format):
```typescript
{
  type: "function",
  function: {
    name: "your_tool_name",
    description: "What this tool does",
    parameters: {
      type: "object",
      properties: {
        param1: { type: "string", description: "..." }
      },
      required: ["param1"]
    }
  }
}
```

### 2. Add handler in the tool dispatch switch:
```typescript
case "your_tool_name": {
  const { param1 } = JSON.parse(toolCall.function.arguments);
  // ... do the work ...
  toolResults.push({
    tool_call_id: toolCall.id,
    role: "tool",
    content: JSON.stringify(result)
  });
  break;
}
```

### 3. Auto-learning (setImmediate pattern):
```typescript
// After successful tool execution:
setImmediate(() => remember(question, JSON.stringify(result)));
```

## Supabase Tools (4 built-in)
- `query_vendors` — vendor lookups
- `query_invoices` — invoice queries
- `query_purchase_orders` — PO queries
- `query_action_items` — action items

## Existing Tool Categories
- Finale: `finale_sku_lookup`, `finale_stock_check`, `finale_bom_check`, `finale_po_status`
- Builds: `build_risk_assessment`, `reorder_assessment`, `create_draft_pos`
- AP: `ap_pipeline_status`, `dropship_fwd_*` callbacks
- Calendar: `calendar_builds_today`, `calendar_builds_week`
- Supabase: 4 query tools above
- Memory: `remember()` called via `setImmediate` after tool success

## After Any Change
```bash
npx tsc --noEmit 2>&1 | grep -v "finale/client.ts" | grep "error TS"
pm2 restart aria-bot
```

## Common Issues
1. **Tool not called by GPT** → Check description clarity; GPT may not trigger tool if description is ambiguous
2. **Arguments parse error** → Ensure `JSON.parse(toolCall.function.arguments)` — arguments are always a JSON string
3. **Chat history context lost** → History capped at 20; older context is lost by design
4. **Tool silently ignored** → Check switch case matches exact tool name; missing `break` causes fall-through
5. **Dashboard chat not responding** → Uses Gemini 2.5 Flash; check `GOOGLE_GENERATIVE_AI_API_KEY`
