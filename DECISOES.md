# cota — decisões

O porquê de cada escolha do projeto, para quem for mexer nele.

Os números têm buracos de propósito: são as decisões da primeira versão, que
lia a cota pela status line, aposentadas quando a leitura headless da cota
apareceu (D39, D44). O texto completo delas continua no histórico do git:
`git show e5aac19:DECISOES.md`.

## Missão

O agente precisa responder **antes** de disparar coisa pesada:

> "vou lançar um workflow com 10 agentes em paralelo — a cota aguenta?"

E quando não aguentar: *quantos aguenta agora?*, *compensa esperar o reset?*, e
se estiver no fim, **parar de forma limpa**.

Ler o percentual é meio do caminho. O que decide é a conta:

```
cabe?  =  n × custo_por_agente  <  restante × margem
```

O `restante` vem do próprio Claude Code (os números do `/usage`). O **custo
por agente** é medido pela própria ferramenta — o ritmo de gasto por hora de
subagente e quanto tempo eles costumam rodar (D47, D48). É o coração do
projeto.

## O que é lido

Da resposta do `get_usage` (D39), duas cotas independentes, sempre **percentual +
horário de reset**, nunca um sem o outro:

| `kind` | Vira |
|---|---|
| `session` | a janela de 5 horas |
| `weekly_all` | a semanal, todos os modelos |
| `weekly_scoped` | a semanal de um modelo (ex.: Fable) — mostrada, não decide |

A semanal não é a soma das janelas de 5h: dá para estar em 10% numa e 95% na
outra, e é a semanal que para você.

## Comportamento

**D1 — Sem freio de loop.** Nada de hook bloqueando o agente no meio do
trabalho. Subagente travado no meio de um fan-out vira falha misteriosa.

**D2 — A chave desliga a ferramenta inteira.** Desligada, a consulta responde
"desativada", e nada lê, avisa nem mede. Religada, volta calada.

**D3 — Aviso só pega carona.** Só em mensagem que você mandou. Nunca cria
turno, nunca acorda sessão parada. Abaixo do limiar não injeta nada.

**D4 — Leitura velha tem estados, e os dois úteis erram para o lado seguro.**
Com a sonda a leitura quase sempre é fresca; se ela falhar, o número envelhece:

| Situação | Vale como |
|---|---|
| `agora < reset`, leitura recente | o número |
| `agora < reset`, leitura velha | **piso** — na mesma janela a cota só sobe |
| `agora >= reset` | **nada** — a janela virou; não é o valor antigo nem 0% |

**D5 — O piso se autocorrige.** Se a porcentagem *cair* sem o reset mudar, a
hipótese do D4 morreu, e dado velho passa a valer como desconhecido. A mecânica
da janela não é documentada — não apostar.

**D8 — Config em arquivo, virada por comando.** Nada de variável de ambiente
para o comportamento: exige reiniciar e não dá para ver o estado.

**D9 — Reset é previsto, não vigiado.** O horário de reset chega horas antes;
comparar com o relógio basta.

**D10 — Guardar absoluto, mostrar relativo.** No arquivo vai o reset em epoch;
o "reseta em 2h" é calculado na hora de mostrar. Gravar "2h" apodrece em
cinco minutos, sem ninguém avisar.

**D11 — O formato segue o horizonte.** Janela de 5h: relativo na frente
(`em 2h14`), porque o que importa é "dá tempo?". Semanal: dia da semana e hora
na frente (`sáb 23/08 13:31`), porque `em 4d 3h` ninguém consegue planejar.

**D13 — A unidade é o percentual da janela.** Dólar não entra: é estimativa,
assinante não paga por token, e traria uma hipótese frágil para o meio de uma
conta que precisa ser confiável. Ritmo é `Δ% ÷ Δtempo` da **última hora**, só
na mesma janela. O histórico só ganha ponto quando o número muda, então é uma
escada: o valor de uma hora atrás é o do último ponto até lá, e a leitura de
agora fecha a conta. Sem ela, um período parado depois de uma subida sumia, e
às 13h a ferramenta dizia "28%/h" sobre uma subida das 9h.

**D15 — Decide a janela mais apertada.** Uma operação pode caber na de 5h e
estourar a semanal. Avalia as duas e obedece a pior.

**D16 — Esperar é resposta.** Se a de 5h reseta em 20min, esperar e ter a
janela inteira ganha de rodar agora com 15%. A saída não é só sim/não.

**D17 — Quem para é o agente, não o hook.** O agente lê, entende, para sozinho e
**escreve o estado** do que fez e do que falta. Parada limpa, não morte súbita.

**D18 — Retomada automática não.** Agente que acorda sozinho às 3h e queima a
janela nova sem ninguém olhando é o mesmo problema invertido. Avisa o horário
do reset e entrega o estado salvo.

**D19 — Perguntar no `PreToolUse` de operação pesada.** Com a cota alta, as
tools de agente e workflow devolvem `permissionDecision: "ask"` com o número na
tela. Não é bloqueio (D1): é confirmação informada, e quem decide é você.

## Ondas, trechos e custo

**D25 — Órfão é quem perdeu a sessão, não quem passou da hora.** Se a sessão
morre com um subagente rodando, o `SubagentStop` dele nunca dispara, e ele
ficaria "em voo" para sempre, levando parte de cada trecho. A primeira regra
era a idade: passou de 2h, é órfão. Mas agente de 12h trabalhando existe — e
era descartado vivo. A idade não prova nada; o que prova é a sessão:

| Situação | Como se sabe | O subagente |
|---|---|---|
| a sessão fechou | hook `SessionEnd` (documentado) | sai na hora |
| a sessão morreu sem avisar (travou, a máquina desligou) | registro do Claude Code com o processo morto | sai na hora |
| a sessão está viva | registro com o processo vivo | fica — 2h ou 12h |
| o registro não diz (formato mudou, sessão fora dele) | — | só depois de `medidor.orfao_max_s` (48h) |

O registro é o `~/.claude/sessions/<pid>.json` que o próprio Claude Code
mantém, um por sessão aberta, com o `sessionId` — não documentado, e por isso
só confia em resposta positiva: sem registro, vale a idade longa. As 48h também
pegam o subagente que morreu sozinho numa sessão que segue aberta.

A parte que o órfão acumulou se perde: não há como saber o que era dele. E se a
saída dele esvazia o céu, quem já tinha terminado ainda recebe a sua parte — o
trecho fecha, em vez de ser descartado.

**D28 — Sem projeção de consumo.** Havia uma: extrapolava `%/h` até 100% e
emitiu "acaba ANTES do reset" com 1% consumido — media 55min de trabalho e
projetava 167h de relógio. O defeito não era base curta, era supor uso
estacionário. O uso real tem regimes sem mistura previsível (workflow violento,
dias parado, perguntas lentas), e nenhuma média entre eles descreve qualquer
um. A função saiu inteira, e o teste verifica a ausência. Fica o ritmo, como
**medição** do passado recente, e a admissão, que é aritmética sobre custo
medido. Alarme que dispara com 1% ensina a ignorar alarme.

**D29 — Onda em vez de salva.** A pergunta útil não é "N cabe?", é "quantos
disparar agora?". Dez de uma vez gastam a cota no momento em que se sabe menos
sobre ela; em ondas, cada uma devolve medição, e entre uma e outra é a única
hora em que parar sai barato. Uma onda nunca compromete mais que 25% do
orçamento da janela crítica. Com folga, a onda é o pedido inteiro. Reprovado
não ganha onda de consolação. Sem base nenhuma, a primeira onda é pequena e
declarada como calibração.

**D30 — O vigia do workflow.** O aviso pega carona na sua mensagem — durante um
workflow ninguém digita. A admissão dispara uma vez, no lançamento. O
`SubagentStop` é o único evento que bate ponto sozinho enquanto o trabalho
corre, e não viola o D3: se disparou, há trabalho em curso. Fala por
`systemMessage`, nunca bloqueia, com limiar mais baixo (70/60) e faixas de 5%.

**D31 — Paralelismo não é sujeira, e o custo é divisão, não atribuição.**
Com vários subagentes rodando juntos não dá para saber quem gastou o quê, e
fingir que dá seria pior. O que se mede é quanto a cota subiu com eles em voo,
dividido pelas horas deles. Paralelismo é o objeto que a ferramenta existe para
dimensionar. (A primeira forma disso — a onda inteira como unidade, do
primeiro subagente ao último — saiu no D47.)

**D32 — Média agrupada.** Soma dos Δ ÷ soma das horas de subagente, não média
dos ritmos de cada trecho: respeita o peso de cada um. Trecho curto mede 0% (o
percentual é inteiro) e entra assim mesmo — zero ali é "abaixo da resolução",
não "de graça", e só a soma com os trechos longos diz o ritmo de verdade. (Na
primeira versão a média era de custo por agente: 65% em 63 agentes =
1.03%/agente no primeiro workflow real.)

**D33 — Nada de ler-alterar-regravar arquivo compartilhado.** Com a lista de
participantes num arquivo único, hooks simultâneos se atropelavam: 16 de uma
vez perdiam 9 (o rename do Windows falha com EPERM e os que passam se
sobrescrevem). Cada subagente grava só os próprios arquivos; contar é listar a
pasta. O marco é criado com `wx`, e quem fecha um trecho o reivindica
renomeando — dois fechando juntos, só um consegue (D47). Gravação atômica com repetição em
EPERM, e varredura de `.tmp` órfão só dos velhos.

## Ferramenta para agente

**D20 — O audit não depende do que ele audita.** Diz em que elo a corrente
quebrou, nunca só "sem dados". E sempre lê de verdade: é o teste da corrente
inteira.

**D26 — Descoberta em três camadas.** Um chat novo não sabe que a ferramenta
existe. A skill **ensina** (depende do julgamento do modelo, que falha), o
`UserPromptSubmit` **avisa** (chega colado na mensagem), o `PreToolUse`
**pergunta** (pega quem ignorou as outras duas). Instalar só a skill é deixar a
proteção na mão de quem ela deveria proteger.

**D27 — A CLI não pune digitação.** Se `cota ver` respondesse "code 1", o
agente concluiria que a ferramenta está quebrada e seguiria **sem checar a
cota**. Sinônimo é aceito, acento e caixa ignorados, número solto vira `cabe`,
comando desconhecido mostra a situação. Erro passa a significar problema de
verdade. Pelo mesmo motivo a skill traz o comando **literal** desta máquina,
gerado na instalação.

**D36 — A mensagem de erro é a documentação.** Quem instala não lê o README.
Quando algo quebra, a saída diz o que quebrou e entrega o conserto. E o
instalador **executa** o que gerou antes de declarar sucesso — no Windows um
comando errado não dá erro, só não roda.

**D37 — Config valida o tipo contra o padrão.** `cota config aviso.limiar_5h abc`
gravava a string; a comparação `pct < "abc"` dá false para sempre e o aviso
parava sem sintoma. Numa ferramenta cujo produto é o aviso, o pior desfecho.

**D38 — Poda.** Histórico e amostras são lidos inteiros a cada consulta. Sem
poda, cada chamada passa a pagar por tudo o que já aconteceu. Sai o que tem
mais de 14 dias, e cada arquivo tem teto de 5000 linhas. Reescrever um arquivo
que outro processo pode estar acrescentando perde a linha dele, então a poda
automática só reescreve com folga de um dia — uma vez por dia, não uma por
onda — e grava atômico. `cota limpar` aceita só inteiro de 0 para cima: um
negativo punha o corte no futuro e apagava tudo.

## A leitura da cota

**D39 — A cota se lê pelo protocolo de controle do CLI.** O CLI em
`-p --input-format stream-json --output-format stream-json` aceita, pela
entrada padrão, as mensagens de controle que o Agent SDK usa — e uma delas é a
que a extensão do VS Code manda para o medidor de uso dela:

```json
{"type":"control_request","request_id":"cota","request":{"subtype":"get_usage","skip_behaviors":true}}
```

A resposta traz `rate_limits.limits[]` (os números do `/usage`), o
`subscription_type` e se a conta tem limite para ler. **Não é prompt**: nenhum
modelo é chamado, nenhuma cota é gasta, e não existe caminho em que a leitura
vire um turno. O processo responde e sai quando a entrada fecha, em ~1,5s. O
número é do servidor, na hora, e não depende de TUI — funciona na extensão do
VS Code.

A primeira versão mandava `/usage` como prompt (`claude -p /usage`, lendo o
`usage_report`). Funcionava, mas levava ~3,5s — quase tudo na análise de "o
que está consumindo a sua cota", que lê os logs locais e que o
`skip_behaviors` pula — e precisava de uma suspensão para o dia em que o
`/usage` virasse prompt e passasse a gastar cota a cada consulta (era o D42).
O pedido de controle elimina o risco em vez de vigiá-lo. A ideia veio do Codex,
que lê a cota do mesmo jeito (`account/rateLimits/read` no `app-server`).

O preço é o contrato: o `get_usage` não é documentado, e o método do SDK que o
envia se chama `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. O
que segura é que a própria extensão depende dele. Se mudar, a sonda diz qual
elo quebrou — sem resposta, pedido recusado, campo sumido — e nunca inventa
número (D36).

Como a sonda roda, e por quê:

| Opção | Por quê |
|---|---|
| `skip_behaviors: true` | pula a análise dos logs locais: ~2s a menos |
| `--no-session-persistence` | sem ela cada leitura vira uma conversa na sua lista |
| `--settings {"disableAllHooks":true}` | os hooks do cota leem — sem isso, recursão |
| `--setting-sources user` | ignora configuração de projeto (D45) |
| `--strict-mcp-config` | servidor MCP não tem nada a ver com cota |
| `cwd` = `~/.claude/cota` | pasta só sua (D45) |
| env `COTA_SONDA_ATIVA` | segunda trava contra recursão |
| só `.exe` no Windows | `.cmd` exige shell, e aí os argumentos passariam pelo cmd.exe |

A resposta não traz a versão do Claude Code; ela sai do nome da pasta da
extensão (D43).

Linha do tempo, pelos changelogs oficiais e pelas datas de publicação no npm:

| Data | Versão | O que apareceu |
|---|---|---|
| 08/06/2026 | Agent SDK 0.3.169 | o método experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, que envia o `get_usage` — "structured session cost, plan rate-limit, and local usage-behaviors data" |
| 01/09/2026 | Claude Code 2.1.257 | o medidor de uso na barra lateral da extensão do VS Code |
| 15/09/2026 | Agent SDK 0.3.273 | o `usage_report` no `/usage` headless, que a primeira versão desta sonda usou |
| 18/09/2026 | Agent SDK 0.3.277 | a primeira menção ao `get_usage` pelo nome, numa correção |

O `get_usage` só aparece nos changelogs do SDK, nunca na documentação de
referência — daí o "não documentado". Quando este projeto nasceu (19/08/2026)
o pedido já existia havia dois meses; ninguém tinha olhado.

**Plano B — se o `get_usage` sumir, volta para o `/usage`.** A versão com
`/usage` nunca foi commitada, então a receita fica aqui:

1. Argumentos: `-p /usage --output-format stream-json --verbose`, sem nada na
   entrada, mais as mesmas opções de isolamento da tabela acima e
   `--model haiku`.
2. A resposta é uma mensagem `type: "assistant"` com
   `usage_report.rate_limits.limits[]` — **o mesmo formato** de hoje. O
   `interpretar` só muda onde procura o `rate_limits`.
3. **Obrigatório:** a mensagem `type: "result"` traz `num_turns` e
   `total_cost_usd`. Qualquer um acima de zero quer dizer que o `/usage` virou
   prompt e gastou cota: a leitura tem de se suspender até um `cota sondar`
   deliberado. Sem essa guarda, cada hook gastaria cota.
4. Leva ~3,5s. Do Node chama-se o executável direto; de um shell Git Bash,
   `MSYS_NO_PATHCONV=1`, senão o `/usage` vira `C:/Program Files/Git/usage` e
   vai ao modelo como texto — aconteceu no primeiro teste.

O sinal de que é hora: `cota audit` acusando "o claude recusou o get_usage" ou
"não respondeu ao get_usage" depois de uma atualização do Claude Code.

**D40 — Leitura por idade, uma de cada vez.** A leitura custa ~1,5s, então cada
ponto lê só quando a última passou da sua idade: 60s para o `cota`, a admissão
e a abertura de uma cadeia de marcos; sempre no fechamento de um trecho e no
`audit`; 3min para o
vigia e 10min para o aviso, que nunca esperam outra leitura (o aviso atrasa a
sua mensagem). Parado, nada roda.

Depois de uma falha, ninguém tenta de novo por 5 minutos. Sem a pausa, uma
leitura que falha sempre (conta sem plano, sem rede, claude deslogado) era
repetida em cada mensagem e em cada subagente, até 10s cada vez. `cota sondar`
ignora a pausa.

Com 16 `SubagentStart` no mesmo segundo seriam 16 processos do claude. Uma
trava criada com `wx` deixa um ler; os outros esperam o resultado — esperar um
segundo e pouco é melhor que sair com número velho. A trava carrega o **prazo** de quem a pegou
(o timeout dele, e um pouco mais): vencido o prazo, o dono morreu — hook morto
pelo Claude Code, Ctrl+C no meio do `cota` — e quem estava esperando assume na
hora. Com um limite fixo de 60s, quem esperava ficava preso o próprio timeout
inteiro (35s no `cota`) para depois decidir com número velho. O Ctrl+C solta a
trava ao sair, e só o dono a apaga.

Achado do teste: o servidor devolve o mesmo reset com ruído de fração de
segundo (`10:59:59.506` numa leitura, `11:00:00` na seguinte), e o sistema
compara reset por igualdade (janela virou? monotonia? mesmo trecho de ritmo?).
O reset é arredondado ao minuto.

**D41 — O trecho fecha com uma leitura pedida depois do fim.** Quem fecha um
trecho exige uma leitura **pedida depois** daquele instante — o carimbo da
leitura é a hora do pedido, em milissegundos, e uma leitura que já estava em
curso não serve. Se a leitura falhar, nada vira amostra: o Δ sairia de um
número velho, no limite 0%, medição falsa que puxa a média para baixo — o lado
perigoso de errar. Com gente ainda em voo, o marco volta para o lugar e o
próximo fecha um trecho maior; com o céu vazio, a cadeia acaba sem medida.

E quem fecha **reivindica o trecho antes de ler**: renomeia o marco (atômico),
e só então espera a leitura. Quem começa nesse meio-tempo não abre outra cadeia
nem leva parte deste trecho: entra no seguinte, cujo marco quem fechou grava.
Na primeira versão, com a onda ainda montada durante a leitura, quem começava
ali entrava na onda que fechava — contado no `n`, barateando o custo — e a
dele ficava sem marcador, nunca medida. O teste reproduz a corrida com uma
leitura lenta.

**D43 — O claude da extensão muda de pasta a cada atualização.** O binário
mora em `~/.vscode/extensions/anthropic.claude-code-<versão>-<plataforma>/`.
O caminho **nunca é gravado** — é procurado a cada leitura.

"A versão mais alta" não basta: depois de uma atualização a pasta velha
**continua no disco**, com o binário inteiro, marcada em `extensions/.obsolete`
até o VS Code limpar; e quem diz o que está instalado é o
`extensions/extensions.json`.

| Caso | A mais alta escolheria | Agora |
|---|---|---|
| downgrade | a obsoleta, ainda no disco | a registrada |
| atualização em curso | pasta nova com binário pela metade | a registrada |
| limpeza no meio da leitura | um caminho que sumiu | o próximo candidato |

Candidato que nem chega a executar passa a vez; candidato que executa e falha
é a resposta. E a troca é dita: o `cota sondar` e o `audit` mostram "mudou de
extensão 2.1.299 há 5min, achado sozinho" por uma semana.

**D47 — Medir em trechos, não na onda inteira.** A onda inteira (D31) só
fechava com o céu vazio — e os hooks são globais: valem para todas as sessões
do Claude Code na máquina. No primeiro teste real, um agente de outra sessão
rodou por mais de meia hora e manteve a onda aberta; das 08h04 às 09h47 nada
foi medido, e os subagentes desta sessão ficaram esperando por ele.

Agora a cota é lida em **marcos**, e cada trecho entre dois marcos é uma
amostra: o que a cota subiu, e quantas horas de subagente rodaram nele — de
todas as sessões, por tipo de subagente.

- **Quando há marco novo:** quando um subagente termina e o trecho em curso já
  tem `medidor.trecho_s` (2min), ou quando o céu esvazia. Trecho mais curto
  segue aberto — assim a leitura não segura cada subagente que termina.
- **A conversa principal** de cada sessão também gasta e entra no Δ: infla o
  ritmo dos subagentes, o lado seguro.
- **O marco se recupera sozinho:** sem marco, quem começa abre um — mesmo com
  gente em voo, que entra no trecho com o tempo a partir dali.

**D48 — O ritmo de um subagente, não o custo total.** As janelas são de 5h, e
um subagente pode rodar 12h: ele gasta um pedaço de uma janela, outro da
seguinte, outro da terceira. "Custo total em % de uma janela de 5h" — 130% de
uma janela — não descreve isso. E o trecho que atravessa um reset nem tem Δ:
o número de antes é da janela velha, o de depois é da nova. Na primeira forma
dos trechos, todo subagente que rodasse num trecho assim ficava sem amostra, e
a base ficava só com os curtos, que cabem inteiros numa janela — subestimando
trabalho longo, o lado perigoso de errar.

O que se mede agora são duas coisas separadas:

- **o ritmo** — quanto da janela um subagente gasta por hora rodando. Sai dos
  trechos: soma dos Δ ÷ soma das horas de subagente (D32), por tipo. O trecho
  que atravessa um reset é pulado na janela que virou, e só nela — a semanal
  continua contando —, e os trechos antes e depois seguem valendo;
- **a duração típica** — quanto um subagente costuma rodar, do `SubagentStart`
  ao `SubagentStop`. Não depende de leitura nenhuma, e é gravada quando ele
  termina.

O `cabe` multiplica os dois, e corta no reset:

```
custo na janela = n × ritmo × mín(duração típica, tempo até o reset)
```

O que um subagente gastar depois do reset cai na janela seguinte. Por isso um
fan-out de agentes longos pode caber nas 5h de agora — e a semanal, que conta
a duração inteira, vira o limite de verdade; a saída do `cabe` mostra as duas.

A divisão por tempo é uma hipótese — que os subagentes no mesmo trecho gastam
no mesmo ritmo. Erra quando um Opus pesado roda ao lado de um Haiku leve: os
dois saem com o mesmo ritmo do trecho. Entre trechos com misturas diferentes,
os tipos se separam.

A ideia é do dono do projeto, olhando o caso real: "as cotas são de 5h — se um
agente ficar 12h, ele usa duas de 5 e 2 horas da última".

## A faxina

**D44 — Uma fonte só.** Com a sonda, a status line deixou de ter função: ela
existia porque era a única coisa que enxergava a cota, e a extensão do VS Code
nem a executa. Saíram juntos:

- o sensor da status line, e o loop de terminal que mantinha ele vivo — que
  ainda contaminava 8 de 9 medições;
- a leitura manual (`cota leitura`) — com a sonda quebrada, a resposta honesta
  é "sem dado", e o humano já vê o `/usage` na própria extensão;
- a aferição contra o `/usage` e o modo desconfiado — com a leitura trazendo
  os próprios números do `/usage`, era conferir o número com ele mesmo;
- a detecção de "outra sessão escrevendo" — sem status line, ninguém mais
  escreve no mural além da sonda. Outra sessão trabalhando durante uma onda
  infla o custo medido, sem ser detectada (lado seguro);
- o carimbo duplo de frescor, que só existia porque a status line repetia
  valor velho com carimbo novo.

O instalador remove a status line antiga de quem tinha, e os restos dela no
estado.

**D45 — Endurecimento para publicar.** Revisão de segurança antes de abrir o
projeto, com cada achado provado ou descartado:

| Achado | Conserto |
|---|---|
| a sonda rodava na pasta temporária, e o claude lê o `.claude/settings.json` do diretório onde roda — provado plantando um arquivo; ali há chaves que executam comando, e no Linux a pasta é o `/tmp`, de todos | `--setting-sources user` e `cwd` em `~/.claude/cota` |
| entrada relativa no PATH (`.`) faria um `claude.exe` plantado num repositório rodar pelo hook | só entradas absolutas |
| o `extensions.json` podia apontar para fora da pasta de extensões | só pasta filha direta, com o nome da extensão |
| texto vindo do servidor ia direto para a saída que o agente lê | só caracteres de nome, no máximo 40 |
| hook esperava até 30s se o claude travasse | 10s nos hooks |
| o instalador regravava o backup a cada execução, e o original se perdia | guarda o primeiro, nunca sobrescreve |
| não havia como desinstalar | `node instalar.js --remover`, que tira só o que é do cota |

**D46 — Revisão de código.** Um `/code-review` achou 15 defeitos, quase todos
nascidos da sonda: ela leva segundos, e isso abriu janelas que antes eram de
milissegundos. Cada um tem teste que o reproduz; os principais estão nas
decisões acima (D13, D38, D40, D41). Os demais:

| Achado | Conserto |
|---|---|
| leitura "do futuro" (relógio voltou) congelava o mural: nenhuma nova a vencia, e idade negativa contava como fresca | a leitura nova sempre substitui; idade negativa é velha |
| o audit acusava "executável não encontrado, defina COTA_CLAUDE" quando o problema era outro | aponta o elo que quebrou, com o conserto dele |
| o instalador reconhecia hooks pela pasta do projeto; pasta movida deixava os velhos falhando ao lado de novos | reconhece pelo script; atualiza e tira duplicados |
| a conferência do instalador culpava o node e a skill quando era a sonda que falhava | lê o JSON mesmo com código de saída 1; só a sonda é acusada |
| o teste do instalador gravava o `node-local.txt` do projeto real | roda numa cópia do projeto |
| o histórico lia o arquivo inteiro a cada leitura só para comparar com a última linha | lê só o fim do arquivo |
| a política de leitura dos hooks estava copiada em três lugares | um ajudante só, `garantirFrescoHook` |

## Segurança

O que foi sondado com processos reais, e o resultado:

| Vetor | Resultado |
|---|---|
| Travessia de caminho por `agent_id` | bloqueado — `[^A-Za-z0-9_-]` vira `_`; o teste usa um canário |
| Poluição de protótipo por `config.json` | `semProto()` tira `__proto__` antes do merge |
| Tipo inválido em `config` | recusado (D37) |
| Credencial | nenhuma lida nem gravada; quem consulta o servidor é o Claude Code |
| Configuração de projeto na sonda | ignorada (D45) |
| Binário plantado no PATH ou no registro de extensões | ignorado (D45) |
| Permissão dos arquivos de estado | `0600` |
| Crescimento sem limite | poda (D38) |

Sem `eval`, `new Function`, `require` dinâmico ou shell em código de produção —
o teste verifica. O modelo de ameaça que sobra é honesto: quase tudo pressupõe
que quem escreve em `~/.claude/` é você. Quem não é você e escreve ali já tem
sua sessão do Claude Code.

## Fora de escopo

- API interna da Anthropic, token de credencial.
- Limite em número absoluto — a Anthropic só publica percentual.
- Qualquer coisa que crie turno de modelo por conta própria (a leitura é
  mensagem de controle, não prompt: não existe turno).

## Dependências de realidade

- Os limites só existem para assinante Claude.ai Pro/Max.
- O pedido `get_usage` não é documentado (D39).
- O registro de sessões em `~/.claude/sessions` não é documentado (D25). Se
  sumir, sobram o `SessionEnd` e a idade de 48h.
- Relógio da máquina torto = countdown mentiroso.
- A pasta da extensão muda a cada atualização (D43).
- Promoção muda o denominador: com o limite temporariamente maior, o percentual
  de hoje não é comparável com o de depois, e o custo aprendido salta quando
  ela acaba.
