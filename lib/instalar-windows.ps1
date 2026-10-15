# instalar-windows.ps1 — o que o INSTALAR.cmd roda (dois cliques no Windows).
#
# Só faz o que um leigo não deveria precisar fazer na mão: achar um Node.js 18+
# (ou instalar um, se a pessoa aceitar) e chamar o instalar.js com ele. Todo o
# resto — detectar Claude/Codex, gravar hooks e skills, conferir — é do
# instalar.js, igual para quem roda pelo terminal.
#
# Este arquivo é salvo em UTF-8 COM BOM: sem ele o PowerShell 5.1 lê como
# ANSI e os acentos das mensagens saem trocados.

$ProgressPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Node 18 ou mais novo? Pergunta ao próprio executável.
function Test-NodeOk($exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $false }
  try { $v = & $exe --version } catch { return $false }
  return ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18)
}

# A mesma ordem dos atalhos (node-local.txt, COTA_NODE, PATH), mais os lugares
# onde os instaladores do Node costumam deixar o node.exe fora do PATH.
function Find-Node {
  $cand = @()
  $local = Join-Path $raiz 'node-local.txt'
  # UTF8 explícito: o PowerShell 5.1 leria como ANSI e estragaria caminho com acento.
  if (Test-Path $local) { $cand += (Get-Content $local -First 1 -Encoding UTF8).Trim() }
  if ($env:COTA_NODE) { $cand += $env:COTA_NODE }
  $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $cand += $cmd.Source }
  $cand += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  if (${env:ProgramFiles(x86)}) { $cand += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $cand += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  if ($env:NVM_SYMLINK) { $cand += (Join-Path $env:NVM_SYMLINK 'node.exe') }
  foreach ($c in $cand) { if (Test-NodeOk $c) { return $c } }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Host ''
  Write-Host '  O cota precisa do Node.js (gratuito), e não achei um instalado.'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $r = Read-Host '  Posso instalar o Node.js agora? [S/n]'
    if ($r -eq '' -or $r -match '^[sSyY]') {
      Write-Host '  Instalando pelo winget. O Windows pode pedir permissão: aceite.'
      & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
      # O PATH desta janela é o de antes da instalação: relê o do sistema.
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                  [Environment]::GetEnvironmentVariable('Path', 'User')
      $node = Find-Node
    }
  }
  if (-not $node) {
    Write-Host ''
    Write-Host '  Instale a versão LTS do Node.js pelo site (é só ir clicando em Avançar):'
    Write-Host '    https://nodejs.org'
    Write-Host '  Depois dê dois cliques no INSTALAR.cmd de novo.'
    Start-Process 'https://nodejs.org'
    exit 1
  }
}

& $node (Join-Path $raiz 'instalar.js') @args
exit $LASTEXITCODE
