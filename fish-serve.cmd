@echo off
chcp 65001 >nul
title bili-fish 常驻进程
cd /d "%~dp0"

echo.
echo ============================================================
echo   bili-fish 常驻进程
echo   每 30 秒拉一次 @ 消息 -^> 生成总结 -^> 回复到楼中楼
echo   关闭这个窗口或按 Ctrl+C 停止
echo ============================================================
echo.

node "%~dp0bin\fish.mjs" serve

echo.
echo 进程已退出。按任意键关闭窗口。
pause >nul
