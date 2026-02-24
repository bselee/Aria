import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function testFeb20() {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

    const gql = async (queryStr: string) => {
        const res = await fetch(`${baseUrl}/${accountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: queryStr }),
        });
        return res.json();
    };

    // Try a recent date that had completed POs
    console.log("═══ Completed POs received on 2/20/2026 ═══\n");
    const result = await gql(`
        query {
            orderViewConnection(
                first: 20
                type: ["PURCHASE_ORDER"]
                receiveDate: { begin: "2026-02-20", end: "2026-02-21" }
                sort: [{ field: "receiveDate", mode: "desc" }]
            ) {
                edges {
                    node {
                        orderId
                        orderUrl
                        status
                        orderDate
                        receiveDate
                        total
                        supplier { name }
                        itemList(first: 20) {
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
    `);

    if (result.errors) {
        console.log("Error:", result.errors[0].message);
        process.exit(1);
    }

    const edges = result.data?.orderViewConnection?.edges || [];
    console.log(`All POs with receiveDate on 2/20: ${edges.length}`);

    // Filter completed client-side
    const completed = edges.filter((e: any) => e.node.status === "Completed");
    console.log(`Completed only: ${completed.length}\n`);

    for (const e of completed) {
        const po = e.node;
        const items = po.itemList?.edges || [];
        const skus = items.map((i: any) => `${i.node.product?.productId}(${i.node.quantity})`).join(", ");
        console.log(`PO ${po.orderId}: ${po.supplier?.name} | $${po.total} | recv ${po.receiveDate}`);
        console.log(`  ${skus}`);
    }

    // Now simulate Slack digest
    console.log("\n\n═══ Simulated Slack Digest ═══\n");
    const { FinaleClient } = await import('../lib/finale/client');
    const client = new FinaleClient();

    // Manual receivings for test date
    const receivedPOs = completed.map((e: any) => {
        const po = e.node;
        return {
            orderId: po.orderId,
            orderDate: po.orderDate,
            receiveDate: po.receiveDate,
            supplier: po.supplier?.name || "Unknown",
            total: po.total || 0,
            items: (po.itemList?.edges || []).map((ie: any) => ({
                productId: ie.node.product?.productId || "?",
                quantity: ie.node.quantity || 0,
            })),
            finaleUrl: `https://app.finaleinventory.com/${accountPath}/app#order?orderUrl=${encodeURIComponent(po.orderUrl)}`,
        };
    });

    console.log(client.formatReceivingsDigest(receivedPOs));

    process.exit(0);
}
testFeb20();
