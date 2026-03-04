---
name: add-bot-tool
description: |
  Scaffold and add a new tool to the Telegram bot (start-bot.ts) following the correct
  OpenAI tool_calls pattern. Use when Will wants a new bot command or capability.
  Includes the full pattern: tool definition, dispatch handler, and auto-learning hook.
allowed-tools:
  - Read
  - Edit
  - Bash(npx tsc *)
  - Bash(pm2 *)
---

# Add Bot Tool (Aria)

Adds a new tool to the Telegram bot following the established OpenAI tool_calls pattern.

## Pattern — 3 Parts to Add in `src/cli/start-bot.ts`

### Part 1: Tool Definition (in the `tools` array)
```typescript
{
  type: "function",
  function: {
    name: "your_tool_name",          // snake_case
    description: "Clear, specific description of what this does and when to call it",
    parameters: {
      type: "object",
      properties: {
        param_name: {
          type: "string",            // string | number | boolean | array
          description: "What this parameter controls"
        }
      },
      required: ["param_name"]       // list required params only
    }
  }
}
```

### Part 2: Dispatch Handler (in the tool switch/case block)
```typescript
case "your_tool_name": {
  const { param_name } = JSON.parse(toolCall.function.arguments);

  // Do the work — call your lib function here
  const result = await yourLibFunction(param_name);

  // Push result back for GPT to incorporate in response
  toolResults.push({
    tool_call_id: toolCall.id,
    role: "tool" as const,
    content: JSON.stringify(result)
  });

  // Auto-learning: remember Q→A in Pinecone
  setImmediate(() => remember(userMessage, JSON.stringify(result)));
  break;
}
```

### Part 3: Import (if calling a new lib module)
```typescript
import { yourLibFunction } from "@/lib/path/to/module";
```

## Rules
1. Tool name: `snake_case`, descriptive, action-oriented (e.g., `check_stock`, `get_build_risk`)
2. Description: GPT uses this to decide when to call — be specific about what triggers it
3. Arguments: always `JSON.parse(toolCall.function.arguments)` — it's always a string
4. Always add `setImmediate(() => remember(...))` after successful execution
5. Add `break;` at end of every case

## After Adding
```bash
# 1. Type-check
npx tsc --noEmit 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"

# 2. Restart
pm2 restart aria-bot

# 3. Verify
pm2 logs aria-bot --lines 30
```

## Testing the New Tool
Send a message to the Telegram bot that should trigger the tool. Check logs:
```bash
pm2 logs aria-bot
```
Look for: `[tool] your_tool_name called` or similar log output.
