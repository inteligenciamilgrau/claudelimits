@echo off
setlocal
set "COTA_RUNTIME="
if exist "%~dp0node-local.txt" set /p COTA_RUNTIME=<"%~dp0node-local.txt"
if defined COTA_RUNTIME if not exist "%COTA_RUNTIME%" set "COTA_RUNTIME="
if not defined COTA_RUNTIME if defined COTA_NODE set "COTA_RUNTIME=%COTA_NODE%"
if not defined COTA_RUNTIME set "COTA_RUNTIME=node"
"%COTA_RUNTIME%" "%~dp0cota-codex.js" %*
