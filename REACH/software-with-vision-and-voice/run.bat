@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if errorlevel 1 (
  echo.
  echo PowerShell exited with errorlevel %errorlevel%.
  echo (If the window closed too fast before, this keeps it visible.)
  pause
)
endlocal
