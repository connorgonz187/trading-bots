@echo off
REM Pre-market scanner -> watchlist.csv. Scheduled weekdays before the open.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" scan.js >> scan.log 2>&1
