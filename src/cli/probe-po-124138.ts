import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function run() {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    const query = {
        query: `{
            orderViewConnection(
                first: 10
                type: ["PURCHASE_ORDER"]
                orderId: ["124138"]
            ) {
                edges { node {
                    orderId status orderDate receiveDate
                    supplier { name }
                    shipmentList {
                        shipmentId
                        status
                        shipDate
                        trackingCode
                        receiveDate
                    }
                }}
            }
        }`
    };

    const res = await fetch(`${baseUrl}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
    });
    
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));

}
run().catch(console.error);
