#!/bin/sh
# Instalador do cota para Linux e macOS:
#   sh instalar.sh
#
# Acha um Node.js 18+ (ou diz como instalar) e chama o instalar.js, que liga o
# cota ao Claude Code e/ou ao Codex. Pelo terminal dá no mesmo: node instalar.js
#
# Os lugares de fora do PATH importam: o VS Code aberto pelo Dock não vê o PATH
# do seu shell, e é por isso que o instalar.js grava o caminho absoluto do node.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

ok() {
  [ -n "$1" ] && [ -x "$1" ] &&
    "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null
}

NODE=""
LOCAL=$(head -n 1 "$DIR/node-local.txt" 2>/dev/null | tr -d '\r\n')
for c in "$LOCAL" "$COTA_NODE" "$(command -v node 2>/dev/null)" \
         /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.volta/bin/node"; do
  if ok "$c"; then NODE="$c"; break; fi
done
# nvm: fica com a última versão boa da lista.
if [ -z "$NODE" ]; then
  for c in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if ok "$c"; then NODE="$c"; fi
  done
fi

if [ -z "$NODE" ]; then
  echo ""
  echo "  O cota precisa do Node.js 18 ou mais novo (gratuito), e não achei um."
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "  Instale com:  brew install node"
  else
    echo "  Instale a versão LTS de https://nodejs.org"
    echo "  (o nodejs do apt costuma ser velho demais)."
  fi
  echo "  Depois rode de novo:  sh instalar.sh"
  echo ""
  exit 1
fi

exec "$NODE" "$DIR/instalar.js" "$@"
