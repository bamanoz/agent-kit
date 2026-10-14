@echo off
rem Пошаговая установка agent-kit (Windows): спрашивает путь проекта и
rem параметры, затем разворачивает OMO, Mempalace, project-memory и focused-spec.
rem Запуск: двойной щелчок или setup.cmd в cmd/PowerShell.
rem Для установки без вопросов используйте install.cmd.
setlocal
title agent-kit
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "KIT_PY=%~dp0lib\kit.py"
where py >nul 2>&1
if errorlevel 1 goto :try_python
py -3 "%KIT_PY%" wizard
goto :done

:try_python
where python >nul 2>&1
if errorlevel 1 goto :no_python
python "%KIT_PY%" wizard
goto :done

:no_python
echo ошибка: не найден Python 3.12+. Установите его с python.org вместе с py-launcher.
cmd /c exit 1

:done
set "KIT_RC=%ERRORLEVEL%"
echo.
if not "%KIT_RC%"=="0" echo Установка завершилась с ошибкой (код %KIT_RC%).
pause
exit /b %KIT_RC%
