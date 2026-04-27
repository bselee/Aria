/**
 * @file    agent-task-hash.ts
 * @purpose Deterministic canonicalization + sha256 hashing for agent_task.input_hash.
 *          The TypeScript hash MUST equal the SQL hash produced by the 20260501
 *          migration's UPDATE statement over canonical JSON.
 */
import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export function inputHash(inputs: Record<string, unknown>): string {
    return createHash("sha256").update(canonicalize(inputs)).digest("hex");
}
