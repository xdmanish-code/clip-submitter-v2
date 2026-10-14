@echo off
echo =======================================================
echo  Clip Submitter V2 - Windows Setup
echo =======================================================
node scripts\setup.js
if %ERRORLEVEL% NEQ 0 (
  echo Setup encountered an error.
)
pause
