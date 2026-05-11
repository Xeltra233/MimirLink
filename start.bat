@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title MimirLink

cd /d "%~dp0"

set "WEB_PORT=8001"
set "PORT_LINE="
if exist "config.json" (
    for /f "usebackq delims=" %%L in (`findstr /r /c:"\"port\"[ ]*:" "config.json"`) do (
        set "PORT_LINE=%%L"
    )
    if defined PORT_LINE (
        for /f "tokens=2 delims=:," %%P in ("!PORT_LINE!") do (
            set "WEB_PORT=%%~P"
            set "WEB_PORT=!WEB_PORT: =!"
        )
    )
)

echo ========================================
echo    MimirLink Launcher
echo ========================================
echo.

node -v >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found.
    echo Install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js detected.
echo.

if not exist "node_modules\" (
    echo [!] Installing dependencies...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [X] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

if not exist "config.json" (
    if exist "config.example.json" (
        echo [!] Creating config.json from config.example.json ...
        copy /y "config.example.json" "config.json" >nul
        echo [OK] config.json created.
        echo Edit config.json and run again.
        echo.
        pause
        exit /b 0
    )
)

if not exist "data\characters\" mkdir "data\characters" 2>nul
if not exist "data\chats\" mkdir "data\chats" 2>nul
if not exist "logs\" mkdir "logs" 2>nul

echo ========================================
echo    Starting MimirLink
echo ========================================
echo.
echo [i] Web UI: http://127.0.0.1:%WEB_PORT%
echo [i] OneBot URL: check config.json
echo [i] Press Ctrl+C to stop.
echo.

call npm run start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo ========================================
echo    Process exited ^(code %EXIT_CODE%^)
echo ========================================
pause
exit /b %EXIT_CODE%
