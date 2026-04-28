/**
 * @file    registry.ts
 * @purpose Central registry of every Playbook. Map from `playbook_kind`
 *          string to handler. The runner reads this to know what to
 *          dispatch.
 *
 *          Adding a new playbook: import the export below and add it to
 *          the PLAYBOOKS array. Pick a stable kind name — once a row is
 *          tagged with that kind, the runner expects the entry to exist.
 */

import type { Playbook } from "./types";
import { applyPendingMigration } from "./apply-pending-migration";
import { restartStalePm2Proc } from "./restart-stale-pm2-proc";

const PLAYBOOKS: Playbook<unknown>[] = [
    applyPendingMigration as Playbook<unknown>,
    restartStalePm2Proc as Playbook<unknown>,
];

export const PLAYBOOK_BY_KIND: Map<string, Playbook<unknown>> = new Map(
    PLAYBOOKS.map(p => [p.kind, p]),
);

export function listPlaybookKinds(): string[] {
    return PLAYBOOKS.map(p => p.kind);
}
