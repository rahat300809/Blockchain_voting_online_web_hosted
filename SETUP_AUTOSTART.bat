@echo off
:: SETUP_AUTOSTART.bat
:: Run this ONCE to make BlockVote start automatically when Windows boots.
:: After running this, you NEVER need to manually start the server again.

echo.
echo =====================================================
echo   BlockVote — Permanent Auto-Start Setup via PM2
echo =====================================================
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Install it from https://nodejs.org
    pause & exit /b 1
)

:: Check PM2
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing PM2 process manager...
    npm install -g pm2 pm2-windows-startup
)

:: Check pm2-startup
where pm2-startup >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing PM2 Windows Startup support...
    npm install -g pm2-windows-startup
)

echo.
echo [1/4] Installing Node.js dependencies...
cd api-server
if not exist "node_modules" (
    npm install
)
cd ..

echo.
echo [2/4] Starting BlockVote under PM2...
set PM2_HOME=C:\Users\%USERNAME%\.pm2
pm2 delete all >nul 2>&1
pm2 start ecosystem.config.js
pm2 save --force

echo.
echo [3/4] Installing PM2 Windows startup entry...
pm2-startup install

echo.
echo [4/4] Verifying...
timeout /t 5 >nul
pm2 list

echo.
echo =====================================================
echo   SUCCESS! BlockVote will now:
echo.
echo   - Start AUTOMATICALLY when Windows logs in
echo   - Keep running 24/7 in the background
echo   - Auto-restart if server or tunnel crashes
echo   - Publish tunnel URL automatically
echo.
echo   Check status anytime: pm2 list
echo   See live logs:        pm2 logs
echo   Stop everything:      pm2 stop all
echo   Restart everything:   pm2 restart all
echo.
echo   Website: https://blockchain300809.web.app
echo =====================================================
echo.
pause
