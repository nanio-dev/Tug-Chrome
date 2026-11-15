@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "TUG_BUILD_EXIT=0"

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open the project directory.
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

where.exe node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is missing. Install Node.js 22 or later.
    set "TUG_BUILD_EXIT=1"
    goto finish
)
where.exe npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm.cmd was not found in PATH.
    set "TUG_BUILD_EXIT=1"
    goto finish
)

if not exist "node_modules\.bin\tsc.cmd" goto install
if not exist "node_modules\.bin\vite.cmd" goto install
goto build

:install
echo [Tug Web] Installing dependencies...
call npm.cmd ci --include=dev
set "TUG_BUILD_EXIT=%errorlevel%"
if not "%TUG_BUILD_EXIT%"=="0" goto failed

:build
echo [Tug Web] Building the browser extension...
call npm.cmd run build
set "TUG_BUILD_EXIT=%errorlevel%"
if not "%TUG_BUILD_EXIT%"=="0" goto failed

echo.
echo [OK] Extension output: "%CD%\dist"
echo Load this directory as an unpacked extension in Chrome or Edge.
echo After rebuilding, click Reload on the browser extensions page.
goto finish

:failed
echo.
echo [ERROR] Extension build failed. Exit code: %TUG_BUILD_EXIT%

:finish
popd
if /i not "%~1"=="--no-pause" pause
exit /b %TUG_BUILD_EXIT%
