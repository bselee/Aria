import { FinaleClient } from '@/lib/finale/client';
import { FinaleCoreClient } from '@/lib/finale/core-client';

/**
 * Script that extends FinaleCoreClient to expose protected post method,
 * allowing us to create a purchase order via Finale REST API.
 */
class POBuilder extends FinaleCoreClient {
    constructor() { super(); }

    async createFinalePO(poData: any): Promise<any> {
        return this.post(`/${this.accountPath}/api/purchaseOrder/create`, poData);
    }

    async searchVendor(name: string): Promise<any> {
        return this.get(`/${this.accountPath}/api/party/search?q=${encodeURIComponent(name)}&limit=5`);
    }
}

async function main() {
    const builder = new POBuilder();

    // First, get vendor ID for Surepack USA
    console.log("Searching for Surepack vendor...");
    const vendors = await builder.searchVendor('Surepack');
    const surepackVendor = Array.isArray(vendors) ? vendors.find((v: any) =>
        (v.companyName || '').toLowerCase().includes('surepack')
    ) : null;

    if (surepackVendor) {
        console.log('Surepack vendor found: ID', surepackVendor.companyName || surepackVendor.partyId, '- ID:', surepackVendor.partyId || surepackVendor.id);
    } else {
        console.log('Surepack vendor not found via search. Vendor names:', JSON.stringify(vendors).slice(0, 300));
        // Try alternate name
        const v2 = await builder.searchVendor('SP');
        console.log('Search "SP":', JSON.stringify(v2).slice(0, 300));
    }

    // Check existing POs to Surepack for format
    console.log("\nChecking existing Surepack PO format...");
    const poSearch = await builder.get(`/${builder.accountPath}/api/purchaseOrder/search?q=surepack&limit=5`);
    console.log('PO search:', JSON.stringify(poSearch).slice(0, 1000));
}

main().catch(e => console.error(e));
