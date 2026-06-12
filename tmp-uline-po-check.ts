import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from './src/lib/finale/client.js';

async function main() {
    const client = new FinaleClient();
    const apiBase = (client as any).apiBase;
    const accountPath = (client as any).accountPath;
    const authHeader = (client as any).authHeader;

    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - 30);
    const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const endStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

    // Query ALL POs (no vendor filter) in last 30 days
    const query = {
        query: `{
            orderViewConnection(
                first: 30
                type: ["PURCHASE_ORDER"]
                orderDate: { begin: "${beginStr}", end: "${endStr}" }
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId orderUrl status orderDate grandTotal
                    supplier { partyUrl name partyId }
                    customFields { customFieldName customFieldValue }
                }}
            }
        }`,
    };

    const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
    });
    const json: any = await res.json();
    const edges: any[] = json.data?.orderViewConnection?.edges || [];

    console.log(`All POs (last 30 days): ${edges.length}\n`);
    for (const edge of edges) {
        const po = edge.node;
        const vendor = po.supplier?.name || 'unknown';
        const vendorId = po.supplier?.partyId || '?';
        console.log(`PO:${po.orderId}  vendor:${vendor} (${vendorId})  status:${po.status}  date:${po.orderDate}  total:$${po.grandTotal ?? '?'}`);
    }

    // Also try with status filter for Created only (no date constraint)
    console.log('\n--- All ORDER_CREATED POs (any vendor, any date) ---\n');
    const query2 = {
        query: `{
            orderViewConnection(
                first: 30
                type: ["PURCHASE_ORDER"]
                status: ["Created"]
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId orderUrl status orderDate grandTotal
                    supplier { partyUrl name partyId }
                }}
            }
        }`,
    };

    const res2 = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(query2),
    });
    const json2: any = await res2.json();
    const edges2: any[] = json2.data?.orderViewConnection?.edges || [];

    console.log(`All Created-status POs: ${edges2.length}\n`);
    for (const edge of edges2) {
        const po = edge.node;
        const vendor = po.supplier?.name || 'unknown';
        console.log(`PO:${po.orderId}  vendor:${vendor}  date:${po.orderDate}  total:$${po.grandTotal ?? '?'}`);
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
