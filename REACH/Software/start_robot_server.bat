@echo off
echo Starting Robot Arm Flask Server with HTTPS...
start "" cmd /k "python app.py"

timeout /t 3 >nul
start https://xxx.xxx.xx.xxx/
