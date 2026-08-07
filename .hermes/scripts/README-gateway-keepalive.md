# Gateway keepalive (default profile)

**Live install path (what schtasks runs):**
`%LOCALAPPDATA%\hermes\scripts\gateway-keepalive.vbs`

**After editing the repo copy, install:**
```bat
copy /Y .hermes\scripts\gateway-keepalive.vbs %LOCALAPPDATA%\hermes\scripts\
copy /Y .hermes\scripts\gateway-health-check.py %LOCALAPPDATA%\hermes\scripts\
copy /Y .hermes\scripts\gateway-keepalive-check.py %LOCALAPPDATA%\hermes\scripts\
```

**Verify (no side effects):**
```bat
python %LOCALAPPDATA%\hermes\scripts\gateway-keepalive-check.py
```

**2026-08-07 fix:** probe uses TCP :8642 OR any non-hermia `gateway run` process.
Old probe required `hermes_cli.main` and missed live `hermes.exe gateway run`.
