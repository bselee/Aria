import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function checkUls455POs() {
    const client: any = new FinaleClient();
    const sku = 'ULS455';
    const productUrl = `/${process.env.FINALE_ACCOUNT_PATH}/api/product/${sku}`;
    const query = {
        query: `{
            orderViewConnection(first: 100, type: ["PURCHASE_ORDER"], product: ["${productUrl}"]) {
                edges { node { orderId status orderDate itemList(first: 20) { edges { node { product { productId } quantity } } } } }
            }
        }`
    };
    const data = await client.graphql(query, 'ULS455 POs');
    const edges = data?.orderViewConnection?.edges || [];
    edges.forEach((e: any) => {
        const po = e.node;
        const item = po.itemList.edges.find((ie: any) => ie.node.product.productId === sku);
        console.log(`PO: ${po.orderId} | Status: ${po.status} | Date: ${po.orderDate} | Qty: ${item.node.quantity}`);
    });
}
checkUls455POs();
