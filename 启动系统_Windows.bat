@echo off
cd /d "%~dp0"
echo K8 Batch Return Processing System is starting...
echo Browser address: http://localhost:8080
py -m http.server 8080
if errorlevel 1 python -m http.server 8080
pause
