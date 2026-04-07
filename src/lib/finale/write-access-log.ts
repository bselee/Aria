import { createClient } from "@/lib/supabase";
import type { FinaleWriteAction, FinaleWriteSource } from "./write-access";

export interface FinaleWriteAttemptLogInput {
    source: FinaleWriteSource;
    action: FinaleWriteAction;
    allowed: boolean;
    denialReason?: string;
    target?: Record<string, unknown>;
}

export async function recordFinaleWriteAttempt(input: FinaleWriteAttemptLogInput): Promise<void> {
    const auditRow = {
        email_from: "aria@buildasoil.local",
        email_subject: `Finale ${input.action}`,
        intent: "FINALE_WRITE_ATTEMPT",
        action_taken: input.allowed
            ? `Finale write allowed: ${input.source} -> ${input.action}`
            : `Finale write denied: ${input.source} -> ${input.action}`,
        notified_slack: false,
        metadata: {
            source: input.source,
            action: input.action,
            allowed: input.allowed,
            denialReason: input.denialReason ?? null,
            target: input.target ?? null,
        },
    };

    const db = createClient();
    if (!db) {
        console.info("[finale] Write attempt audit log:", auditRow);
        return;
    }

    try {
        const { error } = await db.from("ap_activity_log").insert(auditRow);
        if (error) {
            console.warn("[finale] Failed to record write attempt audit log:", error.message);
        }
    } catch (err: any) {
        console.warn("[finale] Failed to record write attempt audit log:", err?.message ?? String(err));
    }
}
