import { FinaleClient } from '@/lib/finale/client';

async function main() {
    const c = new FinaleClient() as any;

    // Current 24x14x10
    const p = await (c as any).getComponentStockProfile('S-4738');
    console.log('S-4738 onHand:', p.onHand, 'onOrder:', p.onOrder);

    // Search for Surepack 24x14x10
    const search = await (c as any).get(`/${(c as any).accountPath}/api/product/search?q=24x14x10&limit=20`);
    const items = search.results || search.products || [];
    for (const i of items) {
        const vendor = i.supplierList?.[0];
        console.log(i.productId, i.internalName, vendor?.companyName || '', vendor?.price || '');
    }
}
main().catch(e => console.error(e));
