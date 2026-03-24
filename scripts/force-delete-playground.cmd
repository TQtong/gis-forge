@echo off
setlocal EnableExtensions
REM Delete locked playground folder. Close Cursor terminals with cwd=playground, or exit Cursor, then run.
REM If still fails: right-click -> Run as administrator.

cd /d C:\

set "TARGET=D:\my\code\gis-forge\playground"
if not exist "%TARGET%" (
  echo OK: folder does not exist.
  exit /b 0
)

echo Deleting: %TARGET%
rd /s /q "%TARGET%" 2>nul
if exist "%TARGET%" (
  echo FAILED: still in use. Close Cursor and retry, or run this script as Administrator.
  exit /b 1
)
echo OK: deleted.
exit /b 0
