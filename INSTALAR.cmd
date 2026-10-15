@echo off
rem Instalador do cota para Windows: de dois cliques neste arquivo.
rem
rem Ele acha o Node.js (ou oferece instalar) e chama o instalar.js, que liga
rem o cota ao Claude Code e/ou ao Codex. A logica fica no PowerShell
rem (lib\instalar-windows.ps1): em .cmd ela seria fragil.
rem
rem Pelo terminal da no mesmo:  node instalar.js
title Instalar o cota
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\instalar-windows.ps1" %*
echo.
pause
