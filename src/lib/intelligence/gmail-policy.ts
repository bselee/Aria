const SYSTEM_LABELS = new Set([
    "INBOX",
    "UNREAD",
    "STARRED",
    "IMPORTANT",
    "TRASH",
    "SPAM",
    "SENT",
    "DRAFT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
]);

export interface ApplyMessageLabelPolicyArgs {
    gmail: any;
    gmailMessageId: string;
    addLabels?: string[];
    removeLabels?: string[];
    labelCache?: Map<string, string>;
}

async function getOrCreateLabelId(gmail: any, labelName: string, labelCache: Map<string, string>): Promise<string> {
    const cacheKey = labelName.toLowerCase();
    const cached = labelCache.get(cacheKey);
    if (cached) return cached;

    const res = await gmail.users.labels.list({ userId: "me" });
    const existing = res.data.labels?.find((label: any) => label.name?.toLowerCase() === cacheKey);

    if (existing?.id) {
        labelCache.set(cacheKey, existing.id);
        return existing.id;
    }

    const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
            name: labelName,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
        },
    });

    const id = created.data.id!;
    labelCache.set(cacheKey, id);
    return id;
}

async function resolveLabelIds(
    gmail: any,
    labelNames: string[] | undefined,
    labelCache: Map<string, string>,
): Promise<string[] | undefined> {
    if (!labelNames || labelNames.length === 0) return undefined;

    const ids = await Promise.all(labelNames.map(async (labelName) => {
        if (SYSTEM_LABELS.has(labelName)) {
            return labelName;
        }

        return getOrCreateLabelId(gmail, labelName, labelCache);
    }));

    return ids;
}

export async function applyMessageLabelPolicy({
    gmail,
    gmailMessageId,
    addLabels,
    removeLabels,
    labelCache = new Map<string, string>(),
}: ApplyMessageLabelPolicyArgs): Promise<void> {
    const addLabelIds = await resolveLabelIds(gmail, addLabels, labelCache);
    const removeLabelIds = await resolveLabelIds(gmail, removeLabels, labelCache);

    if ((!addLabelIds || addLabelIds.length === 0) && (!removeLabelIds || removeLabelIds.length === 0)) {
        return;
    }

    await gmail.users.messages.modify({
        userId: "me",
        id: gmailMessageId,
        requestBody: {
            ...(addLabelIds ? { addLabelIds } : {}),
            ...(removeLabelIds ? { removeLabelIds } : {}),
        },
    });
}
