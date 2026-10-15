@echo off
rem Atalho para chamar o cota de qualquer diretorio.
rem   ...\cota.cmd
rem   ...\cota.cmd cabe 10
rem   ...\cota.cmd --codex        (o mesmo, para o Codex)
rem Coloque esta pasta no PATH e vira so "cota".
rem
rem O caminho do node vem de node-local.txt (gravado pelo instalar.js e fora do
rem git), ou de %COTA_NODE%, ou do PATH.
setlocal
set "NODE="
rem O node-local.txt e UTF-8, e o "set /p" le na pagina de codigo do console:
rem com acento no caminho (C:\Users\Ana Conceicao) o node nao seria achado.
rem Troca para UTF-8 so durante a leitura e volta a de antes.
for /f "tokens=2 delims=:." %%c in ('chcp') do set "CP_ANTES=%%c"
chcp 65001 >nul
if exist "%~dp0node-local.txt" set /p NODE=<"%~dp0node-local.txt"
if defined CP_ANTES chcp %CP_ANTES% >nul
if defined NODE if not exist "%NODE%" set "NODE="
if not defined NODE if defined COTA_NODE set "NODE=%COTA_NODE%"
if defined NODE if not exist "%NODE%" set "NODE="
if not defined NODE where node >nul 2>nul && set "NODE=node"
if not defined NODE (
  echo cota: nao achei o Node.js. Rode o INSTALAR.cmd primeiro ^(dois cliques^).
  exit /b 1
)
"%NODE%" "%~dp0cota.js" %*
