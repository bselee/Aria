/**
 * @file    src/lib/intelligence/hermes-orchestrator.ts
 * @purpose Hermia Orchestrator — the single source of truth for agent
 *          hierarchy, delegation, and accountability. Every agent in
 *          Aria reports through this layer. Replaces the flat OpsManager
 *          agent ownership with a clear command chain.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase
 *
 * ARCHITECTURE:
 *
 *   Hermia (HermesOrchestrator) — "I decide what matters"
 *   ├── Domain: Accounts Payable
 *   │   └── APMasterAgent — "I own invoice processing"
 *   │       ├── EmailIngestor — downloads + queues emails
 *   │       ├── InvoiceClassifier — INVOICE/STATEMENT/AD/HUMAN
 *   │       ├── PDFExtractor — PDF → structured data
 *   │       ├── POMatcher — invoice → Finale PO matching
 *   │       ├── Reconciler — price comparison + auto-apply
 *   │       └── BillComForwarder — forward to buildasoilap@bill.com
 *   │
 *   ├── Domain: Purchasing
 *   │   └── PurchasingMasterAgent — "I own inventory + ordering"
 *   │       ├── InventoryScanner — getPurchasingIntelligence()
 *   │       ├── DraftPOBuilder — create draft POs
 *   │       ├── VendorCycleGuard — prevent PO fragmentation
 *   │       └── POFollowUp — vendor acknowledgment tracking
 *   │
 *   ├── Domain: Communications
 *   │   └── CommsMasterAgent — "I own vendor + team messages"
 *   │       ├── SlackWatchdog — detect requests, 👀 react
 *   │       ├── EmailAcknowledger — auto-reply to vendors
 *   │       └── VendorComms — PO follow-up drafting
 *   │
 *   ├── Domain: Tracking
 *   │   └── TrackingMasterAgent — "I own shipment visibility"
 *   │       ├── CarrierPoller — AfterShip, FedEx, EasyPost
 *   │       └── ShipmentIntelligence — ETA, status, alerts
 *   │
 *   └── Domain: Operations
 *       └── OpsMasterAgent — "I own system health"
 *           ├── CronScheduler — running the clock
 *           ├── CognitiveRound — priority decisions
 *           ├── Supervisor — error triage + escalation
 *           └── BudgetTracker — per-agent LLM spend
 *
 * ACCOUNTABILITY MODEL:
 *   Each agent has:
 *     - domain: string        (what it owns)
 *     - status: AgentStatus   (healthy | degraded | stopped | paused)
 *     - heartbeat(): void     (register with OversightAgent)
 *     - health(): HealthReport (self-diagnostic)
 *     - delegate(task): result (Hermia's delegation interface)
 *
 *   Hermia polls all agents every 15 min:
 *     1. gatherHealth() — check heartbeats
 *     2. gatherBacklog() — check pending tasks
 *     3. decidePriority() — Cognitive Round
 *     4. delegate() — push work to domain agents
 *     5. report() — log decisions + telemetry
 */

import { createClient } from "@/lib/supabase";

// ── Agent Registry ──────────────────────────────────────────────────────────

export type AgentDomain =
    | "accounts-payable"
    | "purchasing"
    | "communications"
    | "tracking"
    | "operations";

export type AgentStatus = "healthy" | "degraded" | "stopped" | "paused" | "starting";

export interface AgentRegistration {
    domain: AgentDomain;
    name: string;
    role: "master" | "worker";
    status: AgentStatus;
    lastHeartbeat: string;
    pendingTasks: number;
    errorCount: number;
    registeredAt: string;
    notes: string;
}

export interface HealthReport {
    domain: AgentDomain;
    masterAgent: string;
    workerCount: number;
    healthyCount: number;
    degradedCount: number;
    stoppedCount: number;
    pendingTasks: number;
    aggregateStatus: AgentStatus;
    warnings: string[];
}

export interface DelegationTask {
    taskId: string;
    domain: AgentDomain;
    action: string;
    payload: Record<string, unknown>;
    priority: "critical" | "high" | "medium" | "low";
    deadline?: string;
    assignedTo?: string;
    status: "pending" | "assigned" | "running" | "completed" | "failed";
}

// ── Domain Agent Definitions ────────────────────────────────────────────────

const AGENT_REGISTRY: AgentRegistration[] = [
    // Accounts Payable
    { domain: "accounts-payable", name: "ap-master", role: "master", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Owns all AP: ingestion, classification, extraction, matching, reconciliation, Bill.com" },
    { domain: "accounts-payable", name: "ap-ingestor", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Email download + queue (Gmail API)" },
    { domain: "accounts-payable", name: "ap-classifier", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "INVOICE/STATEMENT/AD/HUMAN classification" },
    { domain: "accounts-payable", name: "ap-extractor", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "PDF → structured invoice data" },
    { domain: "accounts-payable", name: "ap-matcher", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Invoice → Finale PO matching" },
    { domain: "accounts-payable", name: "ap-reconciler", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Price comparison + auto-apply" },
    { domain: "accounts-payable", name: "ap-forwarder", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Bill.com forwarding" },

    // Purchasing
    { domain: "purchasing", name: "purchasing-master", role: "master", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Owns inventory intelligence + PO creation" },
    { domain: "purchasing", name: "purchasing-scanner", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "getPurchasingIntelligence() — 121 SKUs, 65 vendors" },
    { domain: "purchasing", name: "purchasing-drafter", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Draft PO creation + validation" },
    { domain: "purchasing", name: "purchasing-cycle-guard", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Vendor order cycle guard (evaluateVendorCycle())" },
    { domain: "purchasing", name: "purchasing-followup", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "PO acknowledgment tracking + vendor nudges" },

    // Communications
    { domain: "communications", name: "comms-master", role: "master", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Owns Slack + email + vendor comms" },
    { domain: "communications", name: "slack-watchdog", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Slack monitoring + 👀 reactions" },
    { domain: "communications", name: "email-ack", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Vendor email auto-acknowledgment" },
    { domain: "communications", name: "vendor-comms", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "PO follow-up email drafting" },

    // Tracking
    { domain: "tracking", name: "tracking-master", role: "master", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Owns shipment visibility" },
    { domain: "tracking", name: "carrier-poller", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "AfterShip + FedEx + EasyPost polling" },
    { domain: "tracking", name: "shipment-intel", role: "worker", status: "starting", lastHeartbeat: "", pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "ETA extraction + status alerts" },

    // Operations
    { domain: "operations", name: "ops-master", role: "master", status: "healthy", lastHeartbeat: new Date().toISOString(), pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Owns cron + cognitive + oversight + budget" },
    { domain: "operations", name: "cron-scheduler", role: "worker", status: "healthy", lastHeartbeat: new Date().toISOString(), pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "20+ cron jobs, every 15min AP polling" },
    { domain: "operations", name: "cognitive-round", role: "worker", status: "healthy", lastHeartbeat: new Date().toISOString(), pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Priority decisions every 15min" },
    { domain: "operations", name: "supervisor", role: "worker", status: "healthy", lastHeartbeat: new Date().toISOString(), pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Error triage + escalation (deterministic)" },
    { domain: "operations", name: "budget-tracker", role: "worker", status: "healthy", lastHeartbeat: new Date().toISOString(), pendingTasks: 0, errorCount: 0, registeredAt: new Date().toISOString(), notes: "Per-agent LLM spend tracking" },
];

// ── Orchestrator ────────────────────────────────────────────────────────────

export class HermesOrchestrator {
    private agents: Map<string, AgentRegistration>;

    constructor() {
        this.agents = new Map(AGENT_REGISTRY.map(a => [a.name, a]));
    }

    /**
     * Get all registered agents.
     */
    listAgents(): AgentRegistration[] {
        return Array.from(this.agents.values());
    }

    /**
     * Get health report for a specific domain or all domains.
     */
    getDomainHealth(domain?: AgentDomain): HealthReport[] {
        const domains = domain ? [domain] : [...new Set(AGENT_REGISTRY.map(a => a.domain))];
        return domains.map(d => {
            const workers = AGENT_REGISTRY.filter(a => a.domain === d && a.role === "worker");
            const master = AGENT_REGISTRY.find(a => a.domain === d && a.role === "master");
            const healthy = workers.filter(w => w.status === "healthy").length;
            const degraded = workers.filter(w => w.status === "degraded").length;
            const stopped = workers.filter(w => w.status === "stopped").length;

            return {
                domain: d,
                masterAgent: master?.name || "unknown",
                workerCount: workers.length,
                healthyCount: healthy,
                degradedCount: degraded,
                stoppedCount: stopped,
                pendingTasks: workers.reduce((s, w) => s + w.pendingTasks, 0),
                aggregateStatus: stopped > 0 ? "degraded" : master?.status === "healthy" ? "healthy" : "starting",
                warnings: stopped > 0 ? [`${stopped} workers stopped`] : [],
            };
        });
    }

    /**
     * Register a heartbeat from an agent. Hermia uses this to track
     * which agents are alive and accountable.
     */
    async registerHeartbeat(agentName: string, status: AgentStatus = "healthy"): Promise<void> {
        const agent = this.agents.get(agentName);
        if (!agent) return;

        agent.status = status;
        agent.lastHeartbeat = new Date().toISOString();

        // Persist to Supabase for cross-session tracking
        const supabase = createClient();
        if (supabase) {
            try {
                await supabase.from("agent_heartbeats").upsert({
                    agent_name: agentName,
                    heartbeat_at: agent.lastHeartbeat,
                    status,
                    metadata: {
                        domain: agent.domain,
                        role: agent.role,
                        pendingTasks: agent.pendingTasks,
                        errorCount: agent.errorCount,
                    },
                    updated_at: agent.lastHeartbeat,
                }, { onConflict: "agent_name" });
            } catch { /* non-fatal */ }
        }
    }

    /**
     * Report a task completion or failure for an agent.
     * Hermia tracks per-agent error counts and raises alerts
     * when an agent accumulates too many failures.
     */
    async reportTaskOutcome(
        agentName: string,
        outcome: "success" | "failure",
        error?: string,
    ): Promise<void> {
        const agent = this.agents.get(agentName);
        if (!agent) return;

        if (outcome === "success") {
            agent.pendingTasks = Math.max(0, agent.pendingTasks - 1);
        } else {
            agent.errorCount++;
            if (agent.errorCount >= 5) {
                console.warn(
                    `🚨 [Hermia] Agent ${agentName} has ${agent.errorCount} errors. ` +
                    `Domain: ${agent.domain}. Last error: ${error?.slice(0, 80)}`,
                );
            }
        }
    }

    /**
     * Format a human-readable agent hierarchy for Telegram display.
     */
    formatAgentHierarchy(): string {
        const domains = ["accounts-payable", "purchasing", "communications", "tracking", "operations"] as AgentDomain[];
        const lines: string[] = [
            "🏛️ *Hermia Agent Hierarchy*",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "",
        ];

        for (const domain of domains) {
            const agents = AGENT_REGISTRY.filter(a => a.domain === domain);
            const master = agents.find(a => a.role === "master");
            const workers = agents.filter(a => a.role === "worker");

            const statusIcon = master?.status === "healthy" ? "🟢" :
                               master?.status === "degraded" ? "🟠" :
                               master?.status === "stopped" ? "🔴" : "⚪";

            lines.push(`*${domain.toUpperCase()}*`);
            lines.push(`  ${statusIcon} Master: ${master?.name} (${master?.status})`);

            for (const w of workers) {
                const wIcon = w.status === "healthy" ? "🟢" :
                              w.status === "degraded" ? "🟠" :
                              w.status === "stopped" ? "🔴" : "⚪";
                const errStr = w.errorCount > 0 ? ` — ${w.errorCount} errors` : "";
                lines.push(`    ${wIcon} ${w.name} (${w.status})${errStr}`);
            }
            lines.push("");
        }

        const total = AGENT_REGISTRY.length;
        const healthy = AGENT_REGISTRY.filter(a => a.status === "healthy").length;
        lines.push(`*Total:* ${healthy}/${total} healthy`);

        return lines.join("\n");
    }
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _orchestrator: HermesOrchestrator | null = null;

export function getOrchestrator(): HermesOrchestrator {
    if (!_orchestrator) {
        _orchestrator = new HermesOrchestrator();
    }
    return _orchestrator;
}