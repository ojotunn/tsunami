@echo off
cd /d "%~dp0"
title Tsunami - menu de testes

where node >nul 2>&1
if errorlevel 1 goto SEM_NODE
if not exist "src\web\server.js" goto PASTA_ERRADA

:MENU
cls
echo.
echo  ==================================================
echo    Tsunami - o que voce quer testar?
echo  ==================================================
echo.
echo    1 - Conexao com a chain (doctor)
echo    2 - Indexar os tokens lancados recentemente
echo    3 - Listar os tokens ja indexados
echo    4 - Preflight de um token (checa a rota de compra)
echo    5 - Cotar uma compra em um token
echo    6 - Abrir o site na minha maquina
echo    7 - Publicar link temporario na internet
echo    8 - Rodar a bateria de testes
echo    9 - TESTE COM DINHEIRO REAL (envio ligado)
echo.
echo    A - Onde estao os meus agentes? (so le, nao muda nada)
echo    B - Backup da pasta data (as chaves dos agentes)
echo.
echo    0 - Sair
echo.
set "OPC="
set /p OPC=  Digite o numero e aperte Enter:

if "%OPC%"=="1" goto DOCTOR
if "%OPC%"=="2" goto INDEXAR
if "%OPC%"=="3" goto TOKENS
if "%OPC%"=="4" goto PREFLIGHT
if "%OPC%"=="5" goto QUOTE
if "%OPC%"=="6" goto SITE
if "%OPC%"=="7" goto PUBLICAR
if "%OPC%"=="8" goto TESTES
if "%OPC%"=="9" goto REAL
if /i "%OPC%"=="A" goto AGENTES
if /i "%OPC%"=="B" goto BACKUP
if "%OPC%"=="0" exit /b 0
goto MENU


:DOCTOR
cls
echo.
echo   Conferindo a RPC, o chain id e a factory...
echo.
node --env-file-if-exists=.env src\cli.js doctor
goto FIM


:INDEXAR
cls
echo.
echo   Indexando os lancamentos dos ultimos 5000 blocos.
echo   Pode demorar um pouco na primeira vez.
echo.
node --env-file-if-exists=.env src\cli.js index backfill --blocks 5000
echo.
echo   Preenchendo nome, simbolo e supply dos tokens...
echo.
node --env-file-if-exists=.env src\cli.js index sync-state --limit 50
goto FIM


:TOKENS
cls
echo.
node --env-file-if-exists=.env src\cli.js tokens --limit 30
echo.
echo   Copie um endereco da coluna "address" para usar nas opcoes 4 e 5.
goto FIM


:PREFLIGHT
cls
echo.
echo   O preflight confere a rota de compra inteira contra os
echo   contratos reais. Nada e enviado e nada e gasto.
echo.
set "TK="
set /p TK=  Endereco do token (0x...):
if "%TK%"=="" goto MENU
set "VAL="
set /p VAL=  Quanto de ETH simular [padrao 0.005]:
if "%VAL%"=="" set VAL=0.005
echo.
node --env-file-if-exists=.env src\cli.js preflight %TK% --eth %VAL%
goto FIM


:QUOTE
cls
echo.
set "TK="
set /p TK=  Endereco do token (0x...):
if "%TK%"=="" goto MENU
set "VAL="
set /p VAL=  Quanto de ETH [padrao 0.01]:
if "%VAL%"=="" set VAL=0.01
echo.
node --env-file-if-exists=.env src\cli.js quote %TK% --in %VAL%
goto FIM


:SITE
cls
echo.
echo   Abrindo o site. Feche a janela do servidor para parar.
echo.
start "" INICIAR-SITE.bat
exit /b 0


:PUBLICAR
cls
echo.
echo   Gerando um endereco publico temporario.
echo.
start "" PUBLICAR-TEMPORARIO.bat
exit /b 0


:REAL
cls
start "" TESTE-BUYBACK.bat
exit /b 0


:AGENTES
cls
echo.
node scripts\agents-report.mjs
goto FIM


:BACKUP
cls
start "" BACKUP.bat
exit /b 0


:TESTES
cls
echo.
echo   Rodando a bateria completa. Leva menos de um minuto.
echo.
call npm test
goto FIM


:FIM
echo.
echo  --------------------------------------------------
pause
goto MENU


:SEM_NODE
echo.
echo   [X] Node.js nao foi encontrado nesta maquina.
echo.
echo       1. Abra https://nodejs.org
echo       2. Baixe o instalador LTS
echo       3. Clique duas vezes e va avancando ate o fim
echo       4. Reinicie o computador
echo.
pause
exit /b 1


:PASTA_ERRADA
echo.
echo   [X] Nao encontrei os arquivos do projeto nesta pasta.
echo       Extraia o Tsunami.zip antes (botao direito, "Extrair tudo")
echo       e rode este arquivo de dentro da pasta extraida.
echo.
echo   Pasta atual: %CD%
echo.
pause
exit /b 1
