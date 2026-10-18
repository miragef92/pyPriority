@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Python est introuvable. Installe-le depuis https://www.python.org & pause & exit /b 1)
python app.py
if errorlevel 1 pause
