# cota

Faz o seu agente de IA — **Claude Code** ou **Codex** — saber quanto da sua
cota de uso já foi gasto, e responder a pergunta que importa antes de disparar
trabalho pesado: **dá para lançar 10 subagentes agora? Se não, quantos?**

![O agente consultando a cota pela skill, dentro da extensão do VS Code](docs/exemplo.jpg)

Com o cota instalado, o agente:

- **consulta a cota sozinho** antes de lançar vários subagentes;
- **avisa** quando você passa de 80% da janela de 5 horas (ou de 70% da semanal);
- **mede** quanto um subagente costuma gastar e diz **quantos cabem agora**;
- **vigia** a cota enquanto um trabalho longo roda.

Ler a cota **não gasta cota**: o cota usa o mesmo pedido que o medidor de uso
da extensão do VS Code usa, pelo próprio Claude Code (ou Codex) com o login
que ele já tem. Ele não lê senha nem token.

## Do que você precisa

| | Claude Code | Codex |
|---|---|---|
| **Programa** | extensão do VS Code ou o terminal (CLI) | extensão do VS Code ou o terminal (CLI) |
| **Conta** | plano Pro ou Max (conta só de API não tem cota para ler) | login com conta ChatGPT |
| **Node.js 18+** | o instalador ajuda a instalar, se faltar | o mesmo |

Funciona com um dos dois ou com os dois — o instalador detecta sozinho.

## Instalar

Escolha um dos três jeitos.

### 1. O mais fácil: peça ao seu agente

Cole isto no Claude Code ou no Codex:

> Instale a ferramenta cota de https://github.com/inteligenciamilgrau/claudelimits
> seguindo a seção "Para o agente que vai instalar" do README. Use uma pasta
> permanente, como `~/cota`, e no fim me diga o que falta eu fazer.

### 2. Windows, sem terminal

1. Nesta página, clique no botão verde **Code** → **Download ZIP**.
2. **Extraia o ZIP** (botão direito → *Extrair tudo*) numa pasta que vai ficar,
   como `Documentos\cota`. Não rode de dentro do ZIP, e não apague a pasta
   depois: a ferramenta roda de lá.
3. Dê **dois cliques em `INSTALAR.cmd`**. Se o Windows perguntar se quer mesmo
   executar um arquivo baixado da internet, confirme.

Se faltar o Node.js, o instalador oferece instalar (pelo `winget`, que já vem
no Windows) ou abre a página de download.

### 3. Linux e macOS, pelo terminal

```bash
git clone https://github.com/inteligenciamilgrau/claudelimits.git ~/cota
sh ~/cota/instalar.sh
```

Se faltar o Node.js, ele diz como instalar.

### Depois de instalar

O instalador termina com uma lista do que falta. É sempre isto:

- **Claude Code:** abra uma conversa nova (ou recarregue o VS Code).
- **Codex:** aprove os hooks. O Codex não executa nada que você não aprovou,
  e a aprovação é feita no Codex do terminal: rode `codex`, digite `/hooks` e
  aprove os cinco hooks `cota-codex`. O instalador mostra o comando exato,
  inclusive se você só usa a extensão. Depois abra uma conversa nova.

## Usar

Pergunte ao agente, do seu jeito: *"quanto da minha cota eu já usei?"* ou
*"dá para rodar 10 agentes em paralelo?"*. Ele roda o cota e responde. Antes
de disparar muitos subagentes ele consulta sozinho.

Você também pode rodar na mão, de dentro da pasta:

```
cota  — limites de uso do Claude Code

  5h  ███░░░░░░░░░░░░░░░   15.0%   reseta em 3h29 (18:00)
  7d  ███████░░░░░░░░░░░   39.0%   reseta qua 21/10 14:00 (em 5d 23h)
      por modelo: Fable 0%

  leitura de 0min atrás  ·  plano max
```

| Comando | O que faz |
|---|---|
| `cota` | as duas janelas: quanto foi **consumido** e quando reseta |
| `cota cabe 10` | a cota aguenta 10 subagentes? quantos agora? |
| `cota audit` | diagnóstico: se algo não funciona, diz onde quebrou |
| `cota off` / `cota on` | desliga / religa a ferramenta inteira |
| `cota config` | mostra a configuração (`cota config aviso.limiar_5h 70` muda) |

No Windows o comando é `cota.cmd`, no Linux e no macOS `./cota`, e em qualquer
um `node cota.js`. **Para o Codex, acrescente `--codex`**: `cota.cmd --codex cabe 4`.

### Nos primeiros dias, o `cabe` responde "SEM BASE"

É normal, não é defeito. Para dizer quantos subagentes cabem, o cota precisa
medir quanto um subagente **seu** gasta — e essa medida só existe depois que
você usa alguns. Ela vem sozinha: a primeira leva de subagentes serve de
calibração, e o agente avisa isso. As janelas de 5h e semanal funcionam desde
o primeiro minuto.

## Problemas comuns

- **"não achei o Node.js"** — rode o instalador (`INSTALAR.cmd` ou
  `sh instalar.sh`): ele acha ou ajuda a instalar.
- **"a leitura da cota falhou"** — rode `cota sondar`, que mostra o erro
  inteiro. No Claude, confira se a conta é Pro ou Max; no Codex, rode
  `codex login status`.
- **Mudei a pasta de lugar** — rode o instalador de novo. (No Codex, aprove os
  hooks de novo em `/hooks`: o caminho mudou.)
- **No Codex, o `audit` diz `nao_observada`** — os hooks ainda não foram
  aprovados em `/hooks`.
- **Atualizar** — `git pull` na pasta (ou baixe o ZIP de novo por cima) e rode
  o instalador de novo.

## Desinstalar

De dentro da pasta, `node instalar.js --remover` (ou peça ao agente). Sai só o
que é do cota: os hooks e as skills. Hooks de outras ferramentas ficam, e um
backup das configurações fica ao lado delas. O histórico em `~/.claude/cota/`
e `~/.codex/cota/` fica — apague se quiser.

## Privacidade

- O código do cota **não fala com a internet** e não lê credencial. Quem fala
  é o próprio Claude Code (ou Codex), com o login que ele já tem, só quando
  alguém precisa do número — no máximo uma vez por minuto em uso ativo, nunca
  parado.
- Tudo fica na sua máquina, em `~/.claude/cota/` e `~/.codex/cota/`.
- Os números são os mesmos do `/usage` do Claude Code (do `/status` no Codex).
  Na dúvida, eles são a referência.

## Limitações principais

- A leitura do Claude usa um pedido **não documentado** da Anthropic (o mesmo
  do medidor da extensão). Se mudar, o cota para e diz o que quebrou — nunca
  inventa número.
- O percentual vem inteiro, e o custo por subagente é uma **divisão** do que a
  conta gastou, não uma conta individual por agente.
- O projeto nasceu no Windows. Linux e macOS **nunca rodaram de verdade** —
  se for o primeiro, rode `node teste` e abra uma issue se algo não bater.

A lista completa está em [docs/como-funciona.md](docs/como-funciona.md#limitações).

## Para o agente que vai instalar

1. Clone o repositório numa pasta permanente (por exemplo `~/cota`) — os hooks
   ficam apontando para ela. Não use pasta temporária.
2. Confira `node --version`. Precisa ser 18 ou mais novo. Se faltar, peça
   permissão ao usuário e instale: no Windows,
   `winget install -e --id OpenJS.NodeJS.LTS`; no macOS com Homebrew,
   `brew install node`; senão, peça ao usuário para instalar a versão LTS de
   https://nodejs.org.
3. De dentro da pasta, rode `node instalar.js` (com o caminho completo do node
   se ele não estiver no PATH). Não edite `settings.json` nem `hooks.json` à
   mão: o instalador preserva o que já existe, faz backup e confere tudo.
4. Se aparecer `[FALHA]`, mostre a linha ao usuário. Senão, repasse a lista
   "Falta só" do final — principalmente a aprovação em `/hooks` no Codex, que
   só o usuário pode fazer.

## Para quem vai mexer no código

- `node teste` roda todos os testes. O Claude e o Codex são falsos: não usam
  rede, não gastam cota e não encostam no seu estado real.
- [docs/como-funciona.md](docs/como-funciona.md) — como a cota é lida, as
  peças, a configuração completa, o que sai da máquina.
- [docs/codex.md](docs/codex.md) — o que muda no Codex.
- [docs/instalar-na-mao.md](docs/instalar-na-mao.md) — o que o instalador grava, passo a passo.
- [docs/DECISOES.md](docs/DECISOES.md) — o porquê de cada decisão.

## Licença

[MIT](LICENSE).
