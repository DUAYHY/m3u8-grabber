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
set HTTPS_PROXY=
set HTTP_PROXY=

curl -k --ssl-no-revoke -x http://127.0.0.1:7897 -s -I https://www.google.com -m 1 >NUL 2>&1 && set "HTTPS_PROXY=http://127.0.0.1:7897" && set "HTTP_PROXY=http://127.0.0.1:7897" && echo [proxy] 127.0.0.1:7897
if "%HTTPS_PROXY%"=="" curl -k --ssl-no-revoke -x http://127.0.0.1:7890 -s -I https://www.google.com -m 1 >NUL 2>&1 && set "HTTPS_PROXY=http://127.0.0.1:7890" && set "HTTP_PROXY=http://127.0.0.1:7890" && echo [proxy] 127.0.0.1:7890
if "%HTTPS_PROXY%"=="" curl -k --ssl-no-revoke -x http://127.0.0.1:10809 -s -I https://www.google.com -m 1 >NUL 2>&1 && set "HTTPS_PROXY=http://127.0.0.1:10809" && set "HTTP_PROXY=http://127.0.0.1:10809" && echo [proxy] 127.0.0.1:10809
if "%HTTPS_PROXY%"=="" echo [proxy] none, direct connect

"%P%" -u downloader.py
pause
