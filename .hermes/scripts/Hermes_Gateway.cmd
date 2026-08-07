@echo off
rem Hermes Agent Gateway - DEFAULT profile (owns all cron jobs)
rem
rem 2026-08-06 (Hermia): was running python.exe in the FOREGROUND, which left a
rem console window open at logon for the gateway's entire life (the Scheduled
rem Task has no <Hidden>true</Hidden>). Now hands off to a silent VBS + pythonw
rem and exits immediately -- the same pattern already proven on the hermia twin.
rem Original preserved as Hermes_Gateway.cmd.bak-20260806.
wscript.exe //nologo "C:\Users\BuildASoil\AppData\Local\hermes\gateway-service\silent-gateway-default.vbs"
exit /b 0
