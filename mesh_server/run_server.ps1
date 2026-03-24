# run_server.ps1
# Inicia o servidor de malha (mesh_server).
#
# Uso:
#   .\run_server.ps1           # porta padrão 7070
#   .\run_server.ps1 -Port 8080
#
# PRÉ-REQUISITO:
#   O executável mesh_server.exe deve ser obtido com o professor
#   e colocado nesta pasta (mesh_server/).

param([int]$Port = 7070)

$ServerExe = Join-Path $PSScriptRoot "mesh_server.exe"

if (-not (Test-Path $ServerExe)) {
    Write-Error @"
mesh_server.exe nao encontrado em: $ServerExe

Obtenha o executavel com o professor e coloque-o nesta pasta.
"@
    exit 1
}

Write-Host "Iniciando mesh_server na porta $Port..."
Write-Host "Pressione Ctrl+C para encerrar."
Write-Host ""
& $ServerExe $Port
