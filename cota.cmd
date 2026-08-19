@echo off
rem Atalho para chamar o cota de qualquer diretorio.
rem   ...\claude-limits\cota.cmd
rem   ...\claude-limits\cota.cmd cabe 10
rem Coloque esta pasta no PATH e vira so "cota".
rem
rem O caminho do node vem de node-local.txt (gravado pelo instalar.js e fora do
rem git), ou de %COTA_NODE%, ou do PATH.
setlocal
set "NODE="
if exist "%~dp0node-local.txt" set /p NODE=<"%~dp0node-local.txt"
if defined NODE if not exist "%NODE%" set "NODE="
if not defined NODE if defined COTA_NODE set "NODE=%COTA_NODE%"
if defined NODE if not exist "%NODE%" set "NODE="
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0cota.js" %*
