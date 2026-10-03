@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js LTS from https://nodejs.org with npm enabled.
  pause
  exit /b 1
)
node control-center\setup.js
if errorlevel 1 echo Setup did not finish. Read the error above.
pause
