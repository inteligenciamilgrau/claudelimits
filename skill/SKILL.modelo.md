---
name: cota
description: Consulta a cota de uso do Claude Code — quanto já foi consumido da janela de 5 horas e da semanal, quando cada uma reseta, e se a cota aguenta uma operação pesada. Use ANTES de lançar workflow, fan-out de subagentes, ou qualquer coisa com vários agentes em paralelo. Também diagnostica se o próprio medidor está certo.
---

# cota

Ferramenta local que lê os limites de uso do Claude Code. Rode pelo Bash.

**Copie a linha e rode. Não substitua nada, não defina variável.**

## A regra principal

Antes de lançar workflow, `Agent` em paralelo, ou qualquer fan-out, rode isto
trocando só o número pela quantidade de agentes:

```bash
{{COTA}} cabe 10
```

A resposta traz um veredito. Faça o que ele diz:

| Veredito | O que fazer |
|---|---|
| `VAI` | Pode disparar. |
| `APERTADO` | Pode, mas avise o usuário de quanto do orçamento vai consumir. |
| `NÃO CABE` | **Não dispare.** Ofereça o que a saída sugere: rodar com o número reduzido (`cabem agora: N`), ou esperar o reset (o horário vem junto). |
| `SEM BASE` | Ainda não há amostras de custo. Pode disparar, **mas diga ao usuário que foi sem base de cálculo**. |
| `SEM DADO` | A leitura expirou ou não existe. Trate como sem base, e rode o `audit` abaixo. |

## Dispare em ondas, não numa salva só

A saída do `cabe` traz uma linha como **`dispare 3 agora, depois reavalie
(faltam 7)`**. Obedeça: lance a onda, espere terminar, rode o `cabe` de novo, e
só então lance a próxima.

Isso não é excesso de zelo. Dez agentes de uma vez gastam a cota no momento em
que se sabe menos sobre ela; em ondas, cada uma devolve medição real e a
seguinte decide melhor. E entre uma onda e outra é a única hora em que parar
sai barato.

Se o veredito for `SEM BASE`, a primeira onda **serve para medir** — é ela que
cria a base de custo por subagente. Dispare a onda sugerida, não o pedido
inteiro, e diga ao usuário que a primeira leva é de calibração.

Quando a saída disser `pode disparar os N de uma vez`, pode.

O custo por subagente vem de **medição coletiva**: mede-se o gasto da onda
inteira e divide pelo número de participantes. É média, não atribuição — dentro
de uma onda paralela não dá para saber qual agente gastou o quê. Se um tipo de
agente for muito mais caro que os outros na mesma onda, a média esconde isso.
Para trabalho heterogêneo pesado, prefira ondas do mesmo tipo de agente.

## Você será avisado durante o trabalho

Ao fim de cada subagente, se a cota passar do limiar, chega uma mensagem
`[cota] Subagente terminou...` com o percentual atual. Ela não bloqueia nada —
é aviso, e a decisão é sua. Ao recebê-la, rode o `cabe` antes da próxima onda.

Não repita esse aviso ao usuário a cada vez. Fale uma vez, e só volte ao assunto
se a decisão mudar (por exemplo: agora não cabe mais, e você vai parar).

## Situação agora

```bash
{{COTA}}
```

As duas janelas com percentual e reset, e o ritmo medido no período recente.

**O ritmo é descrição do passado, não previsão.** `12%/h nos últimos 2h11`
quer dizer que isso já aconteceu — não que vai continuar. Não extrapole para
dizer quando a cota acaba: o uso é por rajadas (workflow pesado que queima em
minutos, depois dias parado, depois perguntas lentas), e nenhuma média entre
esses regimes descreve qualquer um deles. Use o ritmo só para responder "está
indo rápido?". Para "cabe X agentes?", use o `cabe` acima, que decide por custo
medido e não por extrapolação.

Para processar, acrescente `--json` no fim.

## Diagnóstico, quando o número parecer errado

```bash
{{COTA}} audit
```

Diz em que elo a corrente quebrou. Use quando não houver leitura nenhuma, ou
quando o valor não bater com o `/usage`.

## Ligar e desligar

Troque `off` por `on` para religar:

```bash
{{COTA}} off
```

Desativada, qualquer consulta responde que está desativada. Nesse caso **não
contorne** lendo os arquivos direto: diga ao usuário que a cota está desativada
e siga o trabalho.

## O comando é tolerante

Sinônimo funciona (`ver`, `aguenta`, `debug`, `diagnóstico`), maiúscula e acento
não atrapalham, e número solto vira `cabe`: `cota.js 10` == `cota.js cabe 10`.
Comando desconhecido mostra a situação em vez de dar erro.

**Nada aqui sai com código de erro por digitação.** Se você receber um erro de
verdade, é problema real — não é o comando errado.

## Interpretar o estado do dado

Cada janela vem com um estado, e ele muda o que o número vale:

- **fresco** — vale como está.
- **piso** — leitura velha, janela ainda viva. O valor é um **mínimo**: pode
  estar mais alto agora, nunca mais baixo. Decida por ele, errando para o lado
  seguro. Aparece como `≥34%`.
- **expirado** — a janela virou. O número **não vale nada**: não é o valor
  antigo nem zero. Nunca repita um valor expirado ao usuário.
- **desconhecido** — a premissa do piso foi violada. Trate como sem dado.

Armadilha: o contador de reset (`↻`) é calculado do relógio e desce sozinho
**mesmo com o percentual congelado**. Contador andando não prova dado fresco.
Só o estado prova.

## Quando a cota estiver acabando

Se a janela estiver perto do fim e o trabalho não couber:

1. **Pare limpo.** Termine o que está em andamento, não comece nada novo, não
   force um fan-out reduzido sem falar.
2. **Escreva o estado**: o que foi feito, o que falta, por onde retomar.
3. **Informe o horário do reset**, que vem na saída.
4. Não retome sozinho depois do reset a menos que o usuário tenha pedido.

## A verdade é o /usage

O `/usage` vem da Anthropic. O `cota` é código local e pode errar. Se os dois
discordarem, o `/usage` ganha — e o usuário registra a divergência com
`cota.js audit <5h> <7d>`, usando os números que o `/usage` mostrou.
