@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0checks.log"
echo YouTube AI Agent - V1.7.0 checks %DATE% %TIME% > "%LOG%"
echo Running checks. Output is saved to checks.log ...

call :step "npm install" npm install || goto fail
call :step "server tests" npm test --workspace server || goto fail
call :step "client tests" npm test --workspace client || goto fail
call :step "client build" npm run build --workspace client || goto fail

echo.>> "%LOG%"
echo ===== git commit on main ===== >> "%LOG%"
git branch --show-current >> "%LOG%" 2>&1
git add -A -- . ":(exclude)run-checks.cmd" ":(exclude)checks.log" >> "%LOG%" 2>&1 || goto fail
git commit -m "V1.7.0 audio intelligence + handover fixes" >> "%LOG%" 2>&1 || goto fail
git log --oneline -3 >> "%LOG%" 2>&1
echo RESULT: ALL CHECKS PASSED AND COMMITTED >> "%LOG%"
echo.
echo ALL CHECKS PASSED - committed on main. You can close this window.
pause
exit /b 0

:step
echo.>> "%LOG%"
echo ===== %~1 ===== >> "%LOG%"
echo   %~1 ...
shift
call %* >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:fail
echo RESULT: FAILED - nothing was committed >> "%LOG%"
echo.
echo A CHECK FAILED - nothing was committed. Tell Claude to read checks.log.
pause
exit /b 1
