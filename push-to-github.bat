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

rem Tests are not run here - use run-tests.bat separately.
echo.

git add -A
rem .env.example only holds empty placeholders, so it is allowed; any other .env / key file is refused.
git diff --cached --name-only | findstr /i /r "\.env$ \.env\. \.pem$ \.key$" | findstr /v /i /r "\.env\.example$" > "%TEMP%\yta-secrets.txt"
for %%F in ("%TEMP%\yta-secrets.txt") do if %%~zF GTR 0 (echo [ERROR] A secrets file is staged. Nothing was pushed: & type "%TEMP%\yta-secrets.txt" & del "%TEMP%\yta-secrets.txt" & git reset -q & pause & exit /b 1)
del "%TEMP%\yta-secrets.txt" >nul 2>nul

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
