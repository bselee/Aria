@echo off
REM aria-startup.bat — One-click recovery for WSL2 Docker + PM2 Aria stack
REM Does NOT restart containers in a loop. Does NOT reintroduce healthcheck.

echo [aria-startup] Restarting WSL2...
wsl --shutdown
timeout /t 8 /nobreak >nul

echo [aria-startup] Starting Docker...
wsl -d Ubuntu -u root bash -c "service docker start"
timeout /t 12 /nobreak >nul

echo [aria-startup] Starting Postgres...
wsl -d Ubuntu -u root bash -c "docker start aria-db || docker restart aria-db"
timeout /t 15 /nobreak >nul
wsl -d Ubuntu -u root bash -c "docker exec aria-db pg_isready -U aria"

echo [aria-startup] Starting PostgREST (wait for schema)...
wsl -d Ubuntu -u root bash -c "docker start aria-postgrest || docker restart aria-postgrest"
timeout /t 20 /nobreak >nul

echo [aria-startup] Waiting for PostgREST inside WSL...
wsl -d Ubuntu -u root bash -c "for i in 1 2 3 4 5 6 7 8 9 10; do code=$(curl -s -o /dev/null -w %%{http_code} --max-time 3 http://127.0.0.1:5434/); echo try $i code=$code; if [ \"$code\" = \"200\" ] || [ \"$code\" = \"503\" ]; then exit 0; fi; sleep 3; done; exit 0"

echo [aria-startup] Starting PM2 (proxy prefers healthy wslrelay; no container thrash)...
cd /d C:\Users\BuildASoil\Documents\Projects\aria
pm2 kill >nul 2>&1
timeout /t 3 /nobreak >nul
pm2 start ecosystem.config.json
timeout /t 25 /nobreak >nul
pm2 save --force >nul 2>&1

echo [aria-startup] Health:
curl -s -o nul -w "PostgREST HTTP %%{http_code}\n" --max-time 5 http://localhost:5434/
curl -s -o nul -w "Dashboard HTTP %%{http_code}\n" --max-time 5 http://localhost:3001/dashboard

echo [aria-startup] Done. Open http://localhost:3001/dashboard
