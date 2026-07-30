@echo off
cd /d "%~dp0"
title Tsunami - TESTE COM DINHEIRO REAL

where node >nul 2>&1
if errorlevel 1 goto SEM_NODE
if not exist "src\web\server.js" goto PASTA_ERRADA

cls
echo.
echo  ==================================================
echo    ATENCAO - MODO DE ENVIO REAL
echo  ==================================================
echo.
echo   Este atalho liga o envio de transacoes de verdade.
echo   O que voce aprovar no site VAI para a blockchain e
echo   VAI gastar ETH. Nao tem desfazer.
echo.
echo   Use isto so para o seu teste pequeno.
echo.
echo   Antes de continuar, confirme:
echo.
echo     [ ] Voce fechou a janela do link publico
echo         (senao seus amigos tambem ficam com envio ligado)
echo.
echo     [ ] Voce ja rodou o preflight no token e ele passou
echo.
echo     [ ] O agente tem saldo suficiente:
echo         o valor da compra + gas + a reserva de 0.002 ETH
echo.
set "OK="
set /p OK=  Digite SIM em maiusculas para continuar:
if /I not "%OK%"=="SIM" goto CANCELADO

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto PORTA_OCUPADA

cls
echo.
echo  ==================================================
echo    Envio real LIGADO - http://127.0.0.1:8787
echo  ==================================================
echo.
echo   No site, o passo a passo:
echo.
echo     1. Conecte a carteira
echo     2. Crie o agente (ou selecione o que ja existe)
echo     3. Copie o endereco de deposito e envie o ETH
echo     4. Ligue "Buyback and burn" e ajuste
echo        "ETH per run" para o valor pequeno do teste
echo     5. Clique em "Run agent (simulation)"
echo     6. Na decisao que aparecer, clique em "Approve"
echo     7. Digite a senha do keystore
echo     8. Clique em "Simulate" primeiro e veja passar
echo     9. So entao clique em "Send for real"
echo.
echo   Deve enviar 4 transacoes: wrap, approve, swap, queima.
echo.
echo   Para parar, feche esta janela.
echo.

set PONS_ALLOW_LIVE_EXECUTION=1
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start "" http://127.0.0.1:8787"
node --env-file-if-exists=.env src\web\server.js

echo.
echo   O servidor parou. Envio real desligado.
pause
exit /b 0


:CANCELADO
echo.
echo   Cancelado. Nada foi ligado.
echo.
pause
exit /b 0


:PORTA_OCUPADA
echo.
echo   [X] Ja existe um Tsunami rodando na porta 8787.
echo.
echo       Feche a outra janela preta primeiro - inclusive a do
echo       link publico, se estiver aberta. O envio real precisa
echo       ser iniciado por este atalho para valer.
echo.
pause
exit /b 1


:SEM_NODE
echo.
echo   [X] Node.js nao foi encontrado nesta maquina.
echo       Instale o LTS em https://nodejs.org
echo.
pause
exit /b 1


:PASTA_ERRADA
echo.
echo   [X] Nao encontrei os arquivos do projeto nesta pasta.
echo       Extraia o Tsunami.zip antes e rode de dentro da pasta.
echo.
echo   Pasta atual: %CD%
echo.
pause
exit /b 1
