@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Run SETUP.bat first.
  pause
  exit /b 1
)
if not exist arena.config.json (
  echo Run SETUP.bat first.
  pause
  exit /b 1
)
node control-center\start.js
if errorlevel 1 pause
