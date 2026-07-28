@echo off
REM Bot E universe builder -> swing-watchlist.csv. Scheduled weekdays pre-market.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" swing-scan.js >> swing-scan.log 2>&1
