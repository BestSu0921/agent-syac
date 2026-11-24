@echo off
chcp 65001 >nul
REM Sync global agent memories/skills to D:\ai-agent-backup (double-click or scheduled task)
setlocal
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
%NODE% "%~dp0sync.mjs" rules %*
set "RULES_EXIT=%ERRORLEVEL%"
%NODE% "%~dp0sync.mjs" memory %*
set "MEMORY_EXIT=%ERRORLEVEL%"
%NODE% "%~dp0sync.mjs" check %*
set "CHECK_EXIT=%ERRORLEVEL%"
%NODE% "%~dp0backup-agents.mjs" %*
set "SYNC_EXIT=%ERRORLEVEL%"
if "%SYNC_EXIT%"=="0" set "SYNC_EXIT=%RULES_EXIT%"
if "%SYNC_EXIT%"=="0" set "SYNC_EXIT=%MEMORY_EXIT%"
if "%SYNC_EXIT%"=="0" set "SYNC_EXIT=%CHECK_EXIT%"
if not "%SYNC_EXIT%"=="0" (
  echo.
  echo [FAILED] sync error, see sync-log.txt for details
) else (
  echo.
  echo [OK] sync finished, log: D:\ai-agent-backup\sync-log.txt
)
pause
endlocal & exit /b %SYNC_EXIT%
