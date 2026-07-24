@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js/npm not found. Install LTS from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

echo.
echo === El Sombrero Express — Special scraper ===
echo Folder: %CD%
echo.

echo [1/3] npm install
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] npm run scrape
echo      Put Facebook URLs in facebook-post-urls.txt when RSS fails.
call npm run scrape
if errorlevel 1 (
  echo Scrape step failed. Install Python 3 and ensure py or python is on PATH.
  pause
  exit /b 1
)

echo.
echo [3/3] Starting local server on http://127.0.0.1:3456/
start "El Sombrero Express" /D "%~dp0" cmd /k "npm run serve"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3456/index.html"

echo.
echo Close the server window when finished.
pause
endlocal
