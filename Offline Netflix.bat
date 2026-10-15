@echo off
title Offline Netflix
setlocal enabledelayedexpansion

REM (Re)launch the server inside WSL: each run stops the previous instance and
REM starts the current code, so feature/config changes take effect immediately.
REM The minimized window STAYS OPEN on purpose: it keeps the WSL session
REM (and therefore the server) alive. Closing that window stops the server.
start "Offline Netflix server" /min wsl.exe -e bash -c "cd /home/elias/offline-netflix && ./start.sh; exec sleep infinity"

REM Wait until the server actually answers, then open the browser
set /a tries=0
:wait
curl -s -o nul http://localhost:8420/api/health >nul 2>&1
if not errorlevel 1 goto open
set /a tries+=1
if !tries! geq 40 (
  echo.
  echo Server did not start within 40s. To see why, run:
  echo   wsl -e bash -c "tail -20 /home/elias/offline-netflix/data/server.log"
  pause
  exit /b 1
)
timeout /t 1 >nul
goto wait

:open
start "" http://localhost:8420
exit /b 0
