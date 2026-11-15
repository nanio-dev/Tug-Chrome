@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "TUG_BUILD_EXIT=0"

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot open the Agent directory.
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

where.exe cargo.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Cargo is missing. Install the Rust MSVC toolchain and C++ build tools.
    set "TUG_BUILD_EXIT=1"
    goto finish
)

echo [Tug Agent] Building the release executable...
cargo.exe build --release --locked --target-dir "%CD%\target"
set "TUG_BUILD_EXIT=%errorlevel%"
if not "%TUG_BUILD_EXIT%"=="0" goto failed

copy /y "target\release\tug-agent.exe" "tug-agent.exe" >nul
set "TUG_BUILD_EXIT=%errorlevel%"
if not "%TUG_BUILD_EXIT%"=="0" (
    echo [ERROR] Cannot copy tug-agent.exe. Close the running executable and retry.
    goto failed
)

echo.
echo [OK] Agent output: "%CD%\tug-agent.exe"
goto finish

:failed
echo.
echo [ERROR] Agent build failed. Exit code: %TUG_BUILD_EXIT%

:finish
popd
if /i not "%~1"=="--no-pause" pause
exit /b %TUG_BUILD_EXIT%
