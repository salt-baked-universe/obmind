@echo off
setlocal
set "SRC=D:\ProjectFiles\study\obmind"

rem Locate the vault folder "2. <something>" without hardcoding Chinese chars
set "BASE="
for /d %%d in ("D:\BJRepository\2. *") do set "BASE=%%~d"
if not defined BASE (
  echo [error] vault folder not found: D:\BJRepository\2. *
  pause
  exit /b 1
)

set "DST=%BASE%\.obsidian\plugins\obmind-map"
if not exist "%DST%" mkdir "%DST%"

copy /Y "%SRC%\manifest.json" "%DST%" >nul && echo [ok] manifest.json
copy /Y "%SRC%\main.js" "%DST%" >nul && echo [ok] main.js
copy /Y "%SRC%\styles.css" "%DST%" >nul && echo [ok] styles.css

echo.
echo Deployed to: %DST%
pause
