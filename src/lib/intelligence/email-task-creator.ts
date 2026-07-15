/**
 * @file    email-task-creator.ts
 * @purpose Creates agent_task entries from Telegram chat for email-related work.
 *          When Bill says "remind me to reply to Grassroots" or "follow up on Uline",
 *          this creates a structured task visible in the dashboard TasksPanel.
 * @author  Hermia
 * @created 2026-05-29
 * @deps    @/lib/db, @/lib/intelligence/agent-task
 */

import { createClient } from "@/lib/db";
import * as agentTask from "./agent-task";

export interface EmailTaskInput {
    /** Free-text description from Bill */
    description: string;
    /** Optional sender/vendor keywords to match against email queue */
    senderHint?: string;
    /** Optional subject keywords */
    subjectHint?: string;
    /** Priority override */
    priority?: "low" | "medium" | "high" | "urgent";
    /** Due date (ISO string) */
    dueAt?: string;
}

export interface EmailTaskResult {
    success: boolean;
    taskId?: string;
    message: string;
    matchedEmail?: { id: string; from: string; subject: string };
}

/**
 * Create a follow-up task from natural language input.
 * Searches email queues for matching emails to link the task to.
 */
export async function createEmailTask(input: EmailTaskInput): Promise<EmailTaskResult> {
    const db = createClient();
    if (!db) {
        return { success: false, message: "Supabase unavailable" };
    }

    // Try to find matching email in queues
    let matchedEmail: { id: string; from: string; subject: string } | null = null;
    const searchTerms = [input.senderHint, input.subjectHint, input.description]
        .filter(Boolean)
        .join(" ");

    if (searchTerms.length > 2) {
        // Search email_inbox_queue for matching emails
        try {
            const q = `%${searchTerms.slice(0, 50)}%`;
            const { data } = await supabase
                .from("email_inbox_queue")
                .select("id, from_email, subject")
                .or(`from_email.ilike.${q},subject.ilike.${q}`)
                .order("created_at", { ascending: false })
                .limit(1);

            if (data && data.length > 0) {
                matchedEmail = {
                    id: data[0].id,
                    from: data[0].from_email || "unknown",
                    subject: data[0].subject || "no subject",
                };
            }
        } catch { /* table may differ */ }
    }

    // Determine priority from keywords
    let priority = input.priority || "medium";
    const desc = input.description.toLowerCase();
    if (/urgent|asap|critical|today|now/.test(desc)) priority = "high";
    else if (/when you can|low.?pri|sometime/.test(desc)) priority = "low";

    // Calculate closes_when: deadline-based if provided, else 7 days
    const closesWhen = input.dueAt
        ? { kind: "deadline" as const, at: input.dueAt }
        : { kind: "deadline" as const, at: new Date(Date.now() + 7 * 86400000).toISOString() };

    try {
        const task = await agentTask.upsertFromSource({
            source: "telegram_chat",
            sourceId: `email-task-${Date.now()}`,
            type: "manual",
            title: input.description,
            owner: "will",
            priority: priority as "low" | "medium" | "high",
            payload: {
                description: input.description,
                senderHint: input.senderHint,
                subjectHint: input.subjectHint,
                ...(matchedEmail ? { matchedEmailId: matchedEmail.id, matchedFrom: matchedEmail.from, matchedSubject: matchedEmail.subject } : {}),
            },
            closesWhen: closesWhen as any,
        });

        const matchNotice = matchedEmail
            ? `\n📧 Matched: ${matchedEmail.from} — "${matchedEmail.subject.slice(0, 50)}"`
            : "";

        return {
            success: true,
            taskId: task?.id,
            message: `✅ Task created: "${input.description}"${matchNotice}\nPriority: ${priority.toUpperCase()} | Due: ${input.dueAt || "7 days"}`,
            matchedEmail: matchedEmail || undefined,
        };
    } catch (err: any) {
        return { success: false, message: `❌ Failed to create task: ${err.message}` };
    }
}

/**
 * Format the task creation result for Telegram display.
 */
export function formatTaskResult(result: EmailTaskResult): string {
    return result.message;
}
