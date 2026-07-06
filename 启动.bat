@echo off
cd /d "%~dp0"

if exist "WPy32-3830\python-3.8.3\python.exe" set "P=WPy32-3830\python-3.8.3\python.exe" & goto run
if exist "WPy64-3830\python-3.8.3.amd64\python.exe" set "P=WPy64-3830\python-3.8.3.amd64\python.exe" & goto run

where python >nul 2>&1 && set "P=python" & goto run
where python3 >nul 2>&1 && set "P=python3" & goto run

echo Python not found! Place WinPython in this folder or install Python 3.8+.
echo.
pause
exit /b 1

:run
set PYTHONUNBUFFERED=1
"%P%" -u downloader.py
pause
