@echo off
cd /d "%~dp0"
title Tsunami - verificar agentes

echo.
echo  ==================================================
echo    Tsunami - onde estao os meus agentes
echo  ==================================================
echo.
echo   Este arquivo so LE. Ele nao apaga e nao muda nada.
echo   Serve para responder: o agente sumiu da tela, ou
echo   sumiu do disco?
echo.

where node >nul 2>&1
if errorlevel 1 goto SEM_NODE

if not exist "scripts\agents-report.mjs" goto PASTA_ERRADA

node scripts\agents-report.mjs %*

echo.
pause
exit /b 0


:SEM_NODE
echo   [X] Node.js nao foi encontrado nesta maquina.
echo.
echo       Baixe o instalador LTS em https://nodejs.org
echo.
pause
exit /b 1


:PASTA_ERRADA
echo   [X] Nao encontrei os arquivos do projeto nesta pasta.
echo.
echo       Extraia o Tsunami.zip e rode este arquivo de dentro
echo       da pasta extraida.
echo.
echo   Pasta atual: %CD%
echo.
pause
exit /b 1
