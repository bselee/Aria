/**
 * @file    index.ts
 * @purpose Public surface: runAllTripwires() runs every registered tripwire
 *          and returns the union of results. Caller (tripwire-runner) is
 *          responsible for translating results into agent_task hub writes.
 *
 *          To add a new tripwire: import its detect function below, append
 *          its invocation inside runAllTripwires, and register a name that
 *          stays stable across deploys (it's used as agent_task.source_id).
 */

import { detectMigrationDrift, type TripwireResult } from "./migration-drift";

export type { TripwireResult };

export async function runAllTripwires(): Promise<TripwireResult[]> {
    return [await detectMigrationDrift()];
}
