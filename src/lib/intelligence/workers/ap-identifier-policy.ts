export interface InvoiceInboxPolicy {
    queueForBillCom: boolean;
    addLabels: string[];
    removeLabels: string[];
    activityNote: string;
    reasonCode: string;
}

export function getInvoiceInboxPolicy(sourceInbox: string): InvoiceInboxPolicy {
    if (sourceInbox === "ap") {
        return {
            queueForBillCom: true,
            addLabels: [],
            removeLabels: ["INBOX", "UNREAD"],
            activityNote: "Queued for Bill.com forward",
            reasonCode: "queued_for_billcom",
        };
    }

    return {
        queueForBillCom: false,
        addLabels: ["Follow Up"],
        removeLabels: [],
        activityNote: `Invoice detected on ${sourceInbox} inbox - not forwarded to Bill.com; left visible for review`,
        reasonCode: "invoice_non_ap_inbox",
    };
}

export function getAPHumanInteractionPolicy(sourceInbox: string): InvoiceInboxPolicy {
    return {
        queueForBillCom: false,
        addLabels: ["Follow Up"],
        removeLabels: [],
        activityNote: `Human interaction detected on ${sourceInbox} inbox - left visible for manual AP review`,
        reasonCode: "human_interaction_manual_review",
    };
}

export function getAPMissingPdfPolicy(sourceInbox: string, intent: string): InvoiceInboxPolicy {
    return {
        queueForBillCom: false,
        addLabels: ["Follow Up"],
        removeLabels: [],
        activityNote: `No PDF attachment found on ${intent} in ${sourceInbox} inbox - left visible for manual review`,
        reasonCode: "missing_pdf_manual_review",
    };
}
