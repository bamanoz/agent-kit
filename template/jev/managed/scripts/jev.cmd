@echo off
rem Переключатель слоя решений Jev и отчеты (Windows).
rem Логика в jev_cli.py; парный файл для Linux - jev.
rem   scripts\jev on^|shadow^|off^|status^|report^|compare ...   справка: --help
setlocal
set "PYTHONUTF8=1"
where py >nul 2>&1
if errorlevel 1 goto :try_python
py -3 "%~dp0jev_cli.py" %*
exit /b

:try_python
python "%~dp0jev_cli.py" %*
exit /b
