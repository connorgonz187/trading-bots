@echo off
REM Pre-market direction call -> regime.json. Scheduled weekdays at 8:55am:
REM ahead of the 9:00 scanners and well ahead of the 9:30 open, so the stance is
REM already on disk before the bots' first cycle reads it. If this task fails,
REM the bots fall back to their static ORB_LONGS / ORB_SHORTS flags.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" regime.js >> regime.log 2>&1
