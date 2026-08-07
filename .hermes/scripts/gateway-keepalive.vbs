' gateway-keepalive.vbs — ensure DEFAULT Hermes gateway is running.
'
' WHY: Desktop/logon starts the gateway, but unclean deaths (reboot, SIGKILL,
' session teardown) leave :8642 dead until next logon. Cron cannot revive the
' gateway — cron lives ON the gateway. This task is outside Hermes (schtasks
' every 30 min).
'
' BUG FIXED 2026-08-07 (Hermia):
'   Old probe required cmdline to contain BOTH "hermes_cli.main" AND "gateway run"
'   and excluded "hermia". Live default often launches as:
'       ...\python.exe ...\hermes.exe gateway run --accept-hooks
'   which has NO "hermes_cli.main" string → keepalive always thought default was
'   down → repeated Hermes_Gateway.cmd launches → SystemExit 78 port conflicts.
'
' DETECT (any one is enough):
'   1. TCP 127.0.0.1:8642 accepts a connect (authoritative — api_server bind)
'   2. A non-hermia python/hermes process whose cmdline contains "gateway run"
'
' START only if both fail. Launch path: gateway-service\Hermes_Gateway.cmd
' (hands off to silent-gateway-default.vbs + pythonw -m hermes_cli.main).
'
' Idempotent. No console. No focus steal.
'
' 2026-08-06 initial · 2026-08-07 probe fix

Option Explicit
Dim shell, wmi, procs, proc, cmdline, foundGateway, gatewayCmd
Dim sock, connected

Const GATEWAY_PORT = 8642

Set shell = CreateObject("WScript.Shell")
foundGateway = False
connected = False

' --- 1) Port probe (fast, matches any launch shape that bound api_server) ---
On Error Resume Next
Set sock = CreateObject("MSWinsock.Winsock")
' MSWinsock may be unavailable — fall through to raw ADODB-free TCP via PowerShell-less approach
Err.Clear
On Error GoTo 0

If Not PortOpen(GATEWAY_PORT) Then
  foundGateway = False
Else
  foundGateway = True
End If

' --- 2) Process probe if port check inconclusive/false ---
If Not foundGateway Then
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  If Not wmi Is Nothing Then
    Set procs = wmi.ExecQuery( _
      "SELECT CommandLine, Name FROM Win32_Process " & _
      "WHERE Name = 'python.exe' OR Name = 'pythonw.exe' OR Name = 'hermes.exe'")
    For Each proc In procs
      cmdline = LCase(CStr(proc.CommandLine & ""))
      ' Default gateway only — never treat hermia profile as the cron owner
      If InStr(cmdline, "hermia") = 0 Then
        If InStr(cmdline, "gateway run") > 0 Then
          foundGateway = True
          Exit For
        End If
        ' hermes_cli.main without literal "gateway run" still counts if gateway subcmd present
        If InStr(cmdline, "hermes_cli.main") > 0 And InStr(cmdline, "gateway") > 0 _
           And InStr(cmdline, "desktop") = 0 And InStr(cmdline, "serve") = 0 Then
          foundGateway = True
          Exit For
        End If
      End If
    Next
  End If
  Err.Clear
  On Error GoTo 0
End If

If foundGateway Then
  WScript.Quit 0
End If

' No gateway — start default profile hidden
gatewayCmd = "C:\Users\BuildASoil\AppData\Local\hermes\gateway-service\Hermes_Gateway.cmd"
shell.Run Chr(34) & gatewayCmd & Chr(34), 0, False
WScript.Quit 0

' --- helpers ---
Function PortOpen(port)
  ' Use PowerShell TcpClient — no Winsock OCX dependency on modern Windows.
  Dim ps, rc
  PortOpen = False
  On Error Resume Next
  ps = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command " & _
       """$c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1'," & port & "); " & _
       "if($c.Connected){exit 0}else{exit 1} } catch { exit 1 } finally { if($c){$c.Close()} }"""
  rc = shell.Run(ps, 0, True)
  If rc = 0 Then PortOpen = True
  Err.Clear
  On Error GoTo 0
End Function
