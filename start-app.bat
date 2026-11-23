@echo off
setlocal EnableDelayedExpansion
title YouTube AI Agent
cd /d "%~dp0"

where node >nul 2>nul || (echo [ERROR] Node.js is not installed or not on PATH. & pause & exit /b 1)
where npm  >nul 2>nul || (echo [ERROR] npm is not available. & pause & exit /b 1)
if not exist "server\.env" echo [WARNING] server\.env not found - API keys and MongoDB settings will be missing.

rem Only ONE backend may run at a time (a second copy interrupts running jobs).
set "BUSY="
for %%P in (4000 5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /c:":%%P " ^| findstr LISTENING') do set "BUSY=!BUSY! %%P(PID %%A)"
)
if defined BUSY (
  echo Ports already in use:!BUSY!
  echo The app is probably already running.
  choice /c YN /m "Stop the running copy and start fresh"
  if errorlevel 2 (echo Keeping the running copy. Opening the dashboard... & start "" http://localhost:5173 & exit /b 0)
  call "%~dp0stop-app.bat" nopause
)

if not exist "node_modules\" (
  echo Installing dependencies - first run only, this can take a few minutes...
  call npm install || (echo [ERROR] npm install failed. & pause & exit /b 1)
)

echo.
echo Starting backend (port 4000) and dashboard (port 5173)...
echo Close this window or press Ctrl+C to stop the app.
echo.
rem Open the dashboard once the dev servers have had a moment to start.
start "" /b cmd /c "ping -n 9 127.0.0.1 >nul & start http://localhost:5173"
rem Runs without auto-reload: a reload (on any file change) would kill a video
rem that is being made. After updating the code, restart with stop-app/start-app.
call npm run local
echo.
echo The app has stopped.
pause
