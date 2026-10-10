@echo off
rem agent-sync 面板启动：隐藏启动服务（无黑窗）+ Edge 应用窗口
cd /d D:\ai-agent-backup
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory 'D:\ai-agent-backup' -WindowStyle Hidden"
timeout /t 1 /nobreak >nul
start msedge --app=http://127.0.0.1:7717
