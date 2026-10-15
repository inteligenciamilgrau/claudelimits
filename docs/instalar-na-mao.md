# Instalar na mão

O instalador (`node instalar.js`) não faz mágica: são três passos para o
Claude Code e três para o Codex. Use esta página se quiser saber exatamente o
que ele grava, ou se preferir fazer você mesmo.

Nos exemplos, troque `<PASTA>` pela pasta deste projeto e `<NODE>` pelo
caminho do seu node, **com barra normal** (`C:/Users/Ana/cota`), inclusive no
Windows.

> **Some, não substitua.** Se o arquivo de configuração já existe, acrescente
> estas chaves ao que está lá. Colar o bloco por cima apaga suas permissões,
> modelo, tema e os hooks de outras ferramentas.

## Comum aos dois: o node-local.txt

Crie `<PASTA>/node-local.txt` com uma linha só: o caminho completo do node
(`C:\Program Files\nodejs\node.exe`, `/usr/local/bin/node`...). É por ele que
os hooks acham o node mesmo quando o node não está no PATH do editor. O
arquivo fica fora do git.

## Claude Code

**1. `~/.claude/settings.json`** — os cinco hooks.

No Windows, o comando é sempre `powershell ... -File <PASTA>/run.ps1 <script>`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/aviso.js" }] }
    ],
    "PreToolUse": [
      { "matcher": "Agent|Task|Workflow",
        "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/admissao.js" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/medidor.js" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/medidor.js" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/medidor.js" }] }
    ]
  }
}
```

No Linux e no macOS, troque cada `command` por `"<NODE>" "<PASTA>/<script>"`.

Caminho com espaço vai **entre aspas duplas** — no JSON, `\"...\"` — senão o
comando falha calado.

**2. A skill.** Copie `skill/SKILL.modelo.md` para
`~/.claude/skills/cota/SKILL.md` e troque os `{{COTA}}` por
`<NODE> <PASTA>/cota.js`, com barra normal nos dois caminhos (o agente roda
isso pelo Bash, onde a barra invertida é escape) e entre aspas se houver espaço.

**3. Abra uma conversa nova.** Hooks e skills são lidos quando ela começa.

## Codex

**1. `~/.codex/hooks.json`** (ou `$CODEX_HOME/hooks.json`) — os cinco hooks.
O `statusMessage` começando com `cota-codex:` é como o instalador e o `audit`
reconhecem os hooks do cota.

No Windows:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "timeout": 30, "statusMessage": "cota-codex:UserPromptSubmit",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/codex.js aviso" }] }
    ],
    "PreToolUse": [
      { "matcher": "^(Agent|spawn_agent)$",
        "hooks": [{ "type": "command", "timeout": 30, "statusMessage": "cota-codex:PreToolUse",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/codex.js admissao" }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "timeout": 30, "statusMessage": "cota-codex:SubagentStart",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/codex.js medidor" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "timeout": 60, "statusMessage": "cota-codex:SubagentStop",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/codex.js medidor" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "timeout": 3, "statusMessage": "cota-codex:SessionEnd",
                    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 hooks/codex.js medidor" }] }
    ]
  }
}
```

No Linux e no macOS, troque cada `command` por
`"<NODE>" "<PASTA>/hooks/codex.js" <modo>`, com o mesmo modo do exemplo
(`aviso`, `admissao` ou `medidor`).

**2. A skill.** Copie `skill/SKILL.codex.modelo.md` para
`~/.codex/skills/cota-codex/SKILL.md` e troque os `{{COTA}}` pelo comando
completo. No Windows o Codex roda os comandos no PowerShell:
`& '<NODE>' '<PASTA>/cota.js' --codex`. No Linux e no macOS:
`'<NODE>' '<PASTA>/cota.js' --codex`.

**3. Aprove os hooks.** O Codex só executa hook que você revisou e aprovou:
abra o Codex no terminal (`codex`), digite `/hooks` e aprove os cinco
`cota-codex`. Cada mudança no comando pede aprovação de novo. Depois abra uma
conversa nova.

## Conferir

Rode `node cota.js audit` (ou `node cota.js --codex audit`). Ele diz em que
elo a corrente quebrou, se quebrou.
