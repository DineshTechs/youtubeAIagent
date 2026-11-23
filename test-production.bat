@echo off
setlocal
title YouTube AI Agent - production test
rem Runs the app the way the hosted server will: built dashboard + login, on http://127.0.0.1:4000
rem Your normal setup is not changed. Close this window to stop, then use start-app.bat again.
cd /d "%~dp0"

echo.
echo === YouTube AI Agent: production test on this PC ===
echo.
echo Stopping the normal app (if it is running)...
call "%~dp0stop-app.bat" nopause >nul 2>&1

echo Building the dashboard (client\dist)...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. Run "npm install" in this folder once, then try again.
  pause
  exit /b 1
)

echo.
set "ADMIN_USERNAME=admin"
echo Use letters, digits, - or _ (avoid ^& %% ! ^< ^> ^| in this window).
set /p "ADMIN_PASSWORD=Choose a test password (at least 10 characters): "
set "NODE_ENV=production"
set "PUBLIC_URL=http://127.0.0.1:4000"

echo.
echo Home page:  http://127.0.0.1:4000
echo Dashboard:  http://127.0.0.1:4000/app/   (sign in as "admin")
echo (Not :5173 - in production the dashboard is served by the API itself.)
echo Press Ctrl+C or close this window to stop.
echo.
cd server
node app.cjs
pause
