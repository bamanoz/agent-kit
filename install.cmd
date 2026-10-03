@echo off
rem Установка agent-kit в проект без вопросов (Windows: cmd и PowerShell).
rem   install.cmd <каталог-проекта> [параметры]   справка: install.cmd --help
rem Пошаговая установка с вопросами: setup.cmd.
rem Вся логика находится в lib\kit.py; здесь только поиск Python 3.
setlocal
set "PYTHONUTF8=1"
set "KIT_PY=%~dp0lib\kit.py"
where py >nul 2>&1
if errorlevel 1 goto :try_python
py -3 "%KIT_PY%" install %*
exit /b

:try_python
where python >nul 2>&1
if errorlevel 1 goto :no_python
python "%KIT_PY%" install %*
exit /b

:no_python
chcp 65001 >nul
echo ошибка: не найден Python 3.12+. Установите его с python.org вместе с py-launcher. 1>&2
exit /b 1
