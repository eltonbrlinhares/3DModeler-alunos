#!/usr/bin/env bash
# run_server.sh
# Inicia o servidor de malha (mesh_server) no Linux/macOS.
#
# Uso:
#   ./run_server.sh           # porta padrão 7070
#   ./run_server.sh 8080
#
# PRÉ-REQUISITO:
#   O executável mesh_server deve ser obtido com o professor
#   e colocado nesta pasta (mesh_server/).

PORT=${1:-7070}
DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$DIR/mesh_server"

if [ ! -f "$SERVER" ]; then
    echo "ERRO: executável 'mesh_server' não encontrado em: $SERVER"
    echo ""
    echo "Obtenha o executável com o professor e coloque-o nesta pasta."
    exit 1
fi

chmod +x "$SERVER"
echo "Iniciando mesh_server na porta $PORT..."
echo "Pressione Ctrl+C para encerrar."
echo ""
"$SERVER" "$PORT"
