@echo off
setlocal
title YouTube AI Agent - Tests
cd /d "%~dp0"
rem Usage: run-tests.bat            -> runs everything and waits for a key
rem        run-tests.bat nopause    -> used by push-to-github.bat
set "LOG=%~dp0test-results.log"
where node >nul 2>nul || (echo [ERROR] Node.js is not installed or not on PATH. & goto fail)
if not exist "node_modules\" (
  echo Installing dependencies - first run only...
  call npm install || goto fail
)
echo Test run %DATE% %TIME% > "%LOG%"
set "FAILED="

call :step "Server tests" npm test --workspace server
call :step "Client tests" npm test --workspace client
call :step "Dashboard production build" npm run build --workspace client

echo.
if defined FAILED (
  echo RESULT: FAILED -%FAILED%
  echo Full output: %LOG%
  echo RESULT: FAILED -%FAILED% >> "%LOG%"
  goto fail
)
echo RESULT: ALL PASSED
echo RESULT: ALL PASSED >> "%LOG%"
if /i not "%~1"=="nopause" pause
exit /b 0

:step
echo.
echo === %~1 ===
echo. >> "%LOG%"
echo ===== %~1 ===== >> "%LOG%"
call %2 %3 %4 %5 %6 >> "%LOG%" 2>&1
if errorlevel 1 (
  echo    FAILED
  set "FAILED=%FAILED% [%~1]"
) else (
  echo    passed
)
exit /b 0

:fail
if /i not "%~1"=="nopause" pause
exit /b 1
