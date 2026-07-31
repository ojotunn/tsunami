@echo off
cd /d "%~dp0"
title Blizzard Agents - endereco publico temporario

echo.
echo  ==================================================
echo    Blizzard Agents - publicar temporariamente na internet
echo  ==================================================
echo.
echo   Cria um endereco https publico apontando para o
echo   site rodando NESTA maquina. Enquanto esta janela
echo   ficar aberta, o site fica no ar.
echo.

where node >nul 2>&1
if errorlevel 1 goto SEM_NODE

if not exist "src\web\server.js" goto PASTA_ERRADA

echo   Node.js encontrado:
node -v
echo.

if exist cloudflared.exe goto TEM_CLOUDFLARED

echo   Baixando o cloudflared (uma unica vez)...
echo.
curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
if errorlevel 1 goto ERRO_DOWNLOAD
if not exist cloudflared.exe goto ERRO_DOWNLOAD
echo.

:TEM_CLOUDFLARED
echo   cloudflared pronto.
echo.
echo   Subindo o site e o tunel...
echo   O endereco publico vai aparecer aqui e tambem sera salvo
echo   no arquivo LINK-DO-SITE.txt, que abre sozinho.
echo.

set PONS_SECURE_COOKIES=1
node scripts\tunnel.mjs

echo.
echo   Tunel encerrado. O link anterior nao funciona mais.
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


:ERRO_DOWNLOAD
echo.
echo   [X] Nao consegui baixar o cloudflared.
echo       Verifique a internet e tente de novo.
echo.
pause
exit /b 1
