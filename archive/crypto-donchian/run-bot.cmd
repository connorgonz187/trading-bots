@echo off
REM Launcher for the trading bot under Task Scheduler.
REM %~dp0 = this file's folder, so the bot always runs with the correct working
REM directory (it resolves .env / rules.json / logs relative to cwd).
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" bot.js >> bot.log 2>&1
