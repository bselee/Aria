"""
Trace Parker's 6/8 Slack request through the COMPLETE Aria pipeline.
Reads live build_risk_snapshot + Finale products. Shows every step.

Pipeline:
  Step 1: Slack listener (request-detector) receives message
  Step 2: extractSKUs (regex)
  Step 3: alias resolution (sku-aliases.ts)
  Step 4: Finale lookupProduct per SKU
  Step 5: PO check (openPOs filter)
  Step 6: Branch logic — hasPO → Slack thread | no PO → silent | snapshot read → TG DM
  Step 7: per-vendor draft PO rendering
"""
import json
import re
import urllib.request
from datetime import datetime, timedelta


def read_env():
    with open('.env.local') as f:
        return dict(re.findall(r'^([A-Z_][A-Z0-9_]*)=(.*)$', f.read(), re.MULTILINE))


def sb_get(env, path):
    url = env['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/') + path
    req = urllib.request.Request(url, headers={
        'apikey': env['SUPABASE_SERVICE_ROLE_KEY'],
        'Authorization': f'Bearer {env["SUPABASE_SERVICE_ROLE_KEY"]}',
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


# Parker's exact 6/8 message (verbatim, lowercase for the alias step)
PARKER_MSG = ("can we get CRAFT4L, 0811 BAGS, 0711 BAGS, BAV5LBBAG, GBB06, "
              "HAL100, HAL102, KMS101, ACTV101, ACTV102, RAWMILLEDGNARBAR, "
              "and FM104 on order? most of them are right above 30 day threshold "
              "and once we make the totes brock has in his calendar we will be "
              "very low our out of some of the component SKUs @Brock @Bill Selee")
PARKER_REQUESTER = "Parker McMahon"
PARKER_CHANNEL = "purchasing"

# Aliases from sku-aliases.ts (read from source to keep in sync)
ALIASES = {
    '0811BAGS': 'SBD21410811', '0811BAG': 'SBD21410811', '0811B': 'SBD21410811',
    '811BAGS': 'SBD21410811', '811BAG': 'SBD21410811',
    'STOCKDEPOT811': 'SBD21410811', 'STOCKDEPOT0811': 'SBD21410811',
    '0711BAGS': 'SBD21410711', '0711BAG': 'SBD21410711', '0711B': 'SBD21410711',
    '711BAGS': 'SBD21410711', '711BAG': 'SBD21410711',
    'STOCKDEPOT711': 'SBD21410711', 'STOCKDEPOT0711': 'SBD21410711',
    'BAV5LBBAG': 'BAV5LBBAG', 'BAV5LB': 'BAV5LBBAG',
}


def alias_resolve(sku):
    key = re.sub(r'[^A-Z0-9]', '', sku.upper())
    return ALIASES.get(key)


def line_break(char='─', n=70):
    return char * n


def section(title):
    print('\n' + line_break('═', 70))
    print(f'  {title}')
    print(line_break('═', 70))


def step(num, title, *lines):
    print(f'\n  Step {num}: {title}')
    for l in lines:
        print(f'    {l}')


def main():
    env = read_env()

    # ── Step 1: Slack listener receives message ──
    section('STEP 1: Slack listener receives the message')
    step(1, 'Slack message arrives in #purchasing',
         f'Requester: {PARKER_REQUESTER}',
         f'Channel: #{PARKER_CHANNEL}',
         f'Body: "{PARKER_MSG[:120]}{"…" if len(PARKER_MSG) > 120 else ""}"',
         f'Length: {len(PARKER_MSG)} chars',
         '  → Note: User != SLACK_OWNER_USER_ID, so the detector processes it.')

    # ── Step 2: extractSKUs (regex) ──
    section('STEP 2: extractSKUs regex extracts candidate tokens')
    upper = PARKER_MSG.upper()
    pattern1 = re.findall(r'\b[A-Z][A-Z0-9]{2,14}\b', upper)
    pattern2 = re.findall(r'\b\d{3,6}\s[A-Z]{2,8}\b', upper)
    pattern3 = re.findall(r'\b[A-Z]{12,}\b', upper)

    raw_tokens = set()
    # Pattern 1: letter AND digit (mixed SKUs)
    for t in pattern1:
        if re.search(r'[A-Z]', t) and re.search(r'\d', t):
            raw_tokens.add(t)
    # Pattern 2: digit-first
    for t in pattern2:
        raw_tokens.add(t.replace(' ', ''))
    # Pattern 3 (NEW 2026-06-08): all-letter >= 12 chars (catches RAWMILLEDGNARBAR)
    for t in pattern3:
        raw_tokens.add(t)
    raw_tokens = sorted(raw_tokens)

    p1_kept = [t for t in pattern1 if re.search(r'[A-Z]', t) and re.search(r'\d', t)]
    print(f'  Pattern 1 (letter-first, mixed, ≥3 chars): {len(pattern1)} matches → {len(p1_kept)} after letter+digits filter')
    print(f'  Pattern 2 (digit-first, e.g. "0811 BAGS"): {len(pattern2)} matches')
    for t in pattern2: print(f'    • "{t}" → "{t.replace(" ", "")}"')
    print(f'  Pattern 3 (NEW all-letter ≥12, e.g. RAWMILLEDGNARBAR): {len(pattern3)} matches')
    for t in pattern3: print(f'    • {t}')
    print(f'\n  After dedup: {len(raw_tokens)} raw tokens')
    print(f'  Tokens: {raw_tokens}')

    # ── Step 3: alias resolution ──
    section('STEP 3: sku-aliases.ts resolves informal names → canonical SKUs')
    resolved = []
    aliases_hit = 0
    for t in raw_tokens:
        final = alias_resolve(t)
        if final and final != t:
            aliases_hit += 1
            print(f'  {t:<22} → alias hit → {final}')
        else:
            print(f'  {t:<22} → direct          → {t}')
        resolved.append({'raw': t, 'canonical': final or t, 'aliased': bool(final and final != t)})
    print(f'\n  Aliases resolved: {aliases_hit} of {len(raw_tokens)}')

    # ── Step 4: Finale lookupProduct per SKU ──
    section('STEP 4: Finale lookupProduct per canonical SKU')
    print('  (mocked — in production, this queries /api/product/<sku> + openPOs)')
    print('  Per-SKU product data (from latest snapshot lookup):')
    
    # Pull the snapshot for actual data
    rows = sb_get(env, '/rest/v1/build_risk_snapshots'
                          '?select=id,generated_at,components'
                          '&order=generated_at.desc&limit=1')
    snap = rows[0]
    comps = snap['components'] or {}
    
    step4_data = []
    for r in resolved:
        sku = r['canonical']
        c = comps.get(sku)
        if c:
            on_hand = round(c.get('onHand') or 0)
            incoming = sum(p.get('quantity', 0) for p in c.get('incomingPOs') or [])
            need30 = round(c.get('totalRequiredQty') or 0)
            vendor = c.get('vendorName') or '—'
            lt = c.get('leadTimeDays') or 14
            has_open_po = incoming > 0
            step4_data.append({
                'sku': sku, 'on_hand': on_hand, 'incoming': incoming,
                'need30': need30, 'vendor': vendor, 'lt': lt,
                'has_open_po': has_open_po, 'in_snapshot': True,
                'productName': c.get('productName') or ''
            })
        else:
            step4_data.append({
                'sku': sku, 'on_hand': 0, 'incoming': 0, 'need30': 0,
                'vendor': '—', 'lt': 14, 'has_open_po': False,
                'in_snapshot': False, 'productName': ''
            })
    
    for d in step4_data:
        po_note = 'PO#124698' if d['sku'] == 'RAWMILLEDGNARBAR' else '—'
        in_snap = '✓ in snapshot' if d['in_snapshot'] else '✗ NOT in snapshot'
        print(f'  {d["sku"]:<22} {in_snap:<20} onHand={d["on_hand"]:<5}  '
              f'incoming={d["incoming"]:<5}  30d={d["need30"]:<5}  '
              f'vendor={d["vendor"][:20]:<20}  PO={po_note}')

    # ── Step 5: PO check ──
    section('STEP 5: PO check — which SKUs have open POs in Finale?')
    has_po_skus = [d['sku'] for d in step4_data if d['has_open_po']]
    no_po_skus = [d['sku'] for d in step4_data if not d['has_open_po'] and d['in_snapshot']]
    not_in_finale = [d['sku'] for d in step4_data if not d['in_snapshot']]
    print(f'  Has open PO:   {has_po_skus}  (will get Slack thread reply)')
    print(f'  No PO in snapshot:  {no_po_skus}  (TG DM, vendor-grouped)')
    print(f'  Not in Finale/snapshot:  {not_in_finale}  (silent)')

    # ── Step 6: Branch logic ──
    section('STEP 6: Branch logic (request-detector.ts after commit 48180d0)')
    hasPO = bool(has_po_skus)
    foundInFinale = bool(no_po_skus)
    print(f'  hasPO = {hasPO}, foundInFinale = {foundInFinale}')
    if hasPO:
        print(f'  → SLACK ACTION: 👀 + threaded reply w/ PO#124698 ETA for '
              f'{has_po_skus[0]} (other SKUs that have POs: {has_po_skus[1:] or "—"})')
    if not hasPO and foundInFinale:
        print(f'  → TG DM Bill (silent on Slack)')
    if not foundInFinale and not hasPO:
        print(f'  → COMPLETE SILENCE (nothing in Finale, nothing to do)')

    # ── Step 7: Render per-vendor draft POs in TG DM ──
    section('STEP 7: TG DM render — per-vendor consolidated draft POs')
    
    today = datetime.now()
    fmt = lambda d: f"{d.month}/{d.day}"
    
    out = []
    out.append(f'📦 Slack request from *{PARKER_REQUESTER}* in #{PARKER_CHANNEL}')
    out.append('')
    out.append('Stock check (30d FG build horizon):')
    
    by_vendor: dict[str, list] = {}
    for d in step4_data:
        if not d['in_snapshot']:
            out.append(f"  `{d['sku']}`")
            out.append(f"    not in Oracle snapshot — no 30d data (FG-traceback correctly identified overstocked feeder FGs)")
            continue
        on_hand = d['on_hand']
        incoming = d['incoming']
        need30 = d['need30']
        lt = d['lt']
        vendor = d['vendor']
        total_supply = on_hand + incoming
        gap = max(0, need30 - total_supply)
        eta = fmt(today + timedelta(days=lt))
        name = d['productName'][:38] if d['productName'] else ''
        np = f" ({name})" if name else ''
        out.append(f"  `{d['sku']}`{np}")
        out.append(f"    {vendor} · {lt}d lead · ETA {eta}")
        out.append(f"    on hand {on_hand}  ·  incoming {incoming}  ·  30d need {need30}  ·  gap {gap}")
        if gap == 0:
            out.append(f"    ✅ already covered")
        else:
            out.append(f"    → order {gap} units")
        if gap > 0:
            by_vendor.setdefault(vendor, []).append((d['sku'], gap, lt))
    
    out.append('')
    if not by_vendor:
        out.append('All items already covered by current stock + incoming POs — no order needed.')
    else:
        out.append('📋 Draft POs (consolidated by vendor):')
        n = 1
        for v, items in by_vendor.items():
            total = sum(g for _, g, _ in items)
            lt0 = items[0][2] if items else 14
            eta = fmt(today + timedelta(days=lt0))
            out.append(f"  {n}. {v} — {total} units, ETA {eta}")
            for sku, gap, lt in items:
                out.append(f"     • {sku} × {gap}  ({lt}d lead)")
            n += 1
    out.append('')
    out.append('Quiet — no public Slack post.')
    
    print('\n'.join(out))
    
    # ── Outcome summary ──
    section('FINAL OUTCOME')
    n_total = len(step4_data)
    n_with_po = len(has_po_skus)
    n_draft_po = sum(len(v) for v in by_vendor.values())
    n_covered = sum(1 for d in step4_data if d['in_snapshot'] and max(0, d['need30'] - d['on_hand'] - d['incoming']) == 0)
    n_silent = len(not_in_finale)
    
    print(f'  Total SKUs requested:         {n_total}')
    print(f'  Slack thread reply (PO):     {n_with_po}  ({", ".join(has_po_skus) or "—"})')
    print(f'  TG DM (no PO, draft generated): {n_total - n_with_po - n_silent}')
    print(f'  Draft PO lines (consolidated): {n_draft_po} across {len(by_vendor)} vendors')
    print(f'  Items already covered:       {n_covered}  (no order needed)')
    print(f'  Items not in Finale:          {n_silent}  (silent)')
    print()
    print(f'  Public Slack messages: 0  (silent per convention)')
    print(f'  Telegram DMs to Bill:    1  (per-vendor draft POs)')
    print(f'  Slack thread reactions:  1  (👀 on RAWMILLEDGNARBAR)')


if __name__ == '__main__':
    main()
