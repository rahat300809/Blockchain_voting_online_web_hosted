@echo off
:: SETUP_AUTOSTART.bat
:: Registers BlockVote to auto-start when Windows boots
:: Run this ONCE as Administrator

echo.
echo =====================================================
echo   BlockVote — Windows Auto-Start Setup
echo =====================================================
echo.

cd /d "%~dp0"
set "PROJECT_DIR=%~dp0"
set "TASK_NAME=BlockVote Server"

:: Check for admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Please run this script as Administrator!
    echo Right-click SETUP_AUTOSTART.bat ^> Run as Administrator
    pause
    exit /b 1
)

:: Create the Task Scheduler entry
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
schtasks /create ^
    /tn "%TASK_NAME%" ^
    /tr "\"%PROJECT_DIR%START_SERVER.bat\"" ^
    /sc ONLOGON ^
    /rl HIGHEST ^
    /delay 0001:00 ^
    /f

if %errorlevel% equ 0 (
    echo.
    echo =====================================================
    echo   SUCCESS! BlockVote will now auto-start on login.
    echo.
    echo   To remove auto-start, run:
    echo   schtasks /delete /tn "BlockVote Server" /f
    echo =====================================================
) else (
    echo.
    echo ERROR: Failed to create scheduled task.
)
echo.
pause
