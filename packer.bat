@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "TUG_PACK_EXIT=0"
pushd "%~dp0"
if errorlevel 1 exit /b 1

call build.bat --no-pause
if errorlevel 1 goto :failed
call agent\build.bat --no-pause
if errorlevel 1 goto :failed
node scripts\package-release.mjs
if errorlevel 1 goto :failed
node scripts\verify-release.mjs
if errorlevel 1 goto :failed
echo.
echo [OK] Release files: "%CD%\out"
goto :finish
:failed
set "TUG_PACK_EXIT=1"
echo [ERROR] Packaging failed. Do not publish this output.
:finish
popd
if /i not "%~1"=="--no-pause" pause
exit /b %TUG_PACK_EXIT%
