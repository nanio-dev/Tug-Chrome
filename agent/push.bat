@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Same FTP account as the Tug website. Existing environment values take priority.
if not defined NANIO_FTP_TUG_USER set "NANIO_FTP_TUG_USER=nanio_tug"
if not defined NANIO_FTP_TUG_PASSWORD set "NANIO_FTP_TUG_PASSWORD=nanio_tug"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1"
set "TUG_PUSH_EXIT=%ERRORLEVEL%"

if /i not "%~1"=="--no-pause" pause
exit /b %TUG_PUSH_EXIT%
