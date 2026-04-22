@echo off
REM chrome-cdp.bat — Launch Chrome with CDP enabled
REM Put this on your Desktop or pin to taskbar for daily use
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="C:\Users\BuildASoil\AppData\Local\Google\Chrome\User Data"
