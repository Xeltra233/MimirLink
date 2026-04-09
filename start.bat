@echo off
chcp 65001 >nul 2>nul
title Tavern-Link

echo ========================================
echo    Tavern-Link Launcher
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
echo    Starting Tavern-Link
echo ========================================
echo.
echo [i] Web UI: http://127.0.0.1:8001
echo [i] OneBot URL: check config.json
echo [i] Press Ctrl+C to stop.
echo.

node src/index.js

echo.
echo ========================================
echo    Process exited
echo ========================================
pause
