@echo off
chcp 65001 >nul
where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required. Install PowerShell 7 first.
  pause
  exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
