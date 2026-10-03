@echo off
rem ASCII only: cmd.exe misparses batch files containing non-ASCII bytes after "chcp 65001"
rem and then silently skips the lines that follow. All user-facing text lives in Node.
rem Node ships inside runtime\node, so nothing has to be installed first.
chcp 65001 >nul
setlocal
title AgentLink - Keyboard And Mouse Sharing
set "HERE=%~dp0"
set "NODE=%HERE%runtime\node\node.exe"
if exist "%NODE%" goto run
for /f "delims=" %%v in ('where node 2^>nul') do set "NODE=%%v"
if not exist "%NODE%" goto nonode

:run
"%NODE%" "%HERE%runtime\scripts\windows-input-share.mjs" %*
goto end

:nonode
echo.
echo   The bundled runtime is missing and Node.js is not installed.
echo   Re-extract the whole archive, or install Node.js from https://nodejs.org/
echo.
start "" https://nodejs.org/

:end
echo.
pause
