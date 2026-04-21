export interface EmailPollingCycleDeps {
    emailIngestionDefault: {
        run: () => Promise<void>;
    };
    acknowledgementAgent: {
        processUnreadEmails: () => Promise<void>;
    };
    emailIngestionAP: {
        run: () => Promise<void>;
    };
    apIdentifier: {
        identifyAndQueue: () => Promise<void>;
    };
    apForwarder: {
        processPendingForwards: () => Promise<void>;
    };
    onStageSuccess?: (stage: string) => Promise<void> | void;
}

async function runEmailStage(
    stageName: string,
    work: () => Promise<void>,
    onSuccess?: (stage: string) => Promise<void> | void,
): Promise<void> {
    try {
        await work();
        await onSuccess?.(stageName);
    } catch (err: any) {
        console.error(`[EmailPollingCycle] ${stageName} failed: ${err.message}`);
    }
}

export async function runEmailPollingCycle(deps: EmailPollingCycleDeps): Promise<void> {
    await runEmailStage("default-email-pipeline", () => deps.emailIngestionDefault.run(), deps.onStageSuccess);
    await runEmailStage("default-acknowledgement", () => deps.acknowledgementAgent.processUnreadEmails(), deps.onStageSuccess);
    await runEmailStage("ap-email-pipeline", () => deps.emailIngestionAP.run(), deps.onStageSuccess);
    await runEmailStage("ap-identifier", () => deps.apIdentifier.identifyAndQueue(), deps.onStageSuccess);
    await runEmailStage("ap-forwarder", () => deps.apForwarder.processPendingForwards(), deps.onStageSuccess);
}
