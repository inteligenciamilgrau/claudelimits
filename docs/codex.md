# cota no Codex

O cota funciona com o **Codex local**: o CLI e a extensão do VS Code. Esta
página explica o que muda em relação ao Claude Code. Para instalar, use o
mesmo instalador (veja o [README](../README.md)): ele detecta o Codex sozinho.

Todos os comandos do cota funcionam no Codex com `--codex`:

```bash
node cota.js --codex                 # as duas janelas e a recomendação de economia
node cota.js --codex cabe 4          # cabem 4 subagentes agora?
node cota.js --codex sondar --json   # lê agora, ignorando o cache
node cota.js --codex checkpoint      # consulta rápida entre etapas
node cota.js --codex audit           # diagnóstico, incluindo os hooks
```

(`cota.cmd --codex` no Windows, `./cota --codex` no Linux e no macOS.)

## Como o saldo é lido

O cota executa `codex app-server --stdio` e conversa com ele em três mensagens:
`initialize`, `initialized` e `account/rateLimits/read`. Não abre conversa nem
turno de modelo, então **não gasta cota**. Quem fala com os serviços da OpenAI
é o próprio Codex, com o login que ele já tem; o cota não lê credencial.

As janelas são reconhecidas pela duração: 300 minutos (5h) e 10080 minutos
(semanal). Formato inesperado ou janela ausente vira "sem dado", nunca zero.

O `--json` também traz os outros limites, os créditos e os resets guardados.
O cota **só mostra** créditos e resets: nunca compra nem consome. O `cabe`
considera só as duas janelas gerais.

### Onde o Codex é procurado

Nesta ordem: `$COTA_CODEX` (caminho absoluto), o PATH, `~/.local/bin` e o
binário embutido na extensão `openai.chatgpt` do VS Code (também Insiders,
Cursor e Windsurf), ignorando versões que o editor marcou como obsoletas.

### Onde fica o estado

Em `~/.codex/cota/` (ou `$CODEX_HOME/cota`), separado do Claude. Para outra
pasta, use `COTA_CODEX_DIR`.

**Trocou de conta ou de plano?** A base de medição antiga vai para
`cota/arquivo/` e a nova começa do zero: o custo medido numa conta não vale
para outra. A troca é percebida na consulta seguinte (o cache dura 60s).

## Hooks: o que muda no Codex

Os cinco hooks são os mesmos do Claude, com estas diferenças:

- **Precisam da sua aprovação.** O Codex só executa hook que você revisou e
  aprovou: abra o Codex no terminal (`codex`), digite `/hooks` e aprove os
  cinco `cota-codex`. Qualquer mudança no comando — reinstalar depois de mover
  a pasta, por exemplo — pede aprovação de novo. O instalador não contorna
  isso, de propósito. Sem a aprovação a consulta funciona, mas a medição
  automática dos subagentes não.
- **Não perguntam, informam.** No Codex o `PreToolUse` não pode pedir
  confirmação, então a admissão entrega o aviso como contexto para o agente.
- **Não bloqueiam nem cancelam** subagentes; o `SessionEnd` só faz limpeza
  local, em no máximo três segundos.
- **Órfãos:** sem um registro público de sessões como o do Claude, subagentes
  que ficaram "em voo" são descartados pelo `SessionEnd` ou depois de 48h.
- **Nuvem:** hooks locais não rodam em orquestração na nuvem. Lá a consulta
  explícita funciona onde houver CLI e login, mas a medição automática não é
  garantida; sem amostras, o `cabe` responde `SEM BASE`.

O comando de cada hook é legível em `/hooks`. No Windows:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:/.../cota/run.ps1" hooks/codex.js medidor
```

O mesmo formato dos hooks do Claude, que funciona em cmd, PowerShell e bash.

### Os hooks estão rodando?

O `audit --json` separa duas coisas: **estar instalado** (os hooks estão no
`hooks.json`) e **estar rodando** (o cota viu um `SubagentStart` seguido do
`SubagentStop` do mesmo agente). `coleta: nao_observada` quer dizer que nenhum
evento chegou ainda — quase sempre falta aprovar em `/hooks`.

## Estimativa por perfil

O custo de um subagente depende do modelo, do esforço e da velocidade. Para
estimar um perfil específico:

```bash
node cota.js --codex cabe 2 --modelo modelo-exato --esforco high --velocidade standard
```

- Campo omitido fica **desconhecido**, não vira o padrão do Codex.
- Perfis diferentes não emprestam médias entre si; os disponíveis aparecem em
  `estimativa.perfisDisponiveis` no `--json`.
- Trecho com perfis misturados, ou em que um subagente trocou de perfil, não
  entra na média de nenhum perfil.
- Amostras perdem metade do peso a cada 7 dias e saem depois de 30
  (`estimativa.meia_vida_dias` e `estimativa.max_dias`). A poda dos arquivos
  (`poda.dias`, 14 por padrão) pode removê-las antes.

A saída mostra quantas amostras há, a idade, a variação e a **confiança** da
base: `insuficiente`, `baixa` ou `moderada`. São critérios heurísticos, não
garantia estatística. O consumo é sempre da conta inteira: inclui a conversa
principal e qualquer outra atividade ao mesmo tempo.

## Economia entre etapas

Uma política simples, só do Codex, para não abrir ondas de subagentes quando
a cota está no fim. Vale a janela mais gasta (5h ou semanal), em **%
consumido** como todo número do cota:

| Consumido | Nível | Recomendação |
|---|---|---|
| até 70% | `normal` | pode abrir ondas; consulte entre etapas |
| mais de 70% | `reduzir` | evitar ondas novas; preferir trabalho sequencial |
| mais de 85% | `concluir` | terminar o trecho atual, registrar pendências e informar o reset |

A comparação é estrita: exatamente 70% ainda é `normal`. Leitura velha
(`piso`) é um mínimo — o consumo real pode ser maior. Sem dado utilizável, a
política não recomenda onda nova (`sem_dado`).

```bash
node cota.js --codex config economia.reduzir_acima_de 70
node cota.js --codex config economia.concluir_acima_de 85
node cota.js --codex config economia.ligado false
```

Quando a política diz não, o `cabe` recomenda onda zero; o resultado da conta
continua em `veredito_calculo` e `quantos_cabem_calculo`. É recomendação: os
hooks acrescentam contexto, nada é bloqueado ou cancelado.

(A primeira versão usava % restante, em `evitar_ondas_abaixo_pct` e
`concluir_abaixo_pct`. Essas chaves continuam valendo: são convertidas
sozinhas.)

## Erros em JSON

Com `--json`, toda falha sai como `{ "ok": false, "erro": { "codigo",
"mensagem", "acao" } }`, preservando os outros dados de diagnóstico. Código de
saída 1 é falha; 2 é ferramenta desligada. `EPERM`/`EACCES` vêm com orientação
sobre cache e sandbox (`COTA_CODEX_DIR` escolhe outra pasta de cache; isso não
substitui o acesso ao login do Codex). No Codex, comando desconhecido também é
erro — no Claude, por decisão de projeto (D27), não é.

## O que já foi validado

- Consulta real, cache, JSON, erros e diagnóstico, no Windows.
- Um subagente curto, sem histórico herdado, disparou sozinho `SubagentStart` e
  `SubagentStop`, e o cota gravou a duração e o trecho no estado real. Os hooks
  não foram invocados à mão para produzir essa prova.
- O comando de hook gerado pelo instalador roda pelo cmd, pelo PowerShell e
  pelo bash do Git, num caminho com espaço e acento (`node teste`).

E o que ainda não:

- Uma amostra de poucos segundos **não calibra** a estimativa. Na validação, o
  modelo veio no evento, mas esforço e velocidade não.
- Linux, macOS e orquestração na nuvem não foram testados de verdade.
- Uma validação numa sessão não garante os hooks em todas as superfícies do Codex.

## Testes

`node teste` roda tudo. Os do Codex (`teste/codex.js`, `teste/codex-erros.js`,
`teste/codex-estimativa.js`) usam um app-server falso e estado temporário: não
usam rede nem gastam cota.

Referências oficiais: [app-server](https://learn.chatgpt.com/docs/app-server) e
[hooks](https://learn.chatgpt.com/docs/hooks).
