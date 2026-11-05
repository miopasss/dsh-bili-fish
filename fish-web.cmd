@echo off
chcp 65001 >nul
title bili-fish 本地控制台
cd /d "%~dp0"

echo.
echo ============================================================
echo   bili-fish 本地控制台
echo   配置 + 回复历史 · 只监听 127.0.0.1
echo   浏览器会自动打开；关闭这个窗口即停止服务
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node。请先安装 Node.js 24，或把 node 加入 PATH。
  echo.
  pause
  exit /b 1
)

node "%~dp0web\server.mjs" --open %*
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" echo 服务退出，代码 %EXITCODE%。
echo 服务已停止。按任意键关闭窗口。
pause >nul
