/**
 * @file Chat API route — Hermia assistant embedded in Aria dashboard
 * @purpose Proxies chat messages to the Hermes Agent API (:8642) so the
 *          dashboard chat IS Hermia — full memory, skills, and tools.
 *          Falls back to OpenRouter (dumb chat) if Hermes is unreachable.
 *          Supports both SSE streaming and JSON responses.
 * @author Hermia
 * @created 2026-06-02
 * @updated 2026-06-04 — repoint primary path from OpenRouter → Hermes :8642
 * @deps openai SDK
 * @env HERMES_API_BASE, HERMES_API_KEY (primary);
 *      OPENROUTER_API_KEY, OPENAI_API_KEY, CHAT_MODEL (fallback)
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const SYSTEM_PROMPT = `You are Aria — the AI operations assistant for BuildASoil.
You are embedded in the purchasing operations dashboard. You have access to real-time purchasing data, kanban task state, and inventory information through the dashboard panels around you.

Be concise, direct, and actionable. No fluff, no lengthy explanations unless asked.
You can reference the dashboard panels (risk report, purchasing queue, receivings, tracking, etc.) when relevant.

Current context: You're chatting inside the Aria Command Board dashboard. The user can see kanban tasks, PO lifecycle, and build schedules around you.

Communication style:
- Be terse — the user doesn't want essays
- If asked about a PO, vendor, or order, give specific actionable details (PO number, status, next step)
- If you don't have real-time data, say so and suggest what the user can check in the panels
- The user may paste screenshots — reference them when relevant

The dashboard shows: purchasing queue, risk report, receivings forecast, tracking shipments, build schedules, kanban lifecycle.`;

/**
 * Resolve the active chat backend. Prefers the Hermes Agent API (:8642) so
 * the dashboard chat is the real Hermia with tools/memory. Falls back to
 * OpenRouter for a plain chat model when Hermes isn't configured.
 *
 * @returns backend config: client, model slug, and whether it's Hermes
 */
function resolveBackend(): { client: OpenAI; model: string; isHermes: boolean } | null {
  const hermesKey = process.env.HERMES_API_KEY;
  const hermesBase = process.env.HERMES_API_BASE || "http://127.0.0.1:8642/v1";

  if (hermesKey) {
    return {
      client: new OpenAI({ apiKey: hermesKey, baseURL: hermesBase }),
      model: "hermes-agent",
      isHermes: true,
    };
  }

  // Fallback: OpenRouter / OpenAI plain chat model
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const isOpenRouter = !!process.env.OPENROUTER_API_KEY;
  return {
    client: new OpenAI({
      apiKey,
      baseURL: isOpenRouter ? "https://openrouter.ai/api/v1" : undefined,
      defaultHeaders: isOpenRouter
        ? { "HTTP-Referer": "https://aria.buildasoil.com", "X-Title": "Aria Dashboard Chat" }
        : undefined,
    }),
    model: process.env.CHAT_MODEL || "deepseek/deepseek-v4-flash",
    isHermes: false,
  };
}

export async function POST(req: NextRequest) {
  try {
    const backend = resolveBackend();
    if (!backend) {
      return NextResponse.json({ error: "No chat backend configured" }, { status: 500 });
    }
    const { client: openai, model, isHermes } = backend;

    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "messages array required" }, { status: 400 });
    }

    // Hermes already injects the Hermia persona + skills server-side, so we
    // skip the local SYSTEM_PROMPT to avoid double-priming. The OpenRouter
    // fallback needs it to behave like an operations assistant.
    const outboundMessages = isHermes
      ? messages
      : [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

    const useStreaming = req.headers.get("accept") === "text/event-stream";

    if (useStreaming) {
      const response = await openai.chat.completions.create({
        model,
        messages: outboundMessages,
        stream: true,
        max_tokens: 2048,
      });

      // Convert OpenAI stream async iterable to Web ReadableStream
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of response) {
              const text = chunk.choices?.[0]?.delta?.content || "";
              if (text) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            }
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const response = await openai.chat.completions.create({
      model,
      messages: outboundMessages,
      stream: false,
      max_tokens: 2048,
    });

    return NextResponse.json({
      message: response.choices[0]?.message?.content || "",
      model: response.model,
    });
  } catch (err: any) {
    console.error("[chat] Error:", err?.message || err);
    return NextResponse.json(
      { error: err?.message || "Chat request failed" },
      { status: 500 }
    );
  }
}
