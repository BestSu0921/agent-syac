@echo off
chcp 65001 >nul
REM Sync global agent memories/skills to D:\ai-agent-backup (double-click or scheduled task)
setlocal
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
%NODE% "%~dp0backup-agents.mjs" %*
if errorlevel 1 (
  echo.
  echo [FAILED] sync error, see sync-log.txt for details
) else (
  echo.
  echo [OK] sync finished, log: D:\ai-agent-backup\sync-log.txt
)
endlocal
pause
