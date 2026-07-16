@echo off
REM aria-startup.bat — Run as Administrator on Windows login to fix WSL2 + Docker + PM2
REM Place in: C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\aria-startup.bat

echo [aria-startup] Starting WSL2...
wsl --shutdown
timeout /t 5 /nobreak >nul

echo [aria-startup] Starting Docker inside WSL2...
wsl -d Ubuntu -u root bash -c "service docker start"
timeout /t 10 /nobreak >nul

echo [aria-startup] Restarting Docker containers in order...
wsl -d Ubuntu -u root bash -c "docker restart aria-db"
timeout /t 15 /nobreak >nul
wsl -d Ubuntu -u root bash -c "docker restart aria-postgrest"
timeout /t 15 /nobreak >nul

echo [aria-startup] Starting PM2 processes...
cd /d C:\Users\BuildASoil\Documents\Projects\aria
pm2 kill >nul 2>&1
timeout /t 3 /nobreak >nul
pm2 start ecosystem.config.json
timeout /t 15 /nobreak >nul
pm2 save --force >nul 2>&1

echo [aria-startup] Done. Dashboard should be available at http://localhost:3001/dashboard
