@echo off
REM Manual escape hatch: cancel resting orders and flatten every open position
REM for Bot B and Bot C. Paper accounts only.
REM
REM Since 2026-07-28 stockbot.js sweeps stranded positions automatically on the
REM first cycle of a new session, so this should rarely be needed. Use it when
REM an alert says a flatten failed and you don't want to wait for the next open.
REM
REM Market orders only fill during regular hours — run this 9:30-16:00 ET.
cd /d "%~dp0bot b"
"C:\Program Files\nodejs\node.exe" flatten.js >> flatten.log 2>&1
cd /d "%~dp0bot c"
"C:\Program Files\nodejs\node.exe" flatten.js >> flatten.log 2>&1
