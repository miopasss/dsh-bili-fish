@echo off
chcp 65001 >nul
title bili-fish 跑一轮（调试）
cd /d "%~dp0"

echo.
echo ============================================================
echo   bili-fish 跑一轮就退出
echo   DRY RUN = 只打印将要发送的回复，不真的发出去
echo ============================================================
echo.

set DRY=
set /p DRY=要真的发出去吗？(直接回车 = 只演练不发；输入 y = 真发) 

if /i "%DRY%"=="y" (
  node "%~dp0bin\fish.mjs" serve --once
) else (
  node "%~dp0bin\fish.mjs" serve --once --dry
)

echo.
echo 完成。按任意键关闭窗口。
pause >nul
