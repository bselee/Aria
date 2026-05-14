/**
 * @file    src/flows/registry.ts
 * @purpose Typed registry for flow definitions. Mirrors src/cron/registry.ts.
 *          Importing src/flows/index.ts is a side-effect: every defineFlow()
 *          call below registers itself with this module. start-bot.ts imports
 *          src/flows BEFORE starting the runner cron.
 */

import type { FlowDef } from "./types";

const _registry = new Map<string, FlowDef>();
const _byEvent = new Map<string, FlowDef[]>();

export function defineFlow(def: FlowDef): void {
    if (!def.name) throw new Error("defineFlow: name required");
    if (_registry.has(def.name)) {
        throw new Error(`defineFlow: "${def.name}" already registered`);
    }
    if (!def.steps[def.firstStep]) {
        throw new Error(
            `defineFlow(${def.name}): firstStep "${def.firstStep}" not in steps`,
        );
    }
    _registry.set(def.name, def);
    for (const eventType of def.on) {
        const list = _byEvent.get(eventType) ?? [];
        list.push(def);
        _byEvent.set(eventType, list);
    }
}

export function getFlow(name: string): FlowDef | undefined {
    return _registry.get(name);
}

export function flowsForEvent(eventType: string): FlowDef[] {
    return _byEvent.get(eventType) ?? [];
}

export function listFlows(): FlowDef[] {
    return Array.from(_registry.values());
}

/** Test-only: clear the registry between runs. */
export function _resetRegistry(): void {
    _registry.clear();
    _byEvent.clear();
}
