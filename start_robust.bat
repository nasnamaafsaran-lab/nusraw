@echo off
title System Server - DO NOT CLOSE
cd /d "%~dp0"

:loop
echo Starting System...
call npm run dev
echo Server stopped unexpectedly. Restarting in 5 seconds...
timeout /t 5
goto loop
