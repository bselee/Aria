/**
 * @file    ap-service.ts
 * @purpose Accounts Payable service — inbox polling cycle orchestration
 * @created 2026-05-29
 * @author  Bill Selee
 * @extracted-from ops-manager.ts (Phase 3/3 OpsManager split)
 * @deps    email-polling-cycle, workers/email-ingestion, acknowledgement-agent,
 *          oversight-agent
 */

import { EmailIngestionWorker } from "../workers/email-ingestion";
import { AcknowledgementAgent } from "../acknowledgement-agent";
import { OversightAgent } from "../oversight-agent";
import { runEmailPollingCycle } from "../email-polling-cycle";

export class APService {
    constructor(
        private emailIngestionDefault: EmailIngestionWorker,
        private emailIngestionAP: EmailIngestionWorker,
        private ackAgent: AcknowledgementAgent,
        private oversightAgent: OversightAgent,
    ) {}

    /**
     * Periodically poll AP inbox for new invoices.
     * Ingestion → acknowledgement → ingestion(ap). Forwarding is handled by the
     * local-first forwarder (ap-local-forwarder.ts), not this cycle.
     */
    async pollAPInbox() {
        console.log("\u{1F4E1} Polling AP Inbox...");
        try {
            await runEmailPollingCycle({
                emailIngestionDefault: this.emailIngestionDefault,
                acknowledgementAgent: this.ackAgent,
                emailIngestionAP: this.emailIngestionAP,
                onStageSuccess: (stage: string) => this.oversightAgent.registerHeartbeat(stage, stage, { source: "email-polling-cycle" }),
            });
        } catch (err: any) {
            console.error("AP Polling error:", err.message);
        }
    }
}
