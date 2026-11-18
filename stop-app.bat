@echo off
setlocal
rem Stops whatever is listening on the app ports (backend 4000, dashboard 5173).
set "FOUND="
for %%P in (4000 5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /c:":%%P " ^| findstr LISTENING') do (
    set "FOUND=1"
    echo Stopping process %%A on port %%P...
    taskkill /PID %%A /T /F >nul 2>nul
  )
)
if not defined FOUND echo The app is not running.
if /i not "%~1"=="nopause" pause
