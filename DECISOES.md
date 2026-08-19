# cota — decisões

Só superfícies oficiais documentadas da Anthropic.

## Missão

O agente precisa responder **antes** de disparar coisa pesada:

> "vou lançar um workflow com 10 agentes em paralelo — a cota aguenta?"

E quando não aguentar: *quantos aguenta?*, *compensa esperar o reset?*, e se
estiver no fim, **parar de forma limpa e marcar o despertador**.

Ler o percentual é meio do caminho. O que decide é a conta:

```
cabe?  =  custo_estimado_da_operação  <  restante_da_cota × margem
```

O `restante` a gente tem. O **`custo_estimado` é a peça que falta** — e é o
coração do projeto.

## O que é capturado

Quatro números, direto do JSON oficial da status line — sempre **percentual +
horário de reset**, nunca um sem o outro:

| Campo | Exemplo |
|---|---|
| `rate_limits.five_hour.used_percentage` | `23.5` |
| `rate_limits.five_hour.resets_at` | `1755624000` (epoch, UTC) |
| `rate_limits.seven_day.used_percentage` | `41.2` |
| `rate_limits.seven_day.resets_at` | `1755970800` |

São **duas cotas independentes**, cada uma com seu percentual e seu reset. A
semanal não é a soma das janelas de 5h: você pode estar em 10% na de 5h e em
95% na semanal, e é a semanal que te para.

Saída sempre com percentual + reset juntos:

> `5h:  usou 23.5%  ·  reseta em 2h14 (hoje 14:20)`
> `7d:  usou 41.2%  ·  reseta sáb 23/08 13:31 (em 4d 3h)`

## Papéis

| | Quem | Faz |
|---|---|---|
| **Sensor** | status line | Única coisa que enxerga `rate_limits`. Só observa e grava. Burro e rápido. |
| **Leitor** | CLI + skill | Interpreta: está velho? virou a janela? qual o ritmo? Toda a lógica mora aqui. |
| **Aviso** | hook `UserPromptSubmit` | Pega carona na mensagem que você já ia mandar. |

Sensor não decide nada. Leitor não observa nada.

## Decisões

**D1 — Sem freio de loop.** Nada de `PostToolBatch` bloqueando o agente.
Subagente travado no meio de um fan-out vira falha misteriosa. Descartado.

**D2 — A chave desliga a ferramenta inteira.** Desligada: se o agente pedir a
cota, recebe "ferramenta desativada", e o aviso automático some. Religada:
volta a funcionar, **calada**, sem anunciar que voltou.

**D3 — Aviso só pega carona.** Só em mensagem que você mandou. Nunca cria
turno, nunca acorda sessão parada. Abaixo do limiar não injeta nada.

**D4 — Dado velho tem três estados**, e os dois úteis erram para o lado seguro:

| Situação | Vale como |
|---|---|
| `agora < resets_at`, leitura recente | o número |
| `agora < resets_at`, leitura velha | **piso** — na mesma janela a cota só sobe |
| `agora >= resets_at` | **nada** — a janela virou; não é o valor antigo nem 0% |

**D5 — O piso se autocorrige.** Se o leitor observar a porcentagem *cair* sem o
`resets_at` mudar, a hipótese de D4 caiu: ele registra e passa a tratar dado
velho como desconhecido. A mecânica da janela não é documentada — não apostar.

**D6 — Mural compartilhado.** O limite é da conta, não da sessão: toda sessão
escreve no mesmo arquivo e mais escritores = mais fresco. Sensor só grava se o
que ele traz for mais novo que o que está lá (nunca sobrescreve cego).

**D7 — Histórico por sessão**, juntado na leitura. Mata a corrida de append e
mostra qual sessão está queimando cota.

**D8 — Config em arquivo, virada por comando.** Nada de variável de ambiente:
exige reiniciar e não dá para ver o estado. Vale no próximo turno.

**D9 — Reset é previsto, não vigiado.** `resets_at` chega horas antes; comparar
com o relógio basta. Sem polling, sem watcher.

**D10 — Guardar absoluto, mostrar relativo.** No arquivo vai só o `resets_at`
em epoch; o "reseta em 2h" é calculado contra o relógio na hora de mostrar.
Gravar "2h" apodrece: cinco minutos depois já está errado, e sem ninguém avisar.
É a mesma família de erro do `22:00` do `teste.ps1`.

**D11 — Formato segue o horizonte.** Janela de 5h: relativo na frente
(`em 2h14`), porque o que importa é "dá tempo de terminar isso?". Janela
semanal: **dia da semana + data + hora** na frente (`sáb 23/08 13:31`), porque
`em 4d 3h` ninguém consegue planejar. As duas mostram a outra forma entre
parênteses.

**D12 — Custo zero fora do necessário.** Sensor é processo local: nenhuma
chamada de API, nenhum token. Aviso só custa tokens quando dispara.

## Ritmo e custo por agente — tudo em % da janela

**D13 — A unidade é o percentual da janela. Só.** Dólar não entra: é estimativa
client-side, assinante não paga por token, e traria uma hipótese frágil para o
meio de uma conta que precisa ser confiável. Token entra só como sinal
secundário de "esta sessão está pesada" — nunca como base de decisão.

O "está gastando rápido demais?" já tem resposta direta, e na unidade certa:

```
ritmo = Δ% da janela ÷ Δtempo     → "% por hora"
```

Dois pontos da mesma janela bastam (mesmo `resets_at`; se mudou, a janela virou
e o histórico anterior não vale — D4).

**D14 — Custo por subagente medido em Δ%, só com amostra limpa.** Os hooks
`SubagentStart` e `SubagentStop` cercam cada subagente e o Δ% do intervalo é o
custo dele. Isso é contaminável: outra sessão queimando no mesmo período entra
na conta. Mas a contaminação é **detectável** — o mural tem histórico por sessão
(D7), então dá para saber se outra sessão registrou atividade no intervalo.
Regra: só vira amostra se **um único subagente estava em voo** e **nenhuma outra
sessão escreveu** no período. Amostra suja é descartada, não corrigida. Com
`agent_type` no payload, sai média por tipo de agente. Daí a conta da missão:

```
quantos_cabem = (restante% × margem) ÷ custo_médio_por_agente%
```

**D15 — Decidir pela janela mais apertada.** Uma operação pode caber na de 5h e
estourar a semanal. Sempre avaliar as duas e obedecer a pior. Com dado velho,
usar o **piso** de D4 — errar para o lado de não disparar.

**D16 — Esperar é uma resposta legítima.** Se a de 5h reseta em 20min, esperar e
ter a janela inteira ganha de rodar agora com 15%. A saída não é só
sim/não — é: `vai` · `cabem N` · `espera até HH:MM e vai inteiro`.

## Parada e retomada

**D17 — Quem para é o agente, não o hook.** D1 continua de pé: nada de
`PostToolBatch` matando subagente no meio. O agente lê, entende, para sozinho e
**escreve o estado** do que fez e do que falta. Parada limpa, não morte súbita.

**D18 — Alarme sim, retomada automática não (por padrão).** Como `resets_at` é
conhecido (D9), agendar no horário exato é determinístico. Mas agente que
acorda sozinho às 3h e queima a janela nova sem ninguém olhando é o mesmo
problema invertido. Padrão: **avisa e entrega o estado salvo**. Retomar sozinho
é opção que você liga.

**D19 — Interceptar no `PreToolUse` de operação pesada.** Matcher nas tools de
agente/workflow: se a cota estiver baixa, devolver `permissionDecision: "ask"` —
te pergunta antes de lançar os 10 agentes, com o número na tela. Não é o bloqueio
cego de D1; é confirmação informada, e quem decide é você.

## Auditoria — `/cotaaudit`

**O `/usage` não pode estar errado — vem da Anthropic. O `cota` pode.** É código
nosso, e o número passa por muita mão até chegar: sensor → arquivo → relógio →
ritmo estimado → conta de admissão. Cada elo desses inventa um jeito de
mentir. O audit existe para desconfiar do `cota`, **nunca** do `/usage`.

Três camadas, e a terceira não é automática de propósito:

1. **Autoteste** — injeta payload conhecido no sensor e confere a saída.
   Responde *"o código está certo?"* sem depender do Claude Code.
2. **Cadeia de custódia** — responde *"o dado está chegando?"*.
3. **Aferição** — mostra o que ele tem e pede para você comparar com o `/usage`.
   `cota audit ok` / `cota audit 47` grava a conferência.

O que a máquina checa sozinha:

| Checagem | Pega o quê |
|---|---|
| `0 ≤ pct ≤ 100` | lixo, campo trocado, `null` virando `0` |
| `five_hour.resets_at` no máximo 5h à frente | dado corrompido **ou relógio local torto** |
| `seven_day.resets_at` no máximo 7d à frente | idem |
| `resets_at` já passou | dado expirado sendo servido como válido |
| pct caiu sem `resets_at` mudar | **D5 violado** — a hipótese do piso morreu |
| idade do snapshot vs `refreshInterval` | o sensor parou de rodar |
| quantas sessões escreveram, e quando | mural com um escritor só envelhece rápido |
| linhas corrompidas / buracos no histórico | corrida de append (D7) |
| ritmo (D13) coerente entre janelas? | histórico furado ou janela virando sem registro |
| quantas amostras limpas por tipo de agente (D14)? | admissão decidindo com base fraca |

As duas checagens de "no máximo Nh à frente" são **suspeita, não veredito**: a
mecânica da janela não é documentada. Se dispararem, é sinal de investigar — e
podem ser o próprio audit derrubando uma premissa nossa.

**D20 — O audit não depende do que ele audita.** Se não há snapshot, ele diz em
qual elo a corrente quebrou — settings → comando → processo → arquivo → idade →
validade — nunca "sem dados". É a ferramenta de diagnóstico; tem que funcionar
justamente quando o resto não funciona.

**D21 — Aferição humana fica gravada.** Cada `cota audit ok` vira uma linha com
data e desvio. Com o tempo dá para dizer "conferido 9 vezes, bateu 9". Sem
histórico, audit é opinião.

**D22 — Em divergência, o `/usage` ganha, e a ferramenta se rebaixa.** Se a
aferição acusar desvio grande, o `cota` não corrige o número e segue confiante:
ele entra em **modo desconfiado** — responde com o desvio junto e para de
autorizar operação pesada até você conferir de novo. Ferramenta de admissão que
erra para mais é pior que ferramenta nenhuma: faz o agente lançar 10 agentes
achando que cabe.

## Descobertas de campo

Estas três vieram de rodar a coisa de verdade, não do desenho.

**D23 — Sensor manual.** A extensão do VS Code não executa status line (roda o
`claude` em `--output-format stream-json`, sem TUI; confirmado também em
headless). Então `cota leitura <5h> <7d> [prazo5h] [prazo7d]` deixa o humano
ser o sensor: lê o `/usage` e digita. Os prazos usam o mesmo formato que o
`/usage` mostra (`3h44`, `54min`, `2d3h`) e viram `resets_at` absoluto na
gravação (D10). Marca `origem: manual`, porque dado digitado não se atualiza
sozinho e o audit precisa dizer isso. Leitura manual **ignora a guarda de D6**:
vem do `/usage`, é a fonte mais autoritativa disponível, e é ato deliberado.

**D24 — Observação não é confirmação.** O `rate_limits` só se renova quando
*aquela sessão* recebe resposta da API. Sessão aberta e ociosa continua rodando
o sensor a cada `refreshInterval` e **repetindo o último valor** — `t` novo,
número velho: dado podre com carimbo fresco, o pior dos mundos. O snapshot passa
a ter dois carimbos, e é `t_confirmado` que decide `fresco` vs `piso`. O sinal é
`total_input_tokens`: se não mudou, nenhuma resposta nova chegou.

Consequência prática: **a sessão que trabalha precisa ser a que observa.** Uma
TUI acoplada à sessão em uso serve de sensor mesmo com você digitando noutra
janela — uma única chamada de API dela traz o número da conta inteira, incluindo
o que as outras superfícies gastaram.

**D25 — Varrer órfãos do medidor.** Se a sessão morrer com um subagente rodando,
o `SubagentStop` nunca dispara e a entrada fica em voo para sempre. A partir daí
toda amostra seguinte é marcada suja por "outro subagente em voo", e o `cabe N`
trava em `SEM BASE` sem ninguém entender por quê. Entrada com mais de
`medidor.orfao_max_s` (2h) é descartada antes de qualquer medição.

**D26 — Descoberta em três camadas, e só a última é confiável.** Um chat novo
não sabe que esta ferramenta existe: o agente nunca vê a status line (ela é
desenhada para o humano, não entra no contexto). Três mecanismos oficiais
resolvem isso, com alcances diferentes:

| Camada | Mecanismo | Depende do agente? |
|---|---|---|
| Ensina | skill `~/.claude/skills/cota/` | sim — ele julga se é relevante |
| Avisa | hook `UserPromptSubmit` | não — chega colado na mensagem |
| Barra | hook `PreToolUse` | não — ele é parado ao tentar |

A skill é a única que depende de julgamento do modelo, e julgamento falha. Por
isso as três coexistem em vez de uma só: a `admissao` pega justamente o agente
que ignorou as outras duas e saiu disparando fan-out. Instalar só a skill é
deixar a proteção na mão de quem ela deveria proteger.

**D27 — A CLI não pune digitação.** Se `cota ver` responde "code 1" e uma linha
de uso, o agente conclui que a ferramenta está quebrada e segue **sem checar a
cota** — exatamente o acidente que ela previne. Então: sinônimo é aceito, acento
e caixa são ignorados, número solto vira `cabe`, comando desconhecido mostra a
situação em vez de reclamar, e exceção interna vira mensagem com instrução. Nada
sai com código de erro por digitação. Erro de verdade passa a significar
problema de verdade.

**D28 — Sem projeção de consumo. Ritmo é medição, não profecia.** Havia uma
projeção: extrapolava `%/h` até 100% e avisava se isso caía antes do reset. Ela
emitiu "acaba ANTES do reset" com **1% consumido** — media 55min de trabalho
ativo e projetava 167h de relógio, uma extrapolação de 180x.

A primeira correção foi exigir cobertura mínima do horizonte. Estava errada: o
defeito não é base curta, é supor processo **estacionário**. O uso real tem três
regimes sem mistura previsível — workflow violento que queima a cota em minutos,
dois dias sem acessar nada, sessão interativa lenta de pergunta e resposta.
Nenhuma média entre eles descreve qualquer um deles, então medir mais tempo não
conserta: produz uma média mais confiante e igualmente errada.

A função saiu inteira, e o teste verifica a ausência — código morto com nome
tentador acaba religado por alguém que não leu isto. O que fica:

- **`ritmo()`** — medição do passado recente, sempre com o intervalo junto
  (`12%/h nos últimos 2h11`). Responde "está indo rápido demais?", que era o que
  o usuário pediu.
- **`admissao()`** — responde "cabe N agentes?" por **custo medido por subagente
  contra o que resta**. É aritmética sobre medição, não extrapolação no tempo, e
  por isso nunca dependeu da projeção.

Alarme que dispara com 1% ensina a ignorar alarme. Nesta ferramenta a
credibilidade do aviso é o produto.

**D29 — Onda em vez de salva.** A pergunta útil não é "N cabe?", é "quantos
disparar agora?". Observação de campo: um workflow dispara muito agente em
paralelo, e dez de uma vez gastam a cota no exato momento em que se sabe menos
sobre ela. Em ondas, cada uma devolve medição (o medidor grava no
`SubagentStop`) e a seguinte decide com base melhor — e entre uma onda e outra
é a única hora em que parar sai barato.

Uma onda nunca compromete mais que `FRACAO_ONDA` (25%) do orçamento da janela
crítica, então errar a estimativa por 4x ainda não estoura. Com folga real, a
onda é o pedido inteiro: não se inventa cerimônia quando não há risco. Quem
recebeu `NÃO CABE` não ganha onda — seria contrabandear o "não".

Isso também desatou o `SEM BASE` inicial. O veredito antigo dizia "rode e a base
se forma sozinha", o que convidava a disparar tudo justamente sem estimativa
nenhuma. Agora a primeira onda é pequena e declarada como calibração: ela existe
para medir, e errar nela é barato.

**D30 — O vigia do workflow.** Os outros dois avisos não cobrem o cenário que
mais importa. O `aviso` pega carona na mensagem do humano — durante um workflow
ninguém está digitando, então ele nunca roda. O `admissao` dispara uma vez, no
lançamento, e o workflow queima 10% nos 15 minutos seguintes.

`SubagentStop` é o único evento que bate ponto sozinho enquanto o trabalho corre,
e ele não viola o D3: se disparou, há trabalho em curso por definição — é carona,
não despertador. Fala por `systemMessage`, único canal que o evento aceita
(`additionalContext` não é suportado ali). Nunca bloqueia: `SubagentStop`
bloquearia o subagente errado, o que já terminou, e parar continua sendo decisão
do agente (D17).

Limiar mais baixo que o do `aviso` (70/60 contra 80/70) e assinatura por faixa de
5% em vez de 10%, porque durante workflow a cota anda rápido e cada faixa nova
merece ser dita uma vez. Desligável sozinho por `vigia.ligado`, e junto com tudo
pela chave geral.

**D31 — A onda é a unidade de medida. Paralelismo não é sujeira, é o objeto.**
O D29 (ondas) entrou sem ser reconciliado com o D14 (amostra limpa), e o
resultado foi um defeito que se anulava: o D14 só aceitava amostra com **um**
subagente sozinho em voo, mas a ferramenta existe para dimensionar **fan-out
paralelo**. Toda amostra de uma onda de 2+ nascia suja por "outro subagente em
voo".

Medido antes do conserto, com uma onda de 2 simulada:

```
#1  custo5=2%  limpa=false  motivos: outro subagente ainda em voo
#2  custo5=4%  limpa=false  motivos: outro subagente em voo no início
LIMPAS: 0 de 2
```

Zero. A onda de calibração do D29 nunca formaria base, e o `SEM BASE` seria
permanente — sem erro, sem aviso, sem ninguém entender por quê. O pior tipo de
defeito: dois acertos isolados que se cancelam.

Agora a onda vai do primeiro `SubagentStart` com o céu vazio até o
`SubagentStop` que o esvazia. Mede-se o Δ% do período e divide pelo número de
participantes. O que continua sujando é o que de fato contamina: **outra
sessão** escrevendo no período, a janela virando no meio, ou o sensor não tendo
observado nada novo.

A divisão por participante é **média, não atribuição** — dentro de uma onda não
dá para saber qual agente gastou o quê, e fingir que dá seria pior que admitir.
Fica gravado como `atribuicao: 'onda'` com o `onda_n`, para o audit poder dizer
de onde veio o número.

Efeito colateral bom: agora existe `ondas.jsonl`, que responde direto a pergunta
que interessa — *quanto custou uma onda de N* — sem passar pela média.

**D32 — Média agrupada, e amostra suja é melhor que amostra nenhuma.** O
primeiro workflow real mediu 9 ondas — 65% de cota gastos em 63 agentes — e o
`cabe` respondia `SEM BASE`. Dois erros somados, cada um invisível sozinho.

```
n=7 → 21%    n=16 → 7%    n=14 → 7%    n=6 → 10%    n=4 → 9%    n=1 → 5%
n=5 →  0% (limpa)         n=7 →  0% (limpa)
```

**(1) Zero não quer dizer "de graça", quer dizer "abaixo da resolução".** Das 9
ondas, só 2 passaram no critério de limpa — e eram as duas mais **curtas**, de
94s e 167s. O percentual vem em número inteiro, então uma onda que custa 0,4%
mede 0. A média das limpas deu `0.000%/agente`, o custo unitário não era maior
que zero, e o `cabe` travava. O filtro selecionava sistematicamente as ondas
mais baratas e concluía que subagente é grátis.

**(2) O critério de limpeza supunha uma sessão só.** O motivo de sujeira
dominante era "outra sessão escreveu no período" — e este usuário roda VS Code
e TUI ao mesmo tempo, por padrão. Contaminação de outra sessão **infla** o Δ,
ou seja, erra para o lado seguro no controle de admissão. Superestimar custo
deixa conservador; não ter número nenhum deixa cego. Então a base suja passou a
ser usada quando a limpa não serve, com o rótulo dizendo isso — nunca chamando
de "limpa" o que não é.

**O estimador agora é agrupado**: soma dos custos ÷ soma dos agentes, não média
de médias. Como cada participante carrega `Δ_onda/n`, somar tudo dá exatamente
`ΣΔ/Σn`, que respeita o peso de cada onda. Com os dados acima: **65/63 =
1.03%/agente** — número utilizável, de `SEM BASE` para `VAI, cabem 14`.

A mensagem de erro também mentia: dizia "nenhuma janela utilizável para
comparar", culpando a janela por um problema de medição. Agora diz que as ondas
foram curtas demais para aparecer no percentual inteiro.

Um padrão apareceu nos dados e vale registrar: **onda grande é mais barata por
agente** (n=16 → 0,44%/agente contra n=1 → 5%/agente). Provável overhead fixo
de contexto que muitos dividem. Isso torna a média unitária um modelo fraco —
ela subestima ondas pequenas e superestima grandes — mas é o que o controle de
admissão precisa, e errar para cima é o lado certo de errar.

**D33 — Nada de leitura-alteração-regravação em arquivo compartilhado.** Havia
seis `onda-atual.json.<pid>.tmp` órfãos no diretório real, cada um com uma lista
de participantes dentro. Sintoma de um defeito que só aparece sob fan-out — que
é o único cenário que importa aqui.

A versão anterior guardava os participantes num arquivo único: cada subagente
lia, se acrescentava e regravava. Com N hooks disparando ao mesmo tempo isso
perde dado de duas formas, e as duas foram medidas com processos reais:

```
 4 simultâneos  ->  0 de 4 perdidos
 8 simultâneos  ->  3 de 8 perdidos     EPERM: rename
16 simultâneos  ->  9 de 16 perdidos    (56%)
```

O `rename` do Windows falha com **EPERM** quando outro processo tem o destino
aberto — e o `.tmp` fica órfão, com a gravação perdida. Os que passam ainda se
sobrescrevem: atualização perdida clássica. Como o medidor engole exceção por
projeto ("medir nunca pode atrapalhar o trabalho"), tudo isso acontecia calado.

`n` subcontado infla `custo/n`. Erra para o lado seguro, mas erra — e o erro
cresce com o tamanho da onda, ou seja, é pior exatamente onde a ferramenta serve.

Agora cada participante grava **só o próprio arquivo**, com o id no nome, dentro
de `onda-participantes/`. Ninguém escreve onde outro escreve. Contar é listar a
pasta ao fechar. O marcador da onda é criado com a flag `wx` (falha se já
existe), então dois que se acharem "primeiros" no mesmo instante não se
sobrescrevem — o segundo desiste, e a diferença de milissegundos no `t0` não
muda nada.

O `gravarJson` ganhou repetição em EPERM/EACCES/EBUSY, que resolve a colisão de
milissegundos, e apaga o `.tmp` quando desiste. E existe um `limparTmp()` que
varre órfãos antigos — só os antigos, para nunca competir com gravação em curso.

Depois: 12 simultâneos, 12 registrados, zero órfãos.

**D34 — Atualização do Claude Code invalida a conferência.** Esta ferramenta lê
contratos oficiais: o JSON da status line e os eventos de hook. Uma versão nova
pode mexer neles, e o modo de falha é silencioso — o sensor continua rodando e
só não acha mais o que procurava.

A aferição passou a registrar a versão junto, e o `audit` compara com a de
agora: *"aferido na 2.1.235, rodando a 2.2.0 — revalide com /usage"*. Custa nada
e transforma "será que quebrou?" numa linha de saída.

O `batimento.json` já guardava a versão desde o começo, mas ninguém comparava.

**D35 — Quem alimenta o mural, e quando um loop é obrigatório.** Esta decisão
mudou duas vezes durante o desenvolvimento, e a versão final é a que o dado
sustenta.

**Só sessão de terminal executa a status line.** A extensão do VS Code sobe o
`claude` em `stream-json`, sem TUI, e nunca chama o sensor. Medido: oito
amostras seguidas do `batimento.json`, todas da sessão do CLI, enquanto a
sessão da extensão — a que estava sendo usada para trabalhar — tinha escrito
pela última vez **cinco horas antes**.

**Terminal aberto e parado não basta.** Ocioso, ele roda o sensor a cada 20s e
regrava o mesmo número: `rate_limits` só se renova quando *aquela* sessão
recebe resposta da API. O `t` avança, o percentual não.

Isso tem consequência direta na medição, e havia um defeito exatamente aí: a
guarda de frescor do medidor comparava `est.t` em vez de `tConfirmado(est)`.
Com terminal ocioso, `est.t` avançava, a guarda passava, e a onda era gravada
**custando 0%** — medição falsa com cara de verdadeira, que puxa a média para
baixo. Esse é o lado *perigoso* de errar: dizer que cabem mais agentes do que
cabem. Corrigido para comparar a confirmação (é o D24 aplicado no único lugar
onde tinha sido esquecido).

**Então, na prática:**

| Onde você trabalha | O que precisa |
|---|---|
| Terminal (TUI) | Nada. A própria sessão renova a cada resposta, e as amostras saem limpas. |
| Extensão do VS Code, ou web | Uma janela de terminal aberta **com um loop**, senão o mural congela. |

Para o segundo caso, a receita é uma janela de CLI dedicada, no modelo mais
barato e no esforço mínimo — ela não precisa pensar, só existir:

```
/loop 3m diga apenas: estou vivo
```

**O preço, e ele é real.** Cada batida do loop escreve no mural, o que marca
como contaminada qualquer onda em curso. Medido: 8 das 9 ondas sujas, todas
pelo loop, com o número de escritas batendo com a cadência (onda de 928s levou
5 batidas). A única onda limpa foi a de 94 segundos, curta o bastante para
caber entre duas.

É exatamente por isso que existe o D32 (usar amostra suja em vez de nenhuma):
sem ele, quem trabalha na extensão ficaria em `SEM BASE` para sempre — ou por
falta de leitura, sem o loop, ou por contaminação, com ele. Contaminação infla
o custo estimado, que é o lado seguro; ficar cego não é.

Vale registrar que qualquer segunda sessão causa a mesma contaminação — VS Code
e TUI abertos ao mesmo tempo já bastam. O loop só garante que aconteça sempre,
em troca de garantir que o mural nunca congele.

**D36 — A mensagem de erro é a documentação.** Quem instala não lê o README, e
reclama que não funciona. Três situações diferentes produzem "a ferramenta não
funciona", e o conserto de cada uma é outro — então a ferramenta detecta em qual
delas você está e entrega o comando:

| Sintoma | Causa | O que dizer |
|---|---|---|
| sem `batimento.json` | o sensor nunca rodou: extensão do VS Code, ou sessão não reiniciada | abra um terminal **e** rode o loop |
| batimento velho | a janela que alimentava foi fechada | abra um terminal **e** rode o loop |
| batimento novo, confirmação velha | terminal aberto mas ocioso | rode o loop **na janela que já existe** |

O terceiro é o que mais engana: o sensor está rodando, a status line pisca, o
countdown desce — e o número está congelado. É o D24 aparecendo na cara do
usuário em vez de só no código.

Quando está tudo certo, **nada** é dito. Aviso que sempre aparece ninguém lê.

**D37 — Config valida o tipo contra o padrão.** `cota config aviso.limiar_5h abc`
gravava a string `"abc"`. Nada explodia: a comparação `pct < "abc"` dá `false`
para sempre, e o aviso simplesmente parava de disparar — para sempre, sem erro e
sem sintoma. Numa ferramenta cujo produto é o aviso, esse é o pior desfecho
possível.

Agora o tipo é conferido contra `CONFIG_PADRAO`, e o intervalo também: limiar
fora de 0–100 e margem fora de 0–1 são recusados, porque os dois desligam a
proteção sem dizer que desligaram.

**D38 — Podar não é faxina, é o que impede a ferramenta de estrangular a si
mesma.** `lerHistorico()` lê **todos** os arquivos de sessão a cada invocação de
hook, e os hooks rodam a cada mensagem e a cada subagente. Com dez sessões isso é
nada; com mil, todo subagente passa a pagar mil leituras de arquivo. Cresce
sozinho e ninguém percebe até ficar lento.

Sessão sem uso há mais de 14 dias sai (as janelas de decisão são de 5h e 7d — o
mês passado não serve para nada), e os `.jsonl` de amostra são truncados no
limite. **A sessão mais recente nunca sai**, é ela que alimenta o mural agora. A
poda roda quando uma onda fecha — evento raro, ao contrário de varrer diretório
a cada hook — e por comando, com `cota limpar`.

## Verificação de segurança

Nove vetores sondados com processos reais, não por leitura de código. O
resultado, e o que foi feito com cada um:

| # | Vetor | Resultado |
|---|---|---|
| 1 | Travessia de caminho por `agent_id` / `session_id` | **bloqueado** — `[^A-Za-z0-9_-]` vira `_`; canário nunca escapou |
| 2 | Poluição de protótipo por `config.json` | `Object.prototype` global intacto; o objeto de config trocava de protótipo → corrigido com `semProto()` |
| 3 | Tipo inválido em `config` | aceitava e desligava a proteção em silêncio → **corrigido** (D37) |
| 4 | Chave de config com caminho de protótipo | já bloqueado |
| 5 | Credencial gravada em disco | nenhuma — o projeto nunca lê `.credentials.json` nem chama API |
| 6 | Caminho de instalação hostil vira injeção | possível em tese; o caminho vem de `__dirname`, então exige controlar onde você instala — quem consegue isso já executa como você |
| 7 | Instalador executa linha lida da skill | é a própria saída dele, relida; TOCTOU dentro do home do usuário |
| 8 | Permissão dos arquivos de estado | eram `0666` → agora `0600`. Guardam id de sessão e perfil de uso |
| 9 | Crescimento sem limite do histórico | **corrigido** (D38) — era o mais concreto dos nove |

Não há rede, `eval`, `new Function` nem `require` dinâmico em nenhum arquivo de
produção. O único `execFileSync` do runtime roda o próprio `sensor.js` com
payload sintético, dentro do `audit`.

O modelo de ameaça que sobra é honesto: quase tudo aqui pressupõe que quem
escreve em `~/.claude/` é você. Quem não é você e consegue escrever ali já tem
sua sessão do Claude Code — e nesse ponto a cota é o menor dos problemas.

## Em aberto

- **Q1** — Margem de segurança: disparar só se couber com quanto de folga? (30%?)
- **Q2** — Quantas sessões suas rodam em paralelo? (muda D6/D7 e o `refreshInterval`)
- **Q3** — Nome do comando e da skill: `cota`?
- **Q4** — Limiar do aviso: mesmo % para a de 5h e a semanal, ou mais baixo na semanal? (estourar a de 5h custa 2h; a semanal custa 4 dias)
- **Q5** — Enquanto não há amostras limpas de custo por agente, o que o agente faz? Recusa por precaução, ou libera avisando que está sem base?
- **Q6** — O `PreToolUse` de D19 pergunta a partir de quantos %?

## Fora de escopo

- API interna da Anthropic / token do `.credentials.json`
- Limite em número absoluto (tokens/mensagens) — a Anthropic só publica percentual
- Qualquer coisa que crie turno de API por conta própria

## Dependências de realidade

- `rate_limits` só existe para assinante Claude.ai Pro/Max, e só após a primeira
  resposta da API na sessão
- Relógio da máquina: `resets_at` é UTC do servidor; relógio torto = countdown mentiroso
- **A status line não executa na extensão do VS Code.** Ela sobe o `claude` em
  `--output-format stream-json`, sem TUI, e status line é recurso de terminal.
  Confirmado também em headless (`claude -p`). Só a TUI alimenta o mural.
- **Sub-limite por modelo é invisível.** O `/usage` mostra a semanal quebrada
  por modelo (ex.: "Todos os modelos 62%" e "Fable 11%"), mas `rate_limits` só
  entrega os dois agregados. Se um modelo específico estourar antes do agregado,
  o `cota` não vê chegando.
- **O transcript de uma sessão é uma árvore, não uma lista.** Cada mensagem tem
  `parentUuid`, e cada cliente acoplado (extensão, TUI, web) escreve pendurando
  na folha em que ele estava. Mesmo `session_id`, mesmo arquivo, **ramos
  diferentes** — e o contexto de cada ramo é só a sua própria linhagem. Não
  afeta o `cota` (o limite é da conta, não do ramo), mas afeta você: fale por
  uma janela só, e cuidado com dois ramos editando os mesmos arquivos.
- **Promoção muda o denominador.** Limite semanal 50% maior até 31/08/2026: 62%
  hoje equivale a 93% do limite normal. Percentuais de antes e depois da data
  não são comparáveis, e o ritmo aprendido salta ~50% quando ela terminar. Cada
  janela se recalibra sozinha, mas o histórico antigo perde valor.
