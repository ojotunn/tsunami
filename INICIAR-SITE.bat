@echo off
cd /d "%~dp0"
title Blizzard Agents - site local

echo.
echo  ==================================================
echo    Blizzard Agents - iniciando o site na sua maquina
echo  ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto SEM_NODE

echo   Node.js encontrado:
node -v
echo.

if not exist "src\web\server.js" goto PASTA_ERRADA

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto JA_RODANDO

echo   Iniciando o servidor...
echo   Quando aparecer a linha "Blizzard Agents  ^-^>  http://127.0.0.1:8787"
echo   o site esta pronto. O navegador abre sozinho em alguns segundos.
echo.
echo   O navegador abre direto no PAINEL (/app), que e onde fica o botao
echo   "Connect wallet". A pagina inicial e so apresentacao e nao tem botao.
echo.
echo   NAO feche esta janela enquanto estiver usando o site.
echo   Para parar, feche a janela ou aperte Ctrl+C.
echo.

start "" /min cmd /c "timeout /t 5 /nobreak >nul & start "" http://127.0.0.1:8787/app"

node --env-file-if-exists=.env src\web\server.js

echo.
echo  ==================================================
echo    O servidor parou.
echo.
echo    Se ele parou sozinho logo depois de iniciar,
echo    copie as linhas acima e mande para o Claude.
echo  ==================================================
echo.
pause
exit /b 0


:JA_RODANDO
echo   O site JA ESTA RODANDO nesta maquina.
echo.
echo   Nao precisa iniciar de novo. Abra no navegador:
echo.
echo       http://127.0.0.1:8787/app
echo.
echo   O botao "Connect wallet" fica nessa pagina (/app). A pagina inicial
echo   sem o /app e so apresentacao e nao tem botao de conectar.
echo.
echo   Se quiser reiniciar, feche a outra janela preta do Blizzard Agents
echo   e rode este arquivo de novo.
echo.
start "" http://127.0.0.1:8787/app
pause
exit /b 0


:SEM_NODE
echo   [X] Node.js nao foi encontrado nesta maquina.
echo.
echo       1. Abra https://nodejs.org
echo       2. Baixe o instalador LTS
echo       3. Clique duas vezes e va avancando ate o fim
echo       4. Reinicie o computador
echo       5. Rode este arquivo de novo
echo.
pause
exit /b 1


:PASTA_ERRADA
echo   [X] Nao encontrei os arquivos do projeto nesta pasta.
echo.
echo       Isso quase sempre significa que o ZIP nao foi extraido.
echo       Clique com o botao direito no Blizzard Agents.zip, escolha
echo       "Extrair tudo", e rode este arquivo de dentro da
echo       pasta extraida.
echo.
echo   Pasta atual: %CD%
echo.
pause
exit /b 1
