@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Qoder 打卡服务
echo.
echo ============================================
echo   Qoder 打卡服务
echo   启动成功后会打印手机访问地址(本机局域网 IP)
echo   关闭本窗口 或 Ctrl+C 即停止服务
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 node。请先安装 Node.js 后再双击本脚本。
  echo https://nodejs.org/
  pause
  exit /b 1
)

node server.js
echo.
echo 服务已停止。
pause
