@echo off
REM One-time cleanup: flatten the positions stranded by the pre-fix EOD-flatten bug.
REM Runs flatten.js for Bot A and Bot C. Safe no-op if the market is closed or the
REM account is already flat. The scheduled task that calls this self-deletes after.
cd /d "%~dp0bot a"
"C:\Program Files\nodejs\node.exe" flatten.js >> flatten.log 2>&1
cd /d "%~dp0bot c"
"C:\Program Files\nodejs\node.exe" flatten.js >> flatten.log 2>&1
