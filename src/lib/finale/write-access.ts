export type FinaleWriteSource = "dashboard" | "slack_watchdog" | "cli" | "automation" | string;

export type FinaleWriteAction = "create_draft_po" | "commit_draft_po" | string;

export interface FinaleWriteContext {
    source: FinaleWriteSource;
    action: FinaleWriteAction;
}

const ALLOWED_WRITES = new Set<string>([
    "dashboard:create_draft_po",
    "dashboard:commit_draft_po",
]);

function getWriteKey(context: FinaleWriteContext): string {
    return `${context.source}:${context.action}`;
}

export function isFinaleWriteAllowed(context: FinaleWriteContext): boolean {
    return ALLOWED_WRITES.has(getWriteKey(context));
}

export function assertFinaleWriteAllowed(context: FinaleWriteContext): void {
    if (isFinaleWriteAllowed(context)) return;

    throw new Error(
        `Finale write denied: source "${context.source}" cannot ${context.action}`
    );
}
