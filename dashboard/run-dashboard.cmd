@echo off
REM Launches the local Trading Mission Control dashboard, then opens it in the
REM default browser. Read-only: it never places or cancels an order.
REM %~dp0 = this file's folder, so paths resolve no matter where it's launched.
cd /d "%~dp0"
start "" http://localhost:4000
"C:\Program Files\nodejs\node.exe" server.js
