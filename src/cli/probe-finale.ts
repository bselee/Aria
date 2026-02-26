import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const apiKey = process.env.FINALE_API_KEY || '';
const apiSecret = process.env.FINALE_API_SECRET || '';
const account = process.env.FINALE_ACCOUNT_PATH || '';
const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

async function run() {
    const res = await fetch(`https://app.finaleinventory.com/${account}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: `{
                productViewConnection(first: 1, productId: "3.0BAGCF") {
                    edges {
                        node {
                            productId
                            stockOnHand
                            stockAvailable
                            stockOnOrder
                            stockReserved
                            consumptionQuantity
                            demandQuantity
                            stockoutDays
                            reorderQuantityToOrder
                            potentialBuildQuantity
                            stockBomQuantity
                            safetyStockDays
                        }
                    }
                }
            }`
        }),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
}

run();
