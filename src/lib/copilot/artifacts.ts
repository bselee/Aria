import { createHash } from "crypto";
import OpenAI from "openai";
import { createClient } from "../supabase";
import type { ArtifactSourceType, CopilotArtifact, CopilotChannel } from "./types";

export interface NormalizeArtifactInput {
    threadId: string;
    channel: CopilotChannel;
    sourceType: ArtifactSourceType;
    filename: string;
    mimeType: string;
    rawText?: string;
    summary?: string;
    structuredData?: Record<string, unknown>;
    tags?: string[];
    createdAt?: string;
}

function buildArtifactId(input: NormalizeArtifactInput): string {
    return createHash("sha1")
        .update(`${input.threadId}:${input.sourceType}:${input.filename}:${input.createdAt ?? ""}`)
        .digest("hex")
        .slice(0, 20);
}

export function normalizeArtifact(input: NormalizeArtifactInput): CopilotArtifact {
    const createdAt = input.createdAt ?? new Date().toISOString();
    return {
        artifactId: buildArtifactId({ ...input, createdAt }),
        threadId: input.threadId,
        channel: input.channel,
        sourceType: input.sourceType,
        filename: input.filename,
        mimeType: input.mimeType,
        status: input.summary || input.rawText ? "ready" : "pending",
        rawText: input.rawText,
        summary: input.summary,
        structuredData: input.structuredData,
        tags: input.tags,
        createdAt,
    };
}

export async function saveArtifact(input: NormalizeArtifactInput): Promise<CopilotArtifact> {
    const artifact = normalizeArtifact(input);
    const db = createClient();
    if (!db) return artifact;

    await db.from("copilot_artifacts").upsert({
        artifact_id: artifact.artifactId,
        thread_id: artifact.threadId,
        channel: artifact.channel,
        source_type: artifact.sourceType,
        filename: artifact.filename,
        mime_type: artifact.mimeType,
        status: artifact.status,
        raw_text: artifact.rawText ?? null,
        summary: artifact.summary ?? null,
        structured_data: artifact.structuredData ?? null,
        tags: artifact.tags ?? null,
        created_at: artifact.createdAt,
    });

    return artifact;
}

export async function describeImageArtifact(input: {
    mimeType: string;
    base64: string;
}): Promise<string> {
    const openai = process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;

    if (!openai) {
        return "Image uploaded for copilot follow-up.";
    }

    const res = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{
            role: "user",
            content: [
                {
                    type: "image_url",
                    image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
                },
                {
                    type: "text",
                    text: "You are Aria, an operations assistant for BuildASoil. Analyze this image in business operations terms: products, quantities, invoices, purchase orders, labels, or carts. Be concise and concrete.",
                },
            ],
        }],
        max_tokens: 500,
    });

    return res.choices[0].message.content || "Could not analyze image.";
}
