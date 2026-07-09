// Apply Colorful policy change: target_cover_days 180 → 90
// Run: node --env-file=.env.local --import tsx scripts/apply-colorful-policy.ts

const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/vendor_reorder_policies?vendor_party_id=eq.10918';
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 8000);

(async () => {
  try {
    const resp = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        target_cover_days: 90,
        notes: 'Colorful: 60d build/ship. Order ~90d supply (tightened 2026-06-23).',
      }),
      signal: ctrl.signal,
    });
    console.log('Status:', resp.status);
    const text = await resp.text();
    console.log(text.slice(0, 300));
  } catch (e: any) {
    console.log('Failed:', e.message);
  }
})();
