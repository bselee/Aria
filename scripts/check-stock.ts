import * as dotenv from 'dotenv';
import { FinaleClient } from '../src/lib/finale/client';

dotenv.config({ path: '.env.local' });
const finale = new FinaleClient();

async function run() {
    try {
        const targetIds = [
            "S-4092", // 9x5x5
            "S-4128", // 12x6x6
            "S-4122", // 12x12x6
            "S-4125", // 12x12x12
            "S-4796", // 22x14x6
            "S-4738"  // 24x14x10
        ];

        console.log("== Box Stock Report for Procurement ==");
        for (const id of targetIds) {
            const product = await finale.lookupProduct(id);
            if (!product) continue;

            // Get raw GraphQL data for these to see suggested reorder qty
            const query = {
                query: `{
                    productViewConnection(first: 1, productId: "${id}") {
                        edges {
                            node {
                                reorderQuantityToOrder
                            }
                        }
                    }
                }`
            };

            // @ts-ignore
            const res = await fetch(`${finale.apiBase}/${finale.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    // @ts-ignore
                    Authorization: finale.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });
            const result = await res.json();
            const reorderQty = result.data?.productViewConnection?.edges?.[0]?.node?.reorderQuantityToOrder || '--';

            console.log(`[${id}] ${product.name}`);
            console.log(`  Finale Suggests Ordering: ${reorderQty}`);

            // Only care about open POs if they are recent. 123976 is clearly a stale lock from Nov 2025.
            const validPos = product.openPOs.filter((po: any) => po.orderId !== "123976");
            if (validPos.length > 0) {
                console.log(`  Valid Open POs:`);
                for (const po of validPos) {
                    console.log(`    - PO ${po.orderId}: ${po.quantityOnOrder} from ${po.supplier}`);
                }
            } else {
                console.log(`  Valid Open POs: None`);
            }
            console.log('');
        }
    } catch (e: any) {
        console.error(`Error:`, e.message);
    }
}
run();
