@echo off
setlocal

cd /d "%~dp0\.."

if not exist "bin\ourmusic-engine.exe" (
    call scripts\build-windows.bat
    if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
)

node src\index.mjs --windows-app %*
