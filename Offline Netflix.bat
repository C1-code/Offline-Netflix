@echo off
title Offline Netflix
setlocal enabledelayedexpansion

REM ---------------------------------------------------------------------------
REM One-file launcher, safe on a fresh "git clone" double-click.
REM  - Locates the repo from its own folder (no hardcoded paths). A copy on
REM    the Desktop falls back to the default WSL clone path ~/offline-netflix.
REM  - First run: bootstraps Node, ffmpeg, npm deps and config inside WSL in a
REM    visible window (tools/first-run.sh — no sudo needed).
REM  - Every run: (re)starts the server and opens the browser at :8420.
REM The minimized window STAYS OPEN on purpose: it keeps the WSL session (and
REM therefore the server) alive. Closing it stops the server.
REM ---------------------------------------------------------------------------

REM WSL must exist before anything else can run
wsl.exe -e true >nul 2>&1
if errorlevel 1 (
  echo WSL is not installed or not ready yet. One-time setup:
  echo   1. Open PowerShell as Administrator and run:  wsl --install
  echo   2. Reboot, then double-click this file again.
  pause
  exit /b 1
)

REM Locate the repo. If this .bat lives in the repo root, convert its own
REM folder to a WSL path. The dummy name avoids trailing-backslash quirks with
REM %~dp0 and is unique enough that stripping it can't hit a real segment.
set "REPO="
if exist "%~dp0server.js" (
  for /f "usebackq delims=" %%i in (`wsl.exe -e wslpath -a "%~dp0ZZDUMMYZZ" 2^>nul`) do set "REPO=%%i"
  set "REPO=!REPO:/ZZDUMMYZZ=!"
) else (
  for /f "usebackq delims=" %%i in (`wsl.exe -e bash -c "echo $HOME/offline-netflix" 2^>nul`) do set "REPO=%%i"
  wsl.exe -e test -f "!REPO!/server.js" >nul 2>&1
  if errorlevel 1 set "REPO="
)
if not defined REPO (
  echo Could not find the offline-netflix repo.
  echo Either keep this .bat in the cloned repo folder, or edit the fallback
  echo path inside this file to where the repo lives in WSL.
  pause
  exit /b 1
)

REM First run? Do the bootstrap in THIS visible window so progress and any
REM download output can be followed.
wsl.exe -e test -f "%REPO%/data/.first-run-done" >nul 2>&1
if errorlevel 1 (
  echo First run: setting up Node, ffmpeg and dependencies inside WSL.
  echo Downloads a few hundred MB once and can take several minutes...
  echo.
  wsl.exe -e bash -c "cd '!REPO!' && ./tools/first-run.sh"
  if errorlevel 1 (
    echo.
    echo Setup failed - scroll up for the reason, then double-click again.
    pause
    exit /b 1
  )
)

REM (Re)launch the server in a persistent minimized WSL session. start.sh
REM stops the previous instance first, so config/code changes take effect.
start "Offline Netflix server" /min wsl.exe -e bash -c "cd '!REPO!' && ./start.sh; exec sleep infinity"

REM Wait until the server actually answers, then open the browser
set /a tries=0
:wait
curl -s -o nul http://localhost:8420/api/health >nul 2>&1
if not errorlevel 1 goto open
set /a tries+=1
if !tries! geq 40 (
  echo.
  echo Server did not start within 40s. To see why, run:
  echo   wsl.exe -e bash -c "tail -20 '!REPO!'/data/server.log"
  pause
  exit /b 1
)
timeout /t 1 >nul
goto wait

:open
start "" http://localhost:8420
exit /b 0
