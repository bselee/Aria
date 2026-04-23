export interface FedExInvoice {
    invoiceNumber: string;
    invoiceDate: string;
    poNumber?: string;
    totalAmount: number;
    freightAmount: number;
    originCity?: string;
    trackingNumbers: string[];
    lineItems: Array<{
        sku?: string;
        description: string;
        quantity: number;
        unitPrice: number;
        extendedAmount: number;
    }>;
}

interface FedExAuthToken {
    access_token: string;
    expires_at: number;
}

let cachedToken: FedExAuthToken | null = null;

async function getFedExToken(): Promise<string> {
    if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
        return cachedToken.access_token;
    }

    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('FEDEX_CLIENT_ID or FEDEX_CLIENT_SECRET not set');
    }

    const response = await fetch('https://apis.fedex.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`FedEx OAuth failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    cachedToken = {
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
    };

    return cachedToken.access_token;
}

export async function getFedExInvoices(opts: { from: Date; to: Date }): Promise<FedExInvoice[]> {
    const token = await getFedExToken();

    const fromStr = opts.from.toISOString().split('T')[0];
    const toStr = opts.to.toISOString().split('T')[0];

    const response = await fetch(
        `https://apis.fedex.com/track/v1/invoices?fromDate=${fromStr}&toDate=${toStr}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Locale': 'en_US',
            },
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`FedEx Invoice API failed: ${response.status} ${text}`);
    }

    const data = await response.json() as {
        invoiceList?: Array<{
            invoiceNumber: string;
            invoiceDate: string;
            purchaseOrderNumber?: string;
            netAmount: number;
            freightAmount: number;
            originCity?: string;
            trackingNumbers?: string[];
            lineItems?: Array<{
                skuNumber?: string;
                description: string;
                quantity: number;
                unitPrice: number;
                extendedAmount: number;
            }>;
        }>;
    };

    return (data.invoiceList ?? []).map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        invoiceDate: inv.invoiceDate,
        poNumber: inv.purchaseOrderNumber,
        totalAmount: inv.netAmount,
        freightAmount: inv.freightAmount,
        originCity: inv.originCity,
        trackingNumbers: inv.trackingNumbers ?? [],
        lineItems: (inv.lineItems ?? []).map((li) => ({
            sku: li.skuNumber,
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            extendedAmount: li.extendedAmount,
        })),
    }));
}
