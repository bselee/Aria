export interface PromotionalEmailInput {
    from: string;
    subject: string;
    snippet?: string | null;
}

const PROMOTIONAL_SENDERS = [
    "specials@",
    "newsletter@",
    "news@",
    "marketing@",
    "makerting@",
    "message.globalindustrial.com",
    "m.learn.coursera.org",
    "sales@aeropress.com",
    "hello@blimburnseeds.store",
    "info@lightninglabels.com",
    "send.teraganix.com",
    "hello.greenhousemegastore.com",
    "e.zoro.com",
    "mail.aliexpress.com",
    "notice.alibaba.com",
    "buynotice.alibaba.com",
];

const PROMOTIONAL_TERMS = [
    "sale",
    "savings",
    "save up to",
    "discount",
    "promo",
    "promotion",
    "specials",
    "offer",
    "offers",
    "newsletter",
    "webinar",
    "final chance",
    "last day",
    "new arrivals",
    "clearance",
    "shop now",
    "unsubscribe",
];

const OPERATIONAL_TERMS = [
    "invoice",
    "payment request",
    "payment confirmation",
    "payment status",
    "demand for payment",
    "past due",
    "purchase order",
    "po ready",
    "po #",
    "proof",
    "proofs confirmation",
    "your order",
    "order has been",
    "order has changed",
    "order ",
    "tracking",
    "shipped",
    "delivered",
    "quote",
];

export function isObviousPromotionalEmail(input: PromotionalEmailInput): boolean {
    const from = input.from.toLowerCase();
    const subject = input.subject.toLowerCase();
    const snippet = (input.snippet ?? "").toLowerCase();
    const haystack = `${from} ${subject} ${snippet}`;

    if (/^\s*re:/i.test(input.subject)) {
        return false;
    }

    if (OPERATIONAL_TERMS.some((term) => haystack.includes(term))) {
        return false;
    }

    const senderLooksPromotional = PROMOTIONAL_SENDERS.some((term) => from.includes(term));
    const contentLooksPromotional = PROMOTIONAL_TERMS.some((term) => haystack.includes(term));

    return contentLooksPromotional || (senderLooksPromotional && !/\bre:\s*/i.test(input.subject));
}
