/**
 * @file    ap-service.ts
 * @purpose Accounts Payable service — inbox polling cycle orchestration
 * @created 2026-05-29
 * @author  Bill Selee
 * @extracted-from ops-manager.ts (Phase 3/3 OpsManager split)
 * @deps    email-polling-cycle, workers/ap-identifier, workers/email-ingestion,
 *          workers/ap-forwarder, acknowledgement-agent, oversight-agent
 */

import { APIdentifierAgent } from "../workers/ap-identifier";
import { EmailIngestionWorker } from "../workers/email-ingestion";
import { APForwarderAgent } from "../workers/ap-forwarder";
import { AcknowledgementAgent } from "../acknowledgement-agent";
import { OversightAgent } from "../oversight-agent";
import { runEmailPollingCycle } from "../email-polling-cycle";

export class APService {
    constructor(
        private apIdentifier: APIdentifierAgent,
        private emailIngestionDefault: EmailIngestionWorker,
        private emailIngestionAP: EmailIngestionWorker,
        private apForwarder: APForwarderAgent,
        private ackAgent: AcknowledgementAgent,
        private oversightAgent: OversightAgent,
    ) {}

    /**
     * Periodically poll AP inbox for new invoices.
     * Orchestrates the full email polling cycle: ingestion → identification → forwarding.
     */
    async pollAPInbox() {
        console.log("\u{1F4E1} Polling AP Inbox...");
        try {
            await runEmailPollingCycle({
                emailIngestionDefault: this.emailIngestionDefault,
                acknowledgementAgent: this.ackAgent,
                emailIngestionAP: this.emailIngestionAP,
                apIdentifier: this.apIdentifier,
                apForwarder: this.apForwarder,
                onStageSuccess: (stage: string) => this.oversightAgent.registerHeartbeat(stage, stage, { source: "email-polling-cycle" }),
            });
        } catch (err: any) {
            console.error("AP Polling error:", err.message);
        }
    }
}
