/**
 * @file Chat API route — AI assistant embedded in Aria dashboard
 * @purpose Proxies chat messages to OpenRouter directly (no agent loop).
 *          Supports both SSE streaming and JSON responses.
 * @author Hermia
 * @created 2026-06-02
 * @deps openai SDK
 * @env OPENROUTER_API_KEY, OPENAI_API_KEY (fallback), CHAT_MODEL
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

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "No API key configured" }, { status: 500 });
    }

    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "messages array required" }, { status: 400 });
    }

    const isOpenRouter = !!process.env.OPENROUTER_API_KEY;

    const openai = new OpenAI({
      apiKey,
      baseURL: isOpenRouter ? "https://openrouter.ai/api/v1" : undefined,
      defaultHeaders: isOpenRouter
        ? {
            "HTTP-Referer": "https://aria.buildasoil.com",
            "X-Title": "Aria Dashboard Chat",
          }
        : undefined,
    });

    const model = process.env.CHAT_MODEL || "deepseek/deepseek-v4-flash";
    const useStreaming = req.headers.get("accept") === "text/event-stream";

    if (useStreaming) {
          const response = await openai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              ...messages,
            ],
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
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ],
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