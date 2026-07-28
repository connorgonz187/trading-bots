@echo off
REM Bot E swing runner. Scheduled to repeat every 30 min during market hours.
REM Manages open positions on every run; only opens new ones inside the
REM 15:40-15:55 ET entry window.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" swingbot.js >> swingbot.log 2>&1
