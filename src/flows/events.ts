/**
 * @file    src/flows/events.ts
 * @purpose `emit(type, payload)` — the only public surface for publishing
 *          domain events into the flow substrate. Spoke writers (ap-agent,
 *          po-correlator, reconciler) call this at the success boundary of a
 *          domain action; the flow runner picks the event up on its next tick.
 *
 *          Best-effort: a Supabase outage must not block the domain write
 *          that produced the event. Failures log a warning and return null.
 */

import { createClient } from "@/lib/db";

export interface EmitOptions {
    /** Optional correlation_id for joining future events to in-flight runs. */
    correlationId?: string;
}

/**
 * Publish a flow event. Returns the inserted row id, or null on failure.
 * Never throws — failures are logged.
 */
export async function emit(
    type: string,
    payload: Record<string, unknown> = {},
    opts: EmitOptions = {},
): Promise<string | null> {
    if (!type) {
        console.warn("[flows] emit called with empty type");
        return null;
    }
    const sb = createClient();
    if (!sb) {
        console.warn(`[flows] emit ${type}: supabase unavailable`);
        return null;
    }
    try {
        const { data, error } = await sb
            .from("flow_events")
            .insert({
                type,
                payload,
                correlation_id: opts.correlationId ?? null,
            })
            .select("id")
            .single();
        if (error) {
            console.warn(`[flows] emit ${type} failed: ${error.message}`);
            return null;
        }
        return (data as { id?: string } | null)?.id ?? null;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[flows] emit ${type} threw: ${msg}`);
        return null;
    }
}
