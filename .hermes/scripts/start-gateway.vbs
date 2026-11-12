' start-gateway.vbs — THE canonical hidden launcher for the default Hermes gateway.
'
' @file    start-gateway.vbs
' @purpose Start `hermes_cli.main gateway run` with no console window, resolving the
'          managed Python dynamically so it survives interpreter version bumps.
' @author  Hermia
' @created 2026-11-12
' @deps    %LOCALAPPDATA%\hermes\hermes-agent (checkout), tools\python-* or venv python
' @env     HERMES_HOME pinned here so a parent profile (hermia) can never leak in.
'
' Callers: scripts\hermes_gateway_ctl.py (ensure/start/restart) and anything manual.
' It is a launcher only — it never probes, kills, or retries. All policy lives in
' hermes_gateway_ctl.py so there is exactly one place that decides.
'
' Replaces: silent-gateway.vbs, silent-gateway-default.vbs, Hermes_Gateway.cmd,
' hermes-desktop-launch.vbs copies, and the Scheduled Task action — all deleted 2026-11-12
' because four launchers meant four different launch semantics (one foreground console,
' two hardcoded interpreter paths, one wrong profile).
'
' NOTE: `hermes update` regenerates gateway-service\Hermes_Gateway.cmd/.vbs when a
' gateway task/Startup entry exists. It does NOT touch start-gateway.vbs, and with the
' logon task uninstalled it no longer regenerates anything at all.
Option Explicit

Dim fso, sh, env, home, py, agentRoot, folder, candidate, bestName, cmd

home = "C:\Users\BuildASoil\AppData\Local\hermes"
agentRoot = home & "\hermes-agent"

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("PROCESS")

' --- Resolve Python: newest managed tools\python-\python.exe, else the agent venv ---
py = ""
bestName = ""
If fso.FolderExists(home & "\tools") Then
  For Each folder In fso.GetFolder(home & "\tools").SubFolders
    If fso.FileExists(folder.Path & "\python.exe") Then
      ' Lexicographic compare picks python-3.14.9 over python-3.14.7.
      If folder.Name > bestName Then
        bestName = folder.Name
        py = folder.Path & "\python.exe"
      End If
    End If
  Next
End If
If Len(py) = 0 Then
  candidate = agentRoot & "\venv\Scripts\python.exe"
  If fso.FileExists(candidate) Then py = candidate
End If
If Len(py) = 0 Then
  MsgBox "Hermes gateway cannot start: no Python interpreter found under" & vbCrLf & _
         home & "\tools or " & agentRoot & "\venv", 16, "Hermes Gateway"
  WScript.Quit 1
End If

' --- Environment: fixed HERMES_HOME, agent checkout first on PYTHONPATH ---
env.Item("HERMES_HOME") = home
env.Item("PYTHONIOENCODING") = "utf-8"
env.Item("HERMES_GATEWAY_DETACHED") = "1"
env.Item("HERMES_SUPERVISED_CHILD") = "1"
env.Item("VIRTUAL_ENV") = home & "\tools"
Dim existing_pp
existing_pp = env.Item("PYTHONPATH")
If Len(existing_pp) > 0 Then
  env.Item("PYTHONPATH") = agentRoot & ";" & existing_pp
Else
  env.Item("PYTHONPATH") = agentRoot
End If

sh.CurrentDirectory = home
cmd = Chr(34) & py & Chr(34) & " -m hermes_cli.main gateway run"

' Dry-run switch: resolve everything, write the exact command, launch nothing. Used by
' scripts\hermes_gateway_ctl.py verification and by hand when checking interpreter drift.
If env.Item("HERMES_GATEWAY_LAUNCH_DRYRUN") = "1" Then
  Dim dryFile
  dryFile = home & "\logs\gateway-launch-dryrun.txt"
  Dim stream
  Set stream = fso.CreateTextFile(dryFile, True)
  stream.WriteLine "python=" & py
  stream.WriteLine "command=" & cmd
  stream.WriteLine "home=" & home
  stream.Close
  WScript.Quit 0
End If

' 0 = hidden window, False = do not wait (the gateway outlives this launcher).
sh.Run cmd, 0, False
