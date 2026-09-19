@echo off
chcp 65001 >nul
title Sunshine Run Helper
cd /d "%~dp0"

REM ============================================================
REM  This file is intentionally ASCII-only.
REM  cmd.exe mis-parses UTF-8 batch files after chcp 65001 and
REM  starts executing from the middle of lines. All Chinese
REM  messages are printed by Node instead (scripts\launch.mjs).
REM ============================================================

where node >nul 2>&1
if errorlevel 1 goto nonode

if exist ".output\server\index.mjs" (
    node scripts\launch.mjs
    goto ended
)

if exist "node_modules" (
    node scripts\launch.mjs --dev
    goto ended
)

echo First run: installing dependencies. This needs internet and takes 1-3 minutes...
echo.
where pnpm >nul 2>&1
if errorlevel 1 (
    call npm install
) else (
    call pnpm install
)
if errorlevel 1 goto installfail
node scripts\launch.mjs --dev
goto ended

:nonode
echo.
echo   [X] Node.js not found. This program needs Node.js 18 or newer.
echo.
echo       Opening the instruction file for you...
start "" "%~dp0Node.js-not-found.txt"
goto ended

:installfail
echo.
echo   [X] Dependency installation failed. Please check your network.
echo.
start "" "%~dp0Node.js-not-found.txt"

:ended
echo.
echo The program has stopped. Double-click this file again to restart.
pause
