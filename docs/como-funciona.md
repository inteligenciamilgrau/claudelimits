# Como o cota funciona

Para quem quer entender o que roda, quando e por quê. O porquê de cada decisão,
com o histórico, está em [DECISOES.md](DECISOES.md). O que muda no Codex está
em [codex.md](codex.md).

## Como a cota é lida (Claude Code)

Com o próprio Claude Code, pelo protocolo de controle do CLI — o mesmo que o
Agent SDK e a extensão do VS Code usam:

```
claude -p --input-format stream-json --output-format stream-json --verbose
```

com uma única mensagem na entrada:

```json
{"type":"control_request","request_id":"cota","request":{"subtype":"get_usage","skip_behaviors":true}}
```

A resposta traz o percentual e o horário de reset da janela de 5 horas, da
semanal e da semanal de cada modelo — os números do `/usage` — e o plano da
conta. **Não é prompt**: nenhum modelo é chamado e nenhuma cota é gasta.

Cada leitura leva cerca de 1,5 segundo, então ela **só acontece quando alguém
precisa do número** e a última leitura já envelheceu. Não há processo de fundo
nem timer:

| Quem pede | Lê de novo se a leitura tiver mais de |
|---|---|
| o agente ou você rodando `cota` / `cota cabe` | 60s |
| o hook de admissão, antes de lançar subagentes | 60s |
| o primeiro subagente, quando não há medição em curso | 60s |
| um subagente que termina, se o trecho medido já tem 2min ou se é o último | sempre — é o número que vira custo |
| o vigia, quando um subagente termina | 3min, sem esperar outra leitura |
| o aviso, quando você manda mensagem | 10min, sem esperar outra leitura |

Parado, nada roda. Conversando, no máximo uma leitura a cada 10 minutos. Se
uma leitura falha (sem rede, conta sem plano), ninguém tenta de novo por 5
minutos — senão cada mensagem sua esperaria a falha de novo. `cota sondar`
tenta na hora.

Com isso a ferramenta:

- **avisa** quando a janela passa do limiar, de carona na sua mensagem;
- **pergunta antes** de o agente lançar subagentes com a cota alta;
- **mede** o ritmo de um subagente — quanto da janela ele gasta por hora
  rodando — e quanto tempo eles costumam rodar, e com isso responde quantos
  cabem agora;
- **vigia** a cota enquanto um workflow roda.

## Peças

| Arquivo | Papel | Como roda |
|---|---|---|
| `cota.js` | O leitor: janelas, ritmo, admissão, diagnóstico. `--codex` para o Codex. | você / o agente |
| `lib/sonda.js` | Lê a cota pelo `get_usage` do CLI. A única fonte do número. | chamada pelos outros |
| `lib/core.js`, `lib/analise.js` | Estado, configuração, janelas; o cálculo do `cabe`. | chamada pelos outros |
| `lib/codex/` | O que é só do Codex: leitura pelo app-server, estimativa por perfil, economia, instalador. | chamada pelos outros |
| `hooks/aviso.js` | Avisa quando a cota passa do limiar. | hook `UserPromptSubmit` |
| `hooks/admissao.js` | Pergunta antes de operação pesada com a cota alta. | hook `PreToolUse` |
| `hooks/medidor.js` | Mede o custo de cada subagente, em trechos, e vigia. | hooks `SubagentStart` / `SubagentStop` / `SessionEnd` |
| `hooks/codex.js` | Porta de entrada dos hooks no Codex. | hooks do Codex |
| `skill/*.modelo.md` | Ensinam o agente a usar. O instalador gera o literal. | skill |
| `instalar.js` | Liga tudo nesta máquina, **confere** que ligou, e desfaz. | `node instalar.js` |
| `INSTALAR.cmd`, `instalar.sh` | Acham (ou ajudam a instalar) o node e chamam o `instalar.js`. | dois cliques / `sh instalar.sh` |
| `run.ps1` | Invólucro dos hooks no Windows. | os hooks |
| `cota.cmd` / `cota` | Atalho de linha de comando: Windows / Linux e macOS. | você |
| `teste/` | Testes de ponta a ponta, com Claude e Codex falsos. | `node teste` |

O estado fica em `~/.claude/cota/` (e `~/.codex/cota/` no Codex) — nada é
gravado dentro do repositório, fora o `node-local.txt` do instalador.

## Configuração

`~/.claude/cota/config.json`, mudável por comando (`cota config <chave> <valor>`),
vale na próxima chamada. **Todo percentual é consumido**, nunca restante.

| Chave | Padrão | O quê |
|---|---|---|
| `ligado` | `true` | Chave geral. Desligada, nada lê, avisa nem mede. |
| `idade_max_s` | `900` | Leitura mais velha que isso (a sonda falhando) passa a valer como piso. |
| `aviso.limiar_5h` | `80` | % da janela de 5h para começar a avisar. |
| `aviso.limiar_7d` | `70` | Mais baixo de propósito: estourar a semanal custa dias. |
| `aviso.repetir_min` | `30` | Intervalo mínimo entre avisos iguais. |
| `admissao.perguntar_acima_de` | `75` | % a partir do qual o `PreToolUse` pergunta. |
| `admissao.margem` | `0.7` | Só autoriza se couber em 70% do que resta. |
| `vigia.limiar_5h` | `70` | % a partir do qual o vigia fala no fim de cada subagente. |
| `vigia.repetir_min` | `5` | Curto: durante workflow a cota anda rápido. |
| `medidor.orfao_max_s` | `172800` | Subagente em voo é órfão quando a sessão dele fechou ou morreu; esta idade (48h) só decide quando o Claude Code não diz. |
| `medidor.trecho_s` | `120` | Quem termina só lê a cota se o trecho medido já tem isso; senão a parte dele sai no próximo marco. |
| `poda.dias` | `14` | Histórico mais velho que isso sai. |
| `poda.max_linhas` | `5000` | Teto de linhas nos arquivos de amostra. |
| `sonda.idade_s` | `60` | Idade a partir da qual o `cota`, a admissão e a abertura de onda leem de novo. |
| `sonda.vigia_s` | `180` | Idem para o vigia. |
| `sonda.aviso_s` | `600` | Idem para o aviso — alto porque ele atrasa a sua mensagem. |

No Codex há também `estimativa.*` e `economia.*` — veja [codex.md](codex.md).

## O que sai da sua máquina

O código deste projeto não fala com rede e não lê credencial. Mas cada leitura
abre uma sessão do `claude` oficial (ou do `codex`), e **essa sessão fala com
a Anthropic** (ou com a OpenAI), com o login que a ferramenta já tem: consulta
o uso do seu plano e o que mais ela envia ao iniciar. Em uso ativo isso
acontece até uma vez por minuto; parado, nunca.

A sessão da leitura do Claude roda isolada: sem gravar conversa, sem hooks, sem
servidores MCP, sem as configurações do projeto em que você está, e dentro de
`~/.claude/cota/`.

## De onde vem o `claude`

A cada leitura, nesta ordem: `$COTA_CLAUDE`, o PATH (só entradas absolutas),
`~/.local/bin`, e o binário embutido na extensão do VS Code. No Windows só vale
`.exe`.

A pasta da extensão **muda a cada atualização** (`anthropic.claude-code-2.1.299-…`
vira `…-2.1.300-…`), e a velha fica no disco até o VS Code limpar. Por isso o
caminho nunca é gravado: cada leitura procura de novo pela versão que o VS Code
registra como instalada, ignorando as obsoletas. Se um candidato nem executar,
vai o próximo. Quando o executável muda, o `cota sondar` avisa:
`mudou de extensão 2.1.299 há 5min, achado sozinho`.

## Por que existe um `run.ps1` no Windows

Porque os dois jeitos óbvios de chamar o node falham, cada um num shell, e
**os dois falham calados**:

| Comando | Falha porque |
|---|---|
| `C:\...\node.exe C:\...\aviso.js` | o `cmd.exe` lê o `/c` de `/claude-limits` como switch dele |
| `C:\...\aviso.cmd` | o bash come as barras invertidas como escape |

O formato documentado da Anthropic é imune aos dois: executável com nome simples
que está no PATH (`powershell`) e caminho como argumento. O Codex usa o mesmo.

O `run.ps1` lê o caminho do node do `node-local.txt` em UTF-8 — lido do jeito
padrão do PowerShell 5.1, um nome de usuário com acento (`C:\Users\Ana Conceição`)
quebraria os hooks sem nenhum erro aparecer.

## Limitações

- **A leitura do Claude se apoia num pedido não documentado.** O `get_usage` é
  o que a extensão do VS Code usa no medidor dela, mas não está na
  documentação, e o método do SDK que o envia se chama
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Se mudar, a
  ferramenta para e diz qual elo quebrou — nunca inventa número. Se sumir, o
  plano B é voltar ao `/usage` como prompt; a receita está no
  [DECISOES.md](DECISOES.md), D39.
- **A Anthropic publica percentual e horário de reset, não o limite em número
  absoluto.** E o percentual vem inteiro: uma onda curta que custou 0,4% mede 0.
- **Não há projeção de consumo, de propósito.** O uso real é por rajadas, e
  nenhuma média entre os regimes descreve qualquer um deles. O ritmo mostrado é
  medição da última hora, não previsão.
- **O ritmo por subagente é divisão, não atribuição.** O que a cota sobe num
  trecho é dividido pelas horas de subagente rodando nele — de todas as
  sessões, porque os hooks são globais. Subagentes no mesmo trecho saem com o
  mesmo ritmo: um Opus pesado ao lado de um Haiku leve não se distinguem ali.
  A conversa principal das sessões também entra na conta e infla o ritmo — o
  lado seguro.
- **Agente longo atravessa janelas.** Um subagente de 12h gasta de três
  janelas de 5h. O `cabe` conta, na janela de 5h, só o tempo até o reset; a
  semanal paga a duração inteira, e para trabalho longo é ela que manda.
- **O sub-limite semanal por modelo é mostrado, mas não decide:** a admissão
  usa só a janela de 5h e a semanal geral.
- **Relógio da máquina torto = countdown mentiroso.** O `audit` desconfia.
- **Promoções mudam o denominador:** com o limite temporariamente maior, o
  percentual de hoje não é comparável com o de depois.

## Plataformas

O núcleo é Node puro, sem dependência. O que muda por plataforma é o invólucro
dos hooks, e o instalador escreve o certo.

> **Aviso honesto:** o projeto nasceu e é usado no Windows. O suporte a Linux e
> macOS foi escrito e a geração de comando é testada, mas **nunca rodou nessas
> plataformas**. Se for o primeiro, rode `node teste` antes e abra uma issue
> se algo não bater.

## Segurança

Sem `eval`, sem `new Function`, sem `require` dinâmico, sem shell. Os únicos
processos externos são o `claude` e o `codex` oficiais (e o `powershell`, que
roda os hooks no Windows), chamados com argumentos em lista. O estado é gravado
com permissão `0600`. O que foi sondado e corrigido está em
[DECISOES.md](DECISOES.md), seção "Segurança".

## A verdade é o `/usage`

Os números são os mesmos do `/usage` (no Codex, do `/status`), lidos da própria
ferramenta. O que pode errar é o resto — o custo por agente, a admissão, as
ondas. Na dúvida, o `/usage` da extensão ou do terminal é a referência.
