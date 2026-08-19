# run.ps1 — wrapper unico, no formato documentado da Anthropic para Windows:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <caminho>\run.ps1 <script>
#
# Por que assim: o executavel e um nome simples ("powershell", que esta no PATH)
# e o caminho vai como ARGUMENTO. Funciona tanto se o Claude Code executar via
# cmd.exe (que estraga barra normal no executavel) quanto via bash (que come
# barra invertida). Foi a lambanca das duas tentativas anteriores.
#
# Usa $args e NAO param(): com param() o PowerShell tenta ligar o stdin a um
# parametro e falha antes de rodar qualquer coisa.

$alvoRel = $args[0]
if (-not $alvoRel) { exit 0 }

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Onde esta o node, em ordem de precedencia:
#   1. node-local.txt  — gravado pelo instalar.js, fora do git (caminho da maquina)
#   2. $env:COTA_NODE  — para quem prefere variavel de ambiente
#   3. "node" no PATH  — o caso normal em maquina bem configurada
#
# O arquivo local existe porque nem toda instalacao poe o node no PATH, e sem
# ele o hook falha CALADO: nada roda, nada e gravado, nenhum erro aparece.
$node = $null
$arqLocal = Join-Path $dir 'node-local.txt'
if (Test-Path $arqLocal) {
  $lido = (Get-Content $arqLocal -First 1 -ErrorAction SilentlyContinue)
  if ($lido) { $lido = $lido.Trim() }
  if ($lido -and (Test-Path $lido)) { $node = $lido }
}
if (-not $node -and $env:COTA_NODE -and (Test-Path $env:COTA_NODE)) { $node = $env:COTA_NODE }
if (-not $node) { $node = 'node' }

$alvo = Join-Path $dir $alvoRel

# Repassa o stdin (o JSON da status line / do hook) para o node.
$entrada = $input | Out-String
$entrada | & $node $alvo
