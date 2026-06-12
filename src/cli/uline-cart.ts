import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: '.env.local' });

async function main() {
    const sessionPath = path.join(process.cwd(), '.uline-session.json');
    if (!fs.existsSync(sessionPath)) {
        console.error('No .uline-session.json found');
        process.exit(1);
    }
    
    const cookies: any[] = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    console.log(`Loaded ${cookies.length} cookies`);
    
    // Fetch cart
    const res = await fetch('https://www.uline.com/Product/ViewCart', {
        headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
        },
    });
    
    const html = await res.text();
    console.log(`Cart page status: ${res.status}, length: ${html.length}`);
    
    // Look for cart items
    if (html.includes('Your cart is empty') || html.includes('no items')) {
        console.log('\n=== CART IS EMPTY ===');
        return;
    }
    
    // Try to extract items from the page
    const itemMatches = html.match(/S-[0-9]+/g) || [];
    console.log('\nSKUs found in page:', [...new Set(itemMatches)].join(', '));
    
    // Save HTML for inspection
    fs.writeFileSync('/tmp/uline-cart.html', html);
    console.log('\nSaved /tmp/uline-cart.html for inspection');
}

main().catch(e => { console.error(e.message); process.exit(1); });
