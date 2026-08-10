' Hermes-Desktop.vbs — canonical, single-instance silent launcher for Desktop GUI.
'
' THE ONLY launcher. Desktop\Hermes-Desktop.bat, Startup\hermes-desktop-launch.vbs
' and the Start Menu Hermes.lnk are all thin redirects to this file. Keep it that
' way: duplicated full copies drift (the Startup copy was a stale Aug-5 variant
' that had lost the releaseReady/buildFlag logic).
'
' IMPORTANT: Desktop must use DEFAULT HERMES_HOME (Local\hermes), NOT profile hermia.
' User pins + TUI history live in the DEFAULT state.db. hermia's state.db has 0
' sessions, so launching with --profile hermia shows an EMPTY sidebar and NO pins.
' Gateway/cron stay on hermia via their own scheduled task; Desktop is the
' default-profile viewer.
'
' 2026-07-14: Do NOT health-gate on :9120 alone. That port is often the standalone
' `hermes dashboard` process, which is NOT Desktop Electron. False positive caused
' VBS to exit without launching Desktop while Program Files Hermes tried bootstrap.
'
' 2026-08-10 (Hermia) — ROOT CAUSE OF THE RECURRING MORNING FAILURE:
'   Symptom: two windows open, one says "setting up" and dies, the other loads
'   "ready" but the sidebar has NO pinned sessions.
'   Cause: the OLD Jun-4 packaged build at C:\Program Files\Hermes was being
'   launched (ProgramData Start Menu tile / stale shortcut) WITH --profile hermia.
'     * It pins its backend to FIXED port 9120. Two racing instances both try to
'       bind 9120 -> "[Errno 10048] ... only one usage of each socket address",
'       "Hermes backend exited (1)" -> that's the window that dies "setting up".
'     * It predates the pin-sync work (commits 99ffea6d0 / 8ce8b70dc / 090d14647,
'       Jul 31), so it CANNOT read pins from state.db (sessions.pinned). It only
'       reads localStorage 'hermes.desktop.pinnedSessions', which no longer exists
'       in the LevelDB -> sidebar renders zero pins even though state.db holds 13.
'     * --profile hermia compounded it by pointing at an empty state.db.
'   Fixes here:
'     1. Treat ANY packaged Hermes.exe as "already up" (was: win-unpacked only),
'        so we can never add a second racing instance.
'     2. Actively reap a Program Files\Hermes tree — it must never own the desktop.
'     3. A lock file serialises near-simultaneous launches (logon task + click).
'     4. Port cleanup only kills LISTENING owners (the old loop also parsed
'        TIME_WAIT rows whose last column is "0" and ran taskkill /PID 0).
Option Explicit
Dim shell, fso, hermes, pythonw, ariaDir, cmd, envHome, agentRoot, unpackedExe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

envHome = "C:\Users\BuildASoil\AppData\Local\hermes"
agentRoot = envHome & "\hermes-agent"
hermes = agentRoot & "\venv\Scripts\hermes.exe"
pythonw = agentRoot & "\venv\Scripts\pythonw.exe"
unpackedExe = agentRoot & "\apps\desktop\release\win-unpacked\Hermes.exe"
ariaDir = "C:\Users\BuildASoil\Documents\Projects\aria"

' Pin default home so a parent hermia session cannot leak HERMES_HOME into Desktop
shell.Environment("Process")("HERMES_HOME") = envHome
' Clear profile override if present in process env
shell.Environment("Process")("HERMES_PROFILE") = ""

' --- Single-instance lock -------------------------------------------------
' The logon task and a desktop double-click can fire within the same second.
' Whoever creates the lock wins; the loser exits. Stale locks (>120s) are
' ignored so a crash can't wedge the launcher permanently.
Dim lockPath, lockAgeOk, f
lockPath = envHome & "\desktop-launch.lock"
lockAgeOk = True
On Error Resume Next
If fso.FileExists(lockPath) Then
  If DateDiff("s", fso.GetFile(lockPath).DateLastModified, Now) < 120 Then
    lockAgeOk = False
  End If
End If
Err.Clear
On Error GoTo 0
If Not lockAgeOk Then
  WScript.Quit 0
End If
On Error Resume Next
Set f = fso.CreateTextFile(lockPath, True)
f.WriteLine "launch " & Now
f.Close
Err.Clear
On Error GoTo 0
' --- End single-instance lock --------------------------------------------

' --- Reap the Program Files build ---------------------------------------
' It is the WRONG build (Jun 4, pre pin-sync, fixed port 9120). It must never
' own the desktop. Killing it here is safe and targeted: we match on the
' executable path, never image-wide, so the CLI/venv hermes.exe is untouched.
Dim wmi, procs, proc, exePath, pfFound
pfFound = False
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Not wmi Is Nothing Then
  Set procs = wmi.ExecQuery("SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'Hermes.exe' OR Name = 'hermes.exe'")
  For Each proc In procs
    exePath = LCase(CStr(proc.ExecutablePath & ""))
    If InStr(exePath, "\program files\hermes\") > 0 Then
      shell.Run "taskkill /PID " & proc.ProcessId & " /T /F", 0, True
      pfFound = True
    End If
  Next
End If
Err.Clear
On Error GoTo 0
If pfFound Then
  shell.Run "cmd /c timeout /t 2 /nobreak >nul", 0, True
End If
' --- End Program Files reap ---------------------------------------------

' --- Port 9120 stale-process cleanup ---
' If a prior hermes serve/dashboard child survived Desktop close, it holds port
' 9120 and blocks the next launch. Kill only LISTENING owners.
Dim exec, netstatOut, lines, ln, parts, pidStr, killed
killed = False
On Error Resume Next
Set exec = shell.Exec("cmd /c netstat -ano 2>nul | findstr LISTENING | findstr :9120")
netstatOut = exec.StdOut.ReadAll()
If Len(netstatOut) > 0 Then
  lines = Split(netstatOut, vbCrLf)
  For Each ln In lines
    ln = Trim(ln)
    If Len(ln) > 0 Then
      parts = Split(ln)
      pidStr = parts(UBound(parts))
      If IsNumeric(pidStr) Then
        If CLng(pidStr) > 4 Then
          shell.Run "taskkill /PID " & CLng(pidStr) & " /F", 0, True
          killed = True
        End If
      End If
    End If
  Next
End If
Err.Clear
On Error GoTo 0
If killed Then
  shell.Run "cmd /c timeout /t 1 /nobreak >nul", 0, True
End If
' --- End port cleanup ---

' HARD RULE: never taskkill Hermes/terminal processes image-wide from this
' launcher. Skip launch if ANY packaged Desktop Electron is already running.
' (Was win-unpacked only, which is how a second racing instance got added on
' top of a Program Files one.)
Dim alreadyUp
alreadyUp = False
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Not wmi Is Nothing Then
  Set procs = wmi.ExecQuery("SELECT ExecutablePath FROM Win32_Process WHERE Name = 'Hermes.exe'")
  For Each proc In procs
    exePath = LCase(CStr(proc.ExecutablePath & ""))
    If InStr(exePath, "\apps\desktop\release\win-unpacked\hermes.exe") > 0 Then
      alreadyUp = True
      Exit For
    End If
  Next
End If
Err.Clear
On Error GoTo 0
If alreadyUp Then
  WScript.Quit 0
End If

' Optional: keep Aria services alive (silent)
If fso.FileExists(ariaDir & "\aria-launcher.py") Then
  shell.Run "pythonw.exe " & Chr(34) & ariaDir & "\aria-launcher.py" & Chr(34), 0, False
End If

' Check if packaged release exists. If not, drop --skip-build so it gets built.
Dim releaseReady, buildFlag
releaseReady = fso.FileExists(unpackedExe)
If releaseReady Then
  buildFlag = " --skip-build"
Else
  buildFlag = ""
End If

' Prefer hermes CLI WITHOUT --profile so Desktop sees default sessions/pins
If fso.FileExists(pythonw) Then
  cmd = Chr(34) & pythonw & Chr(34) & " -m hermes_cli.main desktop" & buildFlag
  shell.CurrentDirectory = envHome
  shell.Run cmd, 0, False
ElseIf fso.FileExists(hermes) Then
  cmd = Chr(34) & hermes & Chr(34) & " desktop" & buildFlag
  shell.CurrentDirectory = envHome
  shell.Run cmd, 0, False
ElseIf fso.FileExists(unpackedExe) Then
  shell.CurrentDirectory = envHome
  shell.Run Chr(34) & unpackedExe & Chr(34), 1, False
Else
  MsgBox "Hermes not found. Expected:" & vbCrLf & hermes, 16, "Hermes Desktop"
End If
