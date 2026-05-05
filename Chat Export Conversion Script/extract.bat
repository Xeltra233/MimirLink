@echo off
chcp 65001 >nul
title 炸天帮 - 聊天记录提取工具

cls
echo.
echo ============================================================
echo 炸天帮 - 聊天记录提取与ID转换工具
echo ============================================================
echo.

REM 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 错误：未检测到 Node.js
    echo.
    echo 请先安装 Node.js: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM 检查脚本文件是否存在
if not exist "extract_by_sessionid.js" (
    echo ❌ 错误：找不到 extract_by_sessionid.js
    echo.
    echo 请确保脚本文件在当前目录下
    echo.
    pause
    exit /b 1
)

REM 检查数据文件是否存在
if not exist "sessions.json" (
    echo ❌ 错误：找不到 sessions.json
    echo.
    echo 请将 sessions.json 放在当前目录下
    echo.
    pause
    exit /b 1
)

echo ✅ 环境检查通过
echo.
echo 正在启动脚本...
echo.

REM 运行脚本
node extract_by_sessionid.js

echo.
echo ============================================================
echo 操作完成
echo ============================================================
echo.
echo 按任意键退出...
pause >nul
