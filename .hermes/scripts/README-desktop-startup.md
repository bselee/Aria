# Hermes Desktop launcher + reaper (startup hardening)

**Live install paths (what actually runs):**
- `%USERPROFILE%\Desktop\Hermes-Desktop.vbs` — canonical launcher (double-click, Startup task, Start Menu redirects)
- `%LOCALAPPDATA%\hermes\scripts\hermes-pf-desktop-reaper.py` — 10-minute backstop cron that reaps the stale Program Files build
- `%LOCALAPPDATA%\hermes\scripts\repoint-hermes-shortcuts.ps1` — repoints both Start Menu tiles at the VBS (one-time; ProgramData tile needs admin)

**After editing the repo copy, install:**
```bat
copy /Y .hermes\scripts\Hermes-Desktop.vbs %USERPROFILE%\Desktop\
copy /Y .hermes\scripts\hermes-pf-desktop-reaper.py %LOCALAPPDATA%\hermes\scripts\
copy /Y .hermes\scripts\repoint-hermes-shortcuts.ps1 %LOCALAPPDATA%\hermes\scripts\
```

**Verify (no side effects):**
```bat
python -c "import ast; ast.parse(open(r'%LOCALAPPDATA%\hermes\scripts\hermes-pf-desktop-reaper.py').read())"
```

## Symptom

Clicking Hermes Desktop opens TWO windows. One shows "setting up" then stops; the other loads and claims ready, but the Pinned sidebar section is EMPTY. Recurred every morning across multiple prior "fixes".

## Root cause

A stale packaged install at `C:\Program Files\Hermes` (built 2026-06-04, commit de370fd1) was being launched — sometimes with `--profile hermia`. Three compounding failures:

- **(a) Fixed port 9120.** The stale build pins its backend to port 9120, so two racing instances collide:
  ```
  ERROR: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 9120)
  Hermes backend exited (1)
  ```
  That is the "setting up" window that dies. The current build uses `serve --port 0` (ephemeral port), so instances never collide on the port.
- **(b) Predates pin-sync.** Commits 99ffea6d0 / 8ce8b70dc / 090d14647 (2026-07-31) made pins durable in state.db. The stale asar contains ZERO occurrences of `setSessionPinnedRemote` and `pullRemotePins`, so it can only read pins from localStorage key `hermes.desktop.pinnedSessions` — which current builds no longer write. Result: empty Pinned section even though state.db held 13 pinned rows.
- **(c) `--profile hermia`.** Points at `profiles\hermia\state.db`, which has 0 sessions.

The correct build: `%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe`, launched via `Desktop\Hermes-Desktop.vbs` with NO `--profile` (default HERMES_HOME).

## Key fact: pins live in state.db, not LevelDB

Since 2026-07-31, pins are durable in `%LOCALAPPDATA%\hermes\state.db` -> `sessions.pinned`. Read-only check:

```python
import os, sqlite3
db = os.path.join(os.environ['LOCALAPPDATA'], 'hermes', 'state.db').replace('\\', '/')
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
print(con.execute('select count(*) from sessions where pinned=1').fetchone()[0])
```

Note: the `sessions` table has no `updated_at` / `created_at` column — order by `COALESCE(ended_at, started_at)`.

## The fixes

1. **Single-instance lock.** `%LOCALAPPDATA%\hermes\desktop-launch.lock` serializes near-simultaneous launches (logon task + click). Stale locks (>120s) are ignored so a crash can't wedge the launcher permanently.
2. **Active reap of any Program Files Hermes tree.** Matches only the resolved ExecutablePath under `C:\Program Files\Hermes`. NEVER image-wide — `taskkill /IM Hermes.exe` would kill the active CLI and the real Desktop. The venv CLI (`...\hermes-agent\venv\Scripts\hermes.exe`) and the win-unpacked Desktop are explicitly out of scope.
3. **Treat ANY packaged Hermes.exe as already up.** The "already running" check now covers Program Files installs too (was win-unpacked only — which is how a second racing instance got added on top of a Program Files one).
4. **Kill only LISTENING owners of port 9120.** The old loop also parsed TIME_WAIT rows whose last column is `0` and ran `taskkill /PID 0`.

## One launcher rule

`Desktop\Hermes-Desktop.vbs` is canonical. `Desktop\Hermes-Desktop.bat`, `Startup\hermes-desktop-launch.vbs`, and the Start Menu `Hermes.lnk` are THIN REDIRECTS to it. The Startup copy had drifted into a stale FULL COPY running different logic from double-click — that is how a second racing instance got introduced. Never paste launch logic back into a redirect.

## Resolved 2026-08-10: the stale build is GONE

`C:\Program Files\Hermes` (374 MB), the all-users Start Menu tile, and the
Add/Remove Programs entry were all removed. The root cause is now physically
unlaunchable rather than merely guarded.

**Removed manually via `remove-pf-hermes-install.ps1` — NOT via the bundled
NSIS uninstaller.** That was deliberate:

- `Uninstall Hermes.exe` is NSIS/electron-builder, and those close the running
  app **by exe name**. Three separate binaries here are all named
  `Hermes.exe` / `hermes.exe`: the Program Files build, the win-unpacked
  Desktop, and the venv CLI (`hermes-agent\venv\Scripts\hermes.exe`). A
  kill-by-name step would have taken down the live Desktop and the active agent
  session.
- It may also delete the shared Electron userData dir `%APPDATA%\Hermes`, which
  the GOOD build uses for window state, composer prefs, and localStorage.

Nothing outside the install dir depended on it — verified before removal:
HKLM `App Paths` 0 matches; the `hermes://` handler already pointed at the
win-unpacked build; agent home / state.db / config / skills / cron all live
under `%LOCALAPPDATA%\hermes`.

Pre-removal backup: `%LOCALAPPDATA%\hermes\backups\20260810-preuninstall\`
(full userData copy — 307 files, only caches and zero-byte LOCK files skipped;
exported uninstall registry key; 13-pin manifest).

Verified after: install dir / machine tile / ARP entry all absent, 5
win-unpacked Desktop processes alive, CLI alive, 13 pins intact, reaper silent
with exit 0 on the now-clean machine.

The reaper cron stays as a cheap backstop in case the package is ever
reinstalled.

---

**NOTE:** these repo copies are MIRRORS for reference. The live copies are the ones on Desktop and in `%LOCALAPPDATA%\hermes\scripts`.

**2026-08-10 (Hermia):** root cause above; launcher now has single-instance lock + Program Files reap + packaged-exe "already up" check + LISTENING-only port cleanup; reaper cron deployed; per-user Start Menu tile repointed.
