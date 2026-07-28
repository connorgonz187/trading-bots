@echo off
REM Intraday ORB runner. Scheduled to repeat every 5 min during market hours.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" stockbot.js >> stockbot.log 2>&1
