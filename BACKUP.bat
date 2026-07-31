@echo off
cd /d "%~dp0"
title Blizzard Agents - backup da pasta data

echo.
echo  ==================================================
echo    Blizzard Agents - backup das chaves e do banco
echo  ==================================================
echo.
echo   Copia a pasta "data" para a sua Area de Trabalho.
echo   E a pasta que guarda as CHAVES das carteiras dos
echo   agentes. Sem ela, o saldo fica preso na blockchain
echo   para sempre.
echo.
echo   Este arquivo so COPIA. Nao apaga nada.
echo.

if not exist "data" goto SEM_DATA

set "DEST=%USERPROFILE%\Desktop\Blizzard Agents-backup-data"

echo   Copiando para:
echo   %DEST%
echo.

robocopy "data" "%DEST%" /E /R:1 /W:1 >nul
if errorlevel 8 goto ERRO

echo   [OK] Backup feito.
echo.
echo   Guarde essa pasta em outro lugar tambem (pen drive,
echo   nuvem). Quem tiver essa pasta E a senha do agente
echo   consegue mover os fundos dele.
echo.
echo   Abrindo a pasta para voce conferir...
start "" "%DEST%"
echo.
pause
exit /b 0


:SEM_DATA
echo   Nao existe pasta "data" aqui, entao nao ha nada para
echo   salvar. Isso e normal se voce nunca criou um agente
echo   nesta pasta.
echo.
echo   Pasta atual: %CD%
echo.
pause
exit /b 1


:ERRO
echo.
echo   [X] A copia falhou. Verifique se ha espaco em disco
echo       e se a Area de Trabalho esta acessivel.
echo.
pause
exit /b 1
