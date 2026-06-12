import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

async function main() {
    const days = parseInt(process.argv[2], 10) || 90;
    const end = new Date();
    const begin = new Date();
    begin.setDate(begin.getDate() - days);
    const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

    const PAGE_SIZE = 50;
    let cursor: string | null = null;
    const allEdges: any[] = [];

    for (let page = 0; page < 10; page++) {
        const after = cursor ? `, after: "${cursor}"` : '';
        const query = {
            query: `{
                orderViewConnection(
                    first: ${PAGE_SIZE}
                    type: ["PURCHASE_ORDER"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]${after}
                ) {
                    pageInfo { hasNextPage endCursor }
                    edges { node {
                        orderId orderDate status
                        supplier { name }
                    }}
                }
            }`
        };

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
        const json = await res.json();
        if (json.errors) { console.error(json.errors); break; }
        const conn = json.data?.orderViewConnection;
        if (!conn) break;
        allEdges.push(...(conn.edges || []));
        if (!conn.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
        if (!cursor) break;
    }

    console.log(`All POs last ${days}d: ${allEdges.length}`);

    const ulineEdges = allEdges.filter(e => /uline/i.test(e?.node?.supplier?.name || ''));
    console.log(`\nULINE POs: ${ulineEdges.length}\n`);

    for (const e of ulineEdges) {
        const po = e.node;
        console.log(`PO:${po.orderId} status:${po.status} date:${po.orderDate}`);
    }

    // Print full details for Created/ORDER_CREATED
    const drafts = ulineEdges.filter(e => /created|draft/i.test(e.node.status));
    console.log(`\nDraft/created ULINE POs: ${drafts.length}`);
    for (const e of drafts) {
        console.log(JSON.stringify(e.node, null, 2));
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
