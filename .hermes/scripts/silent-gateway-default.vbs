' silent-gateway-default.vbs — launch the DEFAULT-profile Hermes gateway with no console.
'
' WHY (2026-08-06, Hermia):
'   Hermes_Gateway.cmd ran `python.exe -m hermes_cli.main gateway run` in the
'   FOREGROUND. Because the Scheduled Task has no <Hidden>true</Hidden>, that
'   console window opens at logon and STAYS OPEN for the gateway's entire life.
'   The hermia twin already solved this by handing off to a VBS + pythonw; this
'   is the same proven pattern applied to the default profile.
'
' KEY DIFFERENCES FROM THE HERMIA VERSION:
'   - HERMES_HOME points at the DEFAULT home (no \profiles\hermia)
'   - NO --profile flag. The default profile owns all 16 cron jobs; passing
'     --profile would point the gateway at the wrong jobs.json and state.db.
'   - Sets PYTHONPATH like the original .cmd did (hermia's VBS omits it).
'
' pythonw.exe has no console subsystem at all, so window style 0 is belt-and-braces.
Option Explicit
Dim shell, envHome, agentRoot, pythonw, cmd

Set shell = CreateObject("WScript.Shell")

envHome   = "C:\Users\BuildASoil\AppData\Local\hermes"
agentRoot = envHome & "\hermes-agent"
pythonw   = agentRoot & "\venv\Scripts\pythonw.exe"

shell.Environment("Process")("HERMES_HOME") = envHome
shell.Environment("Process")("PYTHONIOENCODING") = "utf-8"
shell.Environment("Process")("HERMES_GATEWAY_DETACHED") = "1"
shell.Environment("Process")("VIRTUAL_ENV") = agentRoot & "\venv"
shell.Environment("Process")("PYTHONPATH") = agentRoot
' Explicitly clear any inherited profile override so we stay on default.
shell.Environment("Process")("HERMES_PROFILE") = ""

cmd = Chr(34) & pythonw & Chr(34) & " -m hermes_cli.main gateway run"
shell.CurrentDirectory = envHome
shell.Run cmd, 0, False
