@echo off
setlocal
title Push YouTube AI Agent to GitHub
cd /d "%~dp0"

where git >nul 2>nul || (echo [ERROR] Git is not installed or not on PATH. & pause & exit /b 1)
for /f %%B in ('git branch --show-current') do set "BRANCH=%%B"
echo Repository: & git remote get-url origin
echo Branch: %BRANCH%
echo.

rem Safety: secrets must never be committed.
git check-ignore -q server/.env || (echo [ERROR] server\.env is NOT ignored by .gitignore. Nothing was pushed. & pause & exit /b 1)

echo Running server tests before pushing...
call npm test --workspace server >"%TEMP%\yta-tests.log" 2>&1
if errorlevel 1 (echo [ERROR] Tests failed - nothing was pushed. Details: %TEMP%\yta-tests.log & pause & exit /b 1)
echo Tests passed.
echo.

git add -A
git diff --cached --name-only | findstr /i /r "\.env$ \.env\. \.pem$ \.key$" >nul && (echo [ERROR] A secrets file is staged. Nothing was pushed. & git reset -q & pause & exit /b 1)

git diff --cached --quiet
if errorlevel 1 (
  echo Changes to commit:
  git status --short
  echo.
  set "MSG="
  set /p "MSG=Commit message (press Enter for a default): "
  if not defined MSG set "MSG=Update from %COMPUTERNAME% %DATE%"
  choice /c YN /m "Commit and push to GitHub"
  if errorlevel 2 (git reset -q & echo Cancelled - nothing was committed. & pause & exit /b 0)
  call git commit -m "%%MSG%%" || (echo [ERROR] Commit failed. & pause & exit /b 1)
) else (
  echo No new changes to commit - pushing existing commits.
)

echo.
echo Pushing to origin/%BRANCH% ... (GitHub may ask you to sign in the first time)
git push -u origin %BRANCH% || (echo [ERROR] Push failed - see the message above. & pause & exit /b 1)
echo.
echo Done: pushed to GitHub.
pause
