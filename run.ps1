# run.ps1 — wrapper unico dos hooks no Windows, no formato documentado da Anthropic:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <caminho>\run.ps1 <script> [args]
#
# Por que assim: o executavel e um nome simples ("powershell", que esta no PATH)
# e o caminho vai como ARGUMENTO. Funciona tanto se quem executa usar cmd.exe
# (que estraga barra normal no executavel) quanto bash (que come barra
# invertida) ou o proprio PowerShell. Foi a lambanca das duas tentativas
# anteriores. Serve aos dois: Claude Code (run.ps1 hooks/aviso.js) e Codex
# (run.ps1 hooks/codex.js aviso) - e o comando fica legivel em /hooks.
#
# Usa $args e NAO param(): com param() o PowerShell tenta ligar o stdin a um
# parametro e falha antes de rodar qualquer coisa.

# Sem isto, com o stderr redirecionado (como nos hooks), o PowerShell despeja
# a barra de progresso "Preparando modulos para primeiro uso" como XML no stderr.
$ProgressPreference = 'SilentlyContinue'

$alvoRel = $args[0]
if (-not $alvoRel) { exit 0 }
$resto = @($args | Select-Object -Skip 1)

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
  # UTF8 explicito: o node-local.txt sai do Node em UTF-8 e o PowerShell 5.1
  # le como ANSI por padrao. Um caminho com acento (C:\Users\Ana Conceicao, com cedilha e til)
  # viraria lixo, e o hook falharia CALADO.
  $lido = (Get-Content $arqLocal -First 1 -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($lido) { $lido = $lido.Trim() }
  if ($lido -and (Test-Path $lido)) { $node = $lido }
}
if (-not $node -and $env:COTA_NODE -and (Test-Path $env:COTA_NODE)) { $node = $env:COTA_NODE }
if (-not $node) { $node = 'node' }

$alvo = Join-Path $dir $alvoRel

# Repassa o stdin (o JSON do hook) para o node.
$entrada = $input | Out-String
$entrada | & $node $alvo @resto
