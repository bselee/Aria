export interface InvoiceInboxPolicy {
    queueForBillCom: boolean;
    addLabels: string[];
    removeLabels: string[];
    activityNote: string;
}

export function getInvoiceInboxPolicy(sourceInbox: string): InvoiceInboxPolicy {
    if (sourceInbox === "ap") {
        return {
            queueForBillCom: true,
            addLabels: [],
            removeLabels: ["INBOX", "UNREAD"],
            activityNote: "Queued for Bill.com forward",
        };
    }

    return {
        queueForBillCom: false,
        addLabels: ["Follow Up"],
        removeLabels: [],
        activityNote: `Invoice detected on ${sourceInbox} inbox — not forwarded to Bill.com; left visible for review`,
    };
}
