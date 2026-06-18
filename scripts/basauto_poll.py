#!/usr/bin/env python3
"""basauto_poll.py - Poll basauto.vercel.app for pending purchase requests."""
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
import requests

PROJECT_DIR  = Path(__file__).resolve().parent.parent
SESSION_FILE = PROJECT_DIR / ".basauto-session.json"
CACHE_DIR    = Path.home() / "AppData" / "Local" / "hermes" / "cache" / "basauto"
SNAPSHOT_FILE = CACHE_DIR / "latest-snapshot.json"
PREV_FILE     = CACHE_DIR / "prev-snapshot.json"
SEEN_FILE     = CACHE_DIR / "seen-request-ids.json"
BASE_URL     = "https://basauto.vercel.app"
TG_BOT = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")


def tg(text: str) -> bool:
    if not TG_BOT or not TG_CHAT: return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{TG_BOT}/sendMessage",
                         json={"chat_id": TG_CHAT, "text": text}, timeout=15)
        return r.status_code == 200 and r.json().get("ok")
    except Exception as e:
        print(f"  [tg] error: {e}"); return False

def load_session():
    if not SESSION_FILE.exists(): return None
    try:
        raw = json.loads(SESSION_FILE.read_text("utf-8"))
        if isinstance(raw, dict) and "cookies" in raw: return raw
        if isinstance(raw, list): return {"cookies": raw}
    except: pass
    return None

def cookie_str(s):
    return "; ".join(c["name"] + "=" + c["value"] for c in s.get("cookies", []))

def check_alive(session):
    import requests as r
    try:
        resp = r.get(BASE_URL + '/purchases',
                     headers={'Cookie': '; '.join(f"{c['name']}={c['value']}" for c in session.get('cookies',[])),
                              'Accept': 'text/html', 'User-Agent': 'aria-poll/1.0'},
                     allow_redirects=True, timeout=30)
        html = resp.text[:3000].lower()
        return 'signin' not in html and 'sign in' not in html
    except Exception as e:
        print(f'  [auth] error: {e}')
        return False

def load_snapshot():
    if SNAPSHOT_FILE.exists():
        return json.loads(SNAPSHOT_FILE.read_text('utf-8'))
    return None

def fmt(req):
    d = req.get('department') or '?'
    rt = (req.get('requestType') or '').lower()
    if rt == 'existing' and req.get('existingProduct'):
        ep = req['existingProduct']
        return f"{d} wants {ep.get('lookup','?')} - {ep.get('description','?')}"
    if rt == 'new' and req.get('newProduct'):
        np = req['newProduct']
        s = f"{d} wants: {np.get('title','?')}"
        if np.get('reason'): s += f" ({np['reason'][:80]})"
        return s
    return f"{d}: {req.get('title') or req.get('description') or '?'}"

def tg(msg):
    if not TG_BOT or not TG_CHAT: return
    try:
        requests.post(f"https://api.telegram.org/bot{TG_BOT}/sendMessage",
                      json={'chat_id': TG_CHAT, 'text': msg}, timeout=15)
    except: pass

def main():
    print(f'=== BASAUTO Poll === time={datetime.now(timezone.utc).isoformat()}')
    session = load_session()
    if not session:
        print('ERROR: No .basauto-session.json')
        tg('BASAUTO poll: No session file.')
        return 1
    alive = check_alive(session)
    if not alive:
        print('SESSION EXPIRED')
        tg('BASAUTO session expired. Refresh .basauto-session.json from Chrome DevTools.')
        snap = load_snapshot()
        if snap:
            reqs = snap.get('requests', [])
            pending = [r for r in reqs if (r.get('status') or '').lower() == 'pending']
            print(f'Cached snapshot ({snap.get("_poll_timestamp","?")}): {len(reqs)} total, {len(pending)} pending')
            for r in pending:
                print(f'  {fmt(r)}')
        else:
            print('No cached snapshot.')
        return 0
    print('Session ALIVE')
    return 0

if __name__ == '__main__':
    sys.exit(main())
