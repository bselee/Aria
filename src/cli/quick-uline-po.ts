import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

async function main() {
    // All Created-status POs
    const cq = {
        query: '{ orderViewConnection(first:50 type:["PURCHASE_ORDER"] status:["Created"] sort:[{field:"orderDate",mode:"desc"}]) { edges { node { orderId status orderDate grandTotal supplier{name partyId} } } } }'
    };
    const cr = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(cq),
    });
    const cj: any = await cr.json();
    const cEdges = (cj.data?.orderViewConnection?.edges || []);
    const ulinePOs = cEdges.filter((e: any) => (e.node.supplier?.name || '').toUpperCase().includes('ULINE'));

    console.log(`ULINE draft POs: ${ulinePOs.length}`);
    for (const e of ulinePOs) {
        const po = e.node;
        console.log(`\nPO: ${po.orderId}  Date: ${po.orderDate}  Total: ${po.grandTotal || '?'}`);
        const dq = { query: `{ orderView(orderId:"${po.orderId}") { orderId status orderDate grandTotal memo items { productId quantity unitPrice description } } }` };
        const dr = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(dq),
        });
        const dj: any = await dr.json();
        const ord = dj.data?.orderView;
        if (ord) {
            console.log('Memo:', (ord.memo || '').substring(0, 200));
            (ord.items || []).forEach((item: any) => {
                console.log(`  ${item.productId} qty=${item.quantity} price=$${item.unitPrice}`);
            });
        }
    }

    if (ulinePOs.length === 0) {
        // Fallback: all recent POs, get first ULINEs
        const pq = { query: '{ orderViewConnection(first:50 type:["PURCHASE_ORDER"] sort:[{field:"orderDate",mode:"desc"}]) { edges { node { orderId status orderDate grandTotal supplier{name partyId} } } } }' };
        const pr = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(pq),
        });
        const pj: any = await pr.json();
        const edges = (pj.data?.orderViewConnection?.edges || []);
        const ulineAll = edges.filter((e: any) => (e.node.supplier?.name || '').toUpperCase().includes('ULINE'));
        console.log(`\nRecent ULINE POs (any status): ${ulineAll.length}`);
        for (const e of ulineAll.slice(0, 3)) {
            const po = e.node;
            console.log(`  PO:${po.orderId} status:${po.status} date:${po.orderDate} total:${po.grandTotal || '?'}`);
        }
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
