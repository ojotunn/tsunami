# pons-mm — imagem única, sem dependências de npm.
FROM node:22-alpine

# Usuário sem privilégios: o processo guarda keystores, não deve rodar como root.
RUN addgroup -S pons && adduser -S pons -G pons

WORKDIR /app
COPY --chown=pons:pons package.json ./
COPY --chown=pons:pons src ./src
COPY --chown=pons:pons scripts ./scripts
COPY --chown=pons:pons test ./test

# /data é volume: banco e keystores vivem fora da imagem.
RUN mkdir -p /data/keystores && chown -R pons:pons /data
ENV PONS_DB=/data/pons.sqlite \
    PONS_KEYSTORE_DIR=/data/keystores \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production

EXPOSE 8787

# Sem instrucao VOLUME de proposito: o Railway recusa o build se ela existir
# ("docker VOLUME is not supported, use Railway Volumes"), porque la o volume e
# criado no painel e montado sobre o caminho. Os outros alvos ja declaram o
# volume por fora — docker-compose.yml em `volumes: pons-data:/data` e fly.toml
# em [[mounts]] — entao nada se perde tirando daqui.
#
# O QUE IMPORTA EM QUALQUER UM DELES: o ponto de montagem tem que ser /data,
# igual ao PONS_DB e ao PONS_KEYSTORE_DIR acima. Montar em outro caminho faz o
# servidor subir, criar um banco vazio dentro da imagem, e perder tudo no
# proximo redeploy — inclusive as chaves privadas dos agentes.

# Volume montado pelo provedor costuma vir pertencendo ao root, e ai o processo
# — que roda como `pons`, sem privilegio — nao consegue escrever em /data. O
# sintoma engana: parece defeito de codigo, e permissao. Por isso o container
# comeca como root SO para ajustar o dono do volume ja montado, e imediatamente
# larga o privilegio com `su-exec` antes de executar o servidor. O processo que
# guarda as chaves nunca roda como root.
RUN apk add --no-cache su-exec

COPY --chown=pons:pons docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/web/server.js"]
