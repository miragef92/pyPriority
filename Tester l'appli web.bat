@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Python est introuvable. & pause & exit /b 1)
echo Appli web locale : http://localhost:8080  (Ctrl+C pour arreter)
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1 --directory web
