# cota

Lê os limites de uso do Claude Code, aprende quanto custa um subagente, e
responde a pergunta que interessa: **a cota aguenta lançar 10 agentes em
paralelo? E se não, quantos agora?**

![A status line mostrando as duas janelas de cota, e a saída do comando cota](exemplo.jpg)

Só superfícies oficiais documentadas da Anthropic — sem API interna, sem token
de credencial, sem formato não documentado. As decisões de projeto e o porquê de
cada uma estão em [DECISOES.md](DECISOES.md).

## Peças

| Arquivo | Papel | Como roda |
|---|---|---|
| `sensor.js` | **Sensor.** A única coisa que enxerga `rate_limits`. Só observa e grava. | status line |
| `cota.js` | **Leitor.** Toda a lógica: janelas, ritmo, admissão, audit. | você / o agente |
| `hooks/aviso.js` | Aviso quando a cota passa do limiar. Pega carona na sua mensagem. | hook `UserPromptSubmit` |
| `hooks/admissao.js` | Pergunta antes de operação pesada com a cota alta. | hook `PreToolUse` |
| `hooks/medidor.js` | Mede o custo de cada onda de subagentes, e vigia durante o workflow. | hooks `SubagentStart` / `SubagentStop` |
| `skill/SKILL.modelo.md` | Ensina o agente a usar a ferramenta. O instalador gera o literal. | skill |
| `instalar.js` | Liga tudo nesta máquina, e **confere** que ligou. | `node instalar.js` |
| `run.ps1` | Invólucro do Windows. Existe por um motivo — veja abaixo. | os hooks |
| `cota.cmd` / `cota` | Atalho de linha de comando: Windows / POSIX. | você |
| `teste.js` | Teste de ponta a ponta, com payload sintético. | `node teste.js` |

Estado em `~/.claude/cota/` — nada é gravado dentro do repositório.

## Testar sem instalar nada

```bash
node teste.js
```

229 asserts em diretório temporário. Não encosta no seu estado real.

## Instalar

```bash
node instalar.js
```

Rode com o node que você quer usar — ele se registra sozinho. O script:

1. grava `node-local.txt` com o caminho deste node (fica fora do git);
2. gera `~/.claude/skills/cota/SKILL.md` a partir do modelo, com o comando
   literal desta máquina;
3. acrescenta a status line e os quatro hooks em `~/.claude/settings.json`,
   preservando o que já estiver lá e guardando um `.bak-cota`;
4. **executa** o que acabou de gerar e só declara sucesso se responder.

É idempotente: rodar de novo não duplica nada.

Depois **abra uma sessão nova** — hooks e skills são lidos na inicialização.

Não quer depender dele? A receita manual está logo abaixo, e um teste garante
que as duas produzem exatamente a mesma instalação.

## Instalar na mão

O instalador não faz mágica nenhuma — são três passos. Trocando `<PASTA>` pela
pasta deste projeto e `<NODE>` pelo caminho do seu node:

**1. `~/.claude/settings.json`** — status line e os quatro hooks.

> **Some, não substitua.** Se o arquivo já existe, acrescente estas chaves ao
> que está lá. Colar o bloco inteiro por cima apaga suas permissões, modelo e
> tema. Faça uma cópia antes — é o que o instalador faz (`.bak-cota`).

No Windows, o comando é sempre `powershell ... -File <PASTA>/run.ps1 <script>`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File <PASTA>/run.ps1 sensor.js",
    "refreshInterval": 20
  },
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
    ]
  }
}
```

No Linux e no macOS, troque cada `command` por `"<NODE>" "<PASTA>/<script>"` —
por exemplo `"/usr/bin/node" "/home/voce/cota/sensor.js"`. O resto é igual.

**2. A skill.** Copie `skill/SKILL.modelo.md` para
`~/.claude/skills/cota/SKILL.md` e troque os quatro `{{COTA}}` pelo comando
`<NODE> <PASTA>/cota.js`, **com barra normal nos dois caminhos** — o agente roda
isso pelo Bash, onde a barra invertida é escape.

**3. Abra uma sessão nova.** Hooks e skills são lidos na inicialização.

Se o seu `node` não estiver no PATH, grave o caminho dele em
`<PASTA>/node-local.txt` — é só isso que esse arquivo é.

Para conferir: `cota.cmd audit` (Windows) ou `./cota audit`. Ele diz em que elo
a corrente quebrou.

### Por que existe um `run.ps1` no Windows

Porque os dois jeitos óbvios falham, cada um num shell, e **os dois falham
calados**: nada roda, nada é gravado, nenhum erro aparece em lugar nenhum.

| Comando | Falha porque |
|---|---|
| `C:\...\node.exe C:\...\sensor.js` | o `cmd.exe` lê o `/c` de `/claude-limits` como switch dele |
| `C:\...\sensor.cmd` | o bash come as barras invertidas como escape |

O formato documentado da Anthropic é imune aos dois: executável com **nome
simples** que está no PATH (`powershell`) e caminho como **argumento**.

Fora do Windows esse problema não existe — há um shell só, e o instalador
escreve o comando direto:

```
"/usr/bin/node" "/home/voce/cota/sensor.js"
```

O `refreshInterval` não é enfeite: sem ele o sensor congela justamente enquanto
os subagentes trabalham e a sessão principal fica ociosa.

## Quem alimenta o mural (leia isto, é obrigatório)

**Só sessão de terminal executa a status line.** A extensão do VS Code sobe o
`claude` em `stream-json`, sem TUI, e nunca chama o sensor. Se você trabalha na
extensão ou na web, **nada** atualiza a cota — a ferramenta responde com dado
velho ou com nada.

E terminal aberto e parado não resolve: ocioso, ele roda o sensor a cada 20s
mas regrava o mesmo número, porque o `rate_limits` de uma sessão só se renova
quando **ela** recebe resposta da API.

### A receita

Se você trabalha **no terminal**, não precisa de nada: a própria sessão renova a
leitura a cada resposta, e as medições saem limpas.

Se você trabalha **na extensão do VS Code ou na web**, deixe uma janela de
terminal aberta, no modelo mais barato e no esforço mínimo — ela não precisa
pensar, só existir:

```
/loop 3m diga apenas: estou vivo
```

Com `"model": "haiku"` e `"effortLevel": "low"` no `~/.claude/settings.json`,
ou trocando na própria janela antes de iniciar o loop. Três minutos é o
intervalo usado em produção aqui: curto o bastante para um workflow pesado não
cegar a ferramenta, longo o bastante para o custo ser desprezível.

### O preço, que é real

Cada batida escreve no mural, e isso marca como **contaminada** qualquer onda de
subagentes em curso. Medido num workflow real: 8 das 9 ondas saíram sujas, todas
por causa do loop — o número de escritas bate com a cadência (uma onda de 928s
levou 5 batidas). A única limpa foi a de 94 segundos, curta o bastante para
caber entre duas.

A ferramenta usa essas amostras mesmo assim e diz que são contaminadas (D32).
Contaminação **infla** o custo estimado, que é o lado seguro de errar; ficar sem
número nenhum não é. Sem isso, quem trabalha na extensão ficaria em `SEM BASE`
para sempre.

Qualquer segunda sessão causa a mesma contaminação — VS Code e TUI abertos ao
mesmo tempo já bastam. O loop apenas garante que aconteça sempre, em troca de
garantir que o mural nunca congele.

### Como saber se está funcionando

```bash
cota audit
```

A linha `o Claude Code chamou o sensor` diz há quanto tempo e por qual sessão.
Se ela falhar, ou se `leitura fresca` acusar idade alta, o mural está congelado
e nenhuma decisão da ferramenta vale.

## Plataformas

O núcleo é Node puro: `path.join`, `os.homedir()`, leitura e escrita de arquivo.
Não há API de sistema operacional em lugar nenhum do `lib/`, dos hooks, do
sensor ou do leitor. O que muda por plataforma é só o invólucro:

| | Windows | Linux / macOS |
|---|---|---|
| Como o Claude Code chama | `powershell -File run.ps1 <script>` | `"<node>" "<caminho>/<script>"` |
| Atalho de linha de comando | `cota.cmd` | `./cota` |
| Quem monta isso | `instalar.js` | `instalar.js` |

O `instalar.js` detecta a plataforma e escreve o comando certo. Os três
invólucros (`run.ps1`, `cota.cmd`, `cota`) procuram o node na mesma ordem:
`node-local.txt`, depois `$COTA_NODE`, depois o `node` do PATH.

> **Aviso honesto:** o suporte a Linux e macOS foi escrito e revisado, mas
> **nunca foi executado nessas plataformas** — este projeto nasceu e foi testado
> no Windows. O caminho de código é simples e a geração de comando está coberta
> por teste, mas se você for o primeiro a rodar em Linux ou macOS, rode
> `node teste.js` antes e abra uma issue se algo não bater.

## Usar

Pondo a pasta no PATH, vira só `cota` nas duas plataformas. Fora dele, use
`cota.cmd` no Windows e `./cota` no Linux/macOS. De dentro da pasta,
`node cota.js <argumentos>` também funciona em qualquer sistema.

```bash
cota                     # as duas janelas e o ritmo medido
cota cabe 10             # a cota aguenta 10 subagentes? quantos agora?
cota cabe 10 Explore     # idem, usando a média desse tipo de agente
cota audit               # diagnóstico: em que elo a corrente quebrou
cota audit ok            # registra que bateu com o /usage
cota audit 47 62         # registra o que o /usage mostrou
cota off | cota on       # desliga / religa a ferramenta inteira
cota config              # mostra a configuração
cota config aviso.limiar_5h 70
cota limpar              # poda histórico velho (o medidor já faz sozinho)
```

O comando é tolerante de propósito (D27): aceita sinônimo (`ver`, `aguenta`,
`debug`), ignora acento e caixa, entende número solto (`cota 10` = `cota cabe
10`), e comando desconhecido mostra a situação em vez de dar erro. **Digitação
nunca vira código de erro** — se der erro, é problema de verdade.

## Configuração

`~/.claude/cota/config.json`, mudável por comando, vale no próximo turno.

| Chave | Padrão | O quê |
|---|---|---|
| `ligado` | `true` | Chave geral. Desligada, tudo responde "desativada" — mas o sensor continua gravando, então religar volta na hora. |
| `idade_max_s` | `900` | Acima disso a leitura vira "piso" em vez de valor. |
| `aviso.limiar_5h` | `80` | % da janela de 5h para começar a avisar. |
| `aviso.limiar_7d` | `70` | Mais baixo de propósito: estourar a semanal custa 4 dias. |
| `aviso.repetir_min` | `30` | Intervalo mínimo entre avisos iguais. |
| `admissao.perguntar_acima_de` | `75` | % a partir do qual o `PreToolUse` pergunta. |
| `admissao.margem` | `0.7` | Só autoriza se couber em 70% do que resta. |
| `vigia.limiar_5h` | `70` | % a partir do qual o vigia fala no fim de cada subagente. |
| `vigia.repetir_min` | `5` | Curto: durante workflow a cota anda rápido. |
| `medidor.orfao_max_s` | `7200` | Acima disso, subagente em voo é considerado órfão. |
| `poda.dias` | `14` | Sessão sem uso há mais dias que isso é removida do histórico. |
| `poda.max_linhas` | `5000` | Teto de linhas nos arquivos de amostra. |
| `modo_desconfiado` | `false` | Ligado sozinho quando uma aferição diverge do `/usage`. |

## Limitações reais

- `rate_limits` só existe para assinante **Claude.ai Pro/Max**, e só depois da
  primeira resposta da API na sessão. Em conta de API avulsa nada disso funciona.
- **Não existe o limite em número absoluto.** A Anthropic publica percentual e
  horário de reset, mais nada.
- **Não há projeção de consumo, e é de propósito** (D28). O uso real é por
  rajadas — workflow pesado, dias parado, perguntas lentas — e nenhuma média
  entre esses regimes descreve qualquer um deles. O ritmo é medição do passado
  recente, não previsão.
- O custo por subagente é **média da onda, não atribuição** (D31): mede-se o
  gasto do período com todos em voo e divide pelos participantes. Ondas de
  tipos misturados escondem o agente caro atrás do barato.
- Até a primeira onda terminar, o `cabe` responde `SEM BASE` — e sugere uma onda
  pequena, cuja função é justamente formar a base.
- **Onda curta mede 0%.** O percentual vem em número inteiro, então uma onda de
  90s que custou 0,4% aparece como zero. Não é de graça: é abaixo da resolução.
- **A extensão do VS Code não alimenta o mural** — veja "Quem alimenta o mural".
  Trabalhando nela, é preciso uma janela de terminal com um loop, e isso marca
  as medições como contaminadas (D35).
- Se você roda mais de uma sessão ao mesmo tempo (VS Code + TUI, por exemplo),
  quase toda medição sai marcada como contaminada. A ferramenta usa essas
  amostras mesmo assim, dizendo que são contaminadas — outra sessão infla o Δ,
  e superestimar custo erra para o lado seguro (D32).
- Relógio da máquina torto = countdown mentiroso. O `audit` detecta.
- **A extensão do VS Code não roda status line** — ela sobe o `claude` em
  `stream-json`, sem TUI. Só sessão de terminal alimenta o mural. Para esse caso
  existe o sensor manual: `cota leitura <5h> <7d> <prazo>` (D23).
- **Sub-limite por modelo não é exposto.** O `/usage` quebra a semanal por
  modelo; o `rate_limits` só dá os agregados. Um modelo específico pode estourar
  sem o `cota` ver chegando.
- **Atualização do Claude Code pode quebrar em silêncio.** A ferramenta lê o
  JSON da status line e os eventos de hook; versão nova pode mexer neles. O
  `audit` compara a versão de agora com a da última aferição e pede revalidação
  quando mudou (D34). Depois de atualizar: abra sessão nova e rode `cota audit`.
- **Promoções mudam o denominador.** Se o limite estiver temporariamente maior,
  o percentual de hoje não é comparável com o de depois que ela acabar.

## Segurança

Não há rede, `eval`, `new Function` nem `require` dinâmico. O projeto nunca lê
`.credentials.json` nem chama API — só arquivo local.

Nove vetores foram sondados com processos reais (travessia de caminho, poluição
de protótipo, injeção por config e por caminho de instalação, permissão de
arquivo, crescimento sem limite). O resultado e o que foi corrigido está em
[DECISOES.md](DECISOES.md), seção "Verificação de segurança".

O estado é gravado com permissão `0600` — ele guarda id de sessão e perfil de
uso, que não é segredo mas também não é assunto de outro usuário da máquina.

O modelo de ameaça que sobra é honesto: quase tudo aqui pressupõe que quem
escreve em `~/.claude/` é você. Quem não é você e consegue escrever ali já tem
sua sessão do Claude Code.

## A verdade é o `/usage`

O `/usage` vem da Anthropic. Isto aqui é código local e pode errar. Se os dois
discordarem, o `/usage` ganha — registre a divergência com `cota audit <5h>
<7d>` e a ferramenta entra em modo desconfiado sozinha (D22).
