@echo off
title Offline Netflix
wsl.exe -e bash -lc "cd /home/elias/offline-netflix && ./start.sh"
timeout /t 1 >nul
start "" http://localhost:8420
exit
