@echo off
rem CLI Mempalace для палаты проекта (Windows), например:
rem   scripts\mempalace search "<запрос>" --wing <крыло>
rem Парный файл для Linux — mempalace.
setlocal
cd /d "%~dp0.."
if not defined MEMPALACE_PALACE_PATH set "MEMPALACE_PALACE_PATH=.mempalace\palace"
if not defined MEMPALACE_BACKEND set "MEMPALACE_BACKEND=chroma"
if not defined MEMPALACE_EMBEDDING_MODEL set "MEMPALACE_EMBEDDING_MODEL={{EMBEDDING_MODEL}}"
if not defined MEMPALACE_ENTITY_LANGUAGES set "MEMPALACE_ENTITY_LANGUAGES=ru,en"
if not defined MEMPALACE_HOOKS_AUTO_SAVE set "MEMPALACE_HOOKS_AUTO_SAVE=0"
if not defined ANONYMIZED_TELEMETRY set "ANONYMIZED_TELEMETRY=False"
set "PYTHONUTF8=1"
set "KIT_EXE=.venv-mempalace\Scripts\mempalace.exe"
if not exist "%KIT_EXE%" set "KIT_EXE=%LOCALAPPDATA%\agent-kit\venvs\mempalace-{{MEMPALACE_VERSION}}\Scripts\mempalace.exe"
"%KIT_EXE%" --palace .mempalace\palace %*
exit /b %ERRORLEVEL%
