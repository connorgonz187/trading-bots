@echo off
REM Always-on display mode: starts the dashboard server (if not already up) and
REM opens it in a dedicated FULLSCREEN browser window with no tabs or address
REM bar — ideal for leaving on a spare monitor. Press Alt+F4 to close the window;
REM the server keeps running in its own minimized window until you close that too.
cd /d "%~dp0"

REM Start the server in its own minimized window. If it's already running,
REM server.js detects the busy port and exits cleanly, so this is harmless.
start "Trading Dashboard Server" /min "C:\Program Files\nodejs\node.exe" server.js

REM Give the server a second to bind the port before pointing a browser at it.
timeout /t 2 /nobreak >nul

REM Brave (Chromium): --app = chromeless window, --start-fullscreen = borderless.
start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --app=http://localhost:4000 --start-fullscreen
