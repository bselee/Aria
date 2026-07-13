@echo off
:: hermes-desktop-launch.bat — clean Desktop start
:: NEVER use C:\Program Files\Hermes (bootstraps + bricks live venv on Windows).
:: Desktop uses DEFAULT HERMES_HOME (no --profile hermia) so pins/TUI history show.
:: Cron sole live schedule is DEFAULT gateway (not hermia profile clones).

setlocal
set HERMES_HOME=C:\Users\BuildASoil\AppData\Local\hermes
set HERMES_PYW=%HERMES_HOME%\hermes-agent\venv\Scripts\pythonw.exe
set HERMES_EXE=%HERMES_HOME%\hermes-agent\venv\Scripts\hermes.exe
set ARIA_DIR=C:\Users\BuildASoil\Documents\Projects\aria

:: HARD RULE: never taskkill Hermes/terminal processes from this launcher.
:: If :9120 already answers, exit quietly so live CLI sessions stay up.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:9120/ -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  endlocal
  exit /b 0
)

:: Keep Aria services alive (silent)
if exist "%ARIA_DIR%\aria-launcher.py" (
  start "" /b pythonw "%ARIA_DIR%\aria-launcher.py"
)

:: Launch desktop via skip-build (no venv rebuild, no hermia profile)
if exist "%HERMES_PYW%" (
  start "" /b "%HERMES_PYW%" -m hermes_cli.main desktop --skip-build
) else if exist "%HERMES_EXE%" (
  start "" /b "%HERMES_EXE%" desktop --skip-build
) else (
  echo Hermes not found. Expected %HERMES_EXE%
  exit /b 1
)

endlocal
exit /b 0
