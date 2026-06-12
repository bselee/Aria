import * as dotenv from 'dotenv';
import * as path from 'path';
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

async function main() {
    const apiKey = process.env.FINALE_API_KEY!;
    const apiSecret = process.env.FINALE_API_SECRET!;
    const accountPath = process.env.FINALE_ACCOUNT_PATH!;
    const baseUrl = process.env.FINALE_BASE_URL!;
    if (!apiKey || !apiSecret) { console.error('Missing FINALE_API_KEY or FINALE_API_SECRET'); process.exit(1); }
    const authHeader = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
    const apiBase = baseUrl; // e.g. https://app.finaleinventory.com

    // Vendor lookup
    const vq = { query: '{ partyViewConnection(first:20 type:["VENDOR","SUPPLIER"]) { edges { node { partyId name } } } }' };
    const vr = await fetch(apiBase + '/' + accountPath + '/api/graphql', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(vq),
    });
    const vj: any = await vr.json();
    const vendors = (vj.data?.partyViewConnection?.edges || []).map((e: any) => e.node);
    const uline = vendors.find((v: any) => (v.name || '').toUpperCase().includes('ULINE'));
    console.log('ULINE vendor:', uline ? uline.partyId + ' (' + uline.name + ')' : 'NOT FOUND');
    if (!uline) { console.log('Available vendors:', vendors.map((v: any) => v.name).join(', ')); }

    // All Created-status POs (any date)
    const cq = { query: '{ orderViewConnection(first:50 type:["PURCHASE_ORDER"] status:["Created"] sort:[{field:"orderDate",mode:"desc"}]) { edges { node { orderId status orderDate grandTotal supplier{name partyId} } } } }' };
    const cr = await fetch(apiBase + '/' + accountPath + '/api/graphql', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(cq),
    });
    const cj: any = await cr.json();
    const cEdges = (cj.data?.orderViewConnection?.edges || []);
    console.log('\nAll Created-status POs:', cEdges.length);
    for (const e of cEdges) {
        const po = e.node;
        console.log('  PO:' + po.orderId + ' vendor:' + (po.supplier?.name || 'unk') + ' date:' + po.orderDate + ' total:' + (po.grandTotal || '?'));
    }

    // All POs last 90 days (no status filter)
    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - 90);
    const bs = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const es = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const pq = { query: '{ orderViewConnection(first:50 type:["PURCHASE_ORDER"] orderDate:{begin:"' + bs + '",end:"' + es + '"} sort:[{field:"orderDate",mode:"desc"}]) { edges { node { orderId status orderDate grandTotal supplier{name partyId} } } } }' };
    const pr = await fetch(apiBase + '/' + accountPath + '/api/graphql', {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(pq),
    });
    const pj: any = await pr.json();
    const edges = (pj.data?.orderViewConnection?.edges || []);
    console.log('\nAll POs (90 days):', edges.length);
    for (const e of edges) {
        const po = e.node;
        console.log('  PO:' + po.orderId + ' vendor:' + (po.supplier?.name || 'unk') + ' status:' + po.status + ' date:' + po.orderDate + ' total:' + (po.grandTotal || '?'));
    }

    // ULINE Created POs — get line items
    const ul = cEdges.filter((e: any) => (e.node.supplier?.name || '').toUpperCase().includes('ULINE'));
    console.log('\nULINE Created POs:', ul.length);
    for (const e of ul) {
        const po = e.node;
        console.log('\n--- PO ' + po.orderId + ' ---');
        const dq = { query: '{ orderView(orderId:"' + po.orderId + '") { orderId status orderDate grandTotal memo items { productId quantity unitPrice quantityOrdered description } } }' };
        const dr = await fetch(apiBase + '/' + accountPath + '/api/graphql', {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(dq),
        });
        const dj: any = await dr.json();
        const ord = dj.data?.orderView;
        if (ord) {
            console.log('Status:', ord.status, 'Date:', ord.orderDate, 'Total:', ord.grandTotal);
            console.log('Memo:', (ord.memo || '').substring(0, 200));
            const items = ord.items || [];
            console.log('Items:', items.length);
            for (const item of items) {
                const sku = item.productId || '?';
                const qty = item.quantity ?? item.quantityOrdered ?? '?';
                const price = item.unitPrice ?? '?';
                const desc = (item.description || item.product?.description || '').substring(0, 60);
                console.log('  ' + sku + '  qty=' + qty + '  price=$' + price + '  ' + desc);
            }
        } else {
            console.log('No orderView details');
            console.log(JSON.stringify(dj, null, 2).substring(0, 500));
        }
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
