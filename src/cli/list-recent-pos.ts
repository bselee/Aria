import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test(limit: number = 500) {
    console.log(`🧪 Searching for all POs (latest ${limit})...`);
    
    const query = {
        query: `
            query {
                orderViewConnection(
                    first: ${limit}
                    type: ["PURCHASE_ORDER"]
                    sort: [{ field: "orderId", mode: "desc" }]
                ) {
                    edges {
                        node {
                            orderId
                            status
                            orderDate
                            supplier { name }
                            total
                            itemList(first: 100) {
                                edges {
                                    node {
                                        product { productId }
                                        quantity
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `
    };

    const res = await fetch(`https://app.finaleinventory.com/${process.env.FINALE_ACCOUNT_PATH}/api/graphql`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(query),
    });

    const result: any = await res.json();
    const edges = result.data?.orderViewConnection?.edges || [];
    
    console.log(`Found ${edges.length} recent POs:`);
    for (const edge of edges) {
        const po = edge.node;
        console.log(`\nPO: ${po.orderId} | Status: ${po.status} | Supplier: ${po.supplier?.name}`);
        po.itemList?.edges.forEach((item: any) => {
            console.log(`  - ${item.node.product?.productId}: Qty ${item.node.quantity}`);
        });
    }

    process.exit(0);
}

const limit = process.argv[2] ? parseInt(process.argv[2]) : 500;
test(limit);
