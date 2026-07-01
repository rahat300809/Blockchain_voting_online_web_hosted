@echo off
setlocal enabledelayedexpansion
title BlockVote Server v4.1
color 0A

echo.
echo =====================================================
echo   BlockVote — Server + Tunnel Auto-Start v4.1
echo   Blockchain Voting System v3.0
echo =====================================================
echo.

:: Go to project root
cd /d "%~dp0"

:: ──────────────────────────────────────────────────────────
:: [1/4] Kill old processes
:: ──────────────────────────────────────────────────────────
echo [1/4] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
taskkill /f /im ssh.exe >nul 2>&1
del /f /q lhr3.log >nul 2>&1
del /f /q pinggy.log >nul 2>&1
timeout /t 2 >nul

:: ──────────────────────────────────────────────────────────
:: [2/4] Start SSH tunnel (localhost.run — reliable)
:: ──────────────────────────────────────────────────────────
echo [2/4] Starting public HTTPS tunnel...
start "BlockVote-Tunnel" /min cmd /c "ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -R 80:127.0.0.1:3000 nokey@localhost.run > lhr3.log 2>&1"
echo     Tunnel starting... waiting 10 seconds for URL...
timeout /t 10 >nul

:: Show tunnel URL
echo.
echo [3/4] Public Tunnel URL:
echo -------------------------------------------------------
findstr "lhr.life" lhr3.log 2>nul | findstr "https://"
echo -------------------------------------------------------
echo.

:: ──────────────────────────────────────────────────────────
:: [4/4] Start Node.js server (foreground — keeps window alive)
:: ──────────────────────────────────────────────────────────
echo [4/4] Starting Node.js server on port 3000...
echo.
echo  Local endpoints:
echo    Admin    ^>  http://localhost:3000/admin
echo    Agent    ^>  http://localhost:3000/agent
echo    Register ^>  http://localhost:3000/register
echo    Vote     ^>  http://localhost:3000/vote
echo    Health   ^>  http://localhost:3000/api/health
echo.
echo  *** DO NOT CLOSE THIS WINDOW — Server must stay running ***
echo  *** The public URL is being published automatically     ***
echo.
cd api-server
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)
node server.js

pause
