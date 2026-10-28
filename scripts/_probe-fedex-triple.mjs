// Ask FedEx about specific tracking numbers. Usage: node scripts/_probe-fedex-triple.mjs 520484904168 520484904180 520484902420
import fs from 'fs';
const env = {};
fs.readFileSync('.env.local', 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
});
const id = env.FEDEX_CLIENT_ID, sec = env.FEDEX_CLIENT_SECRET;
if (!id || !sec) { console.log('no fedex creds'); process.exit(0); }
const numbers = process.argv.slice(2);
if (!numbers.length) { console.log('usage: <tracking> [...]'); process.exit(0); }

const ar = await fetch('https://apis.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }).toString(),
});
if (!ar.ok) { console.log('auth fail', ar.status, (await ar.text()).slice(0, 300)); process.exit(1); }
const tok = (await ar.json()).access_token;

const tr = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'X-locale': 'en_US' },
    body: JSON.stringify({ trackingInfo: numbers.map((n) => ({ trackingNumberInfo: { trackingNumber: n } })), includeDetailedScans: true }),
});
const d = await tr.json();
console.log('http', tr.status, 'alerts', JSON.stringify(d?.output?.alerts || []));
for (const out of d?.output?.completeTrackResults || []) {
    const res = out?.trackResults?.[0];
    const n = out?.trackingNumber;
    console.log(`\n=== ${n}`);
    if (!res) { console.log('  no result', JSON.stringify(out).slice(0, 300)); continue; }
    console.log('  status:', res.latestStatusDetail?.code, '|', res.latestStatusDetail?.statusByLocale);
    console.log('  estDelivery:', JSON.stringify(res.estimatedDeliveryTimeWindow?.window ?? null));
    const dates = (res.dateAndTimes || []).filter((x) => /ACTUAL_DELIVERY|ESTIMATED_DELIVERY|SHIP|PICKUP/.test(x.type || ''));
    for (const x of dates.slice(0, 5)) console.log(`  ${x.type}: ${x.dateTime}`);
    for (const e of (res.events || []).slice(0, 4)) console.log('  scan:', e.date, e.eventDescription, '|', e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode);
}
