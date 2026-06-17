@echo off
setlocal

cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8080/
  python -m http.server 8080
  exit /b %errorlevel%
)

echo Python not found. Install Python or run another local server.
echo Example: npx serve .
pause
exit /b 1
