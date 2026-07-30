#!/bin/sh
# Ajusta o dono do volume e larga o privilegio de root antes de subir o servidor.
#
# Existe por um motivo especifico: provedores (Railway, Fly, VPS com docker)
# montam o volume pertencendo ao root. Como o servidor roda como `pons`, ele nao
# conseguiria criar o banco nem escrever os keystores — e o erro que aparece nao
# fala em permissao, fala em falha ao abrir o arquivo.
set -e

DATA_DIR="$(dirname "${PONS_DB:-/data/pons.sqlite}")"
KEYS_DIR="${PONS_KEYSTORE_DIR:-/data/keystores}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$KEYS_DIR"
  # -R so no que precisa; o volume pode ter muitos keystores e um chown -R cego
  # em disco grande atrasaria todo arranque.
  chown pons:pons "$DATA_DIR" "$KEYS_DIR"
  find "$DATA_DIR" -maxdepth 2 ! -user pons -exec chown pons:pons {} +
  exec su-exec pons "$@"
fi

exec "$@"
