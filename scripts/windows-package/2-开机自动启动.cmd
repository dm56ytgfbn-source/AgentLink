@echo off
rem ASCII only. See the note in 1-...cmd.
chcp 65001 >nul
setlocal
title AgentLink - Start At Logon
set "HERE=%~dp0"
set "NODE_DIR=%USERPROFILE%\.agentlink-node"
set "NODE=%HERE%runtime\node\node.exe"
if not exist "%NODE%" goto nonode

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%runtime\scripts\windows-install-startup.ps1" -NodeExe "%NODE%" -Project "%HERE%runtime" -Config "%NODE_DIR%\node.local.json"
echo.
pause
goto :eof

:nonode
echo.
echo   The bundled runtime is missing. Re-extract the whole archive.
echo.
pause
