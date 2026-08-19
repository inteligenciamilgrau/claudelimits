#!/usr/bin/env node
'use strict';
/*
 * medidor.js — hooks SubagentStart e SubagentStop.
 *
 * Mede quanto custa um subagente, em % da janela (D14), e vigia a cota durante
 * o trabalho (D30).
 *
 * A unidade de medida é a ONDA, não o subagente (D31). Uma onda vai de "o
 * primeiro subagente entrou em voo" até "o último saiu". Mede-se o Δ% do
 * período inteiro e divide pelo número de participantes.
 *
 * NADA aqui faz leitura-alteração-regravação de arquivo compartilhado (D33):
 * N hooks disparam ao mesmo tempo, e isso perdia participante. Cada um escreve
 * só o próprio arquivo.
 *
 * Nunca bloqueia — parar é decisão do agente (D17), e SubagentStop bloquearia
 * o subagente errado (o que já terminou).
 */

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');

const VOO = path.join(core.DIR, 'em-voo');

function lerStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

const seguro = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const arquivoVoo = id => path.join(VOO, seguro(id) + '.json');
const arquivoParte = id => path.join(core.F.ondaParts, seguro(id) + '.json');

function listar(dir) {
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
}

const emVoo = () => listar(VOO);

function apagarPasta(dir) {
  for (const n of listar(dir)) {
    try { fs.unlinkSync(path.join(dir, n)); } catch (_) {}
  }
}

/*
 * D25 — varrer órfãos antes de qualquer coisa.
 *
 * Se a sessão morrer com um subagente rodando, o `SubagentStop` nunca dispara e
 * a entrada fica em voo para sempre. A onda nunca fecha, e o `cabe N` trava em
 * SEM BASE sem ninguém entender por quê — falha silenciosa e permanente.
 *
 * Visto acontecer de verdade: um subagente foi interrompido quando o processo
 * do Claude Code encerrou no meio do trabalho dele.
 */
function limparOrfaos(nowS, maxS) {
  let removidos = 0;
  for (const nome of emVoo()) {
    const p = path.join(VOO, nome);
    const e = core.lerJson(p, null);
    if (!e || core.num(e.t0) === null || nowS - e.t0 > maxS) {
      try { fs.unlinkSync(p); removidos++; } catch (_) {}
    }
  }
  // Se a varredura esvaziou o céu, a onda em aberto não fecha mais de forma
  // confiável: o Δ dela incluiria trabalho que não sabemos atribuir.
  if (removidos && emVoo().length === 0) {
    try { fs.unlinkSync(core.F.ondaAtual); } catch (_) {}
    apagarPasta(core.F.ondaParts);
  }
}

/* ------------------------------- a onda ------------------------------- */

/*
 * D33 — um arquivo por participante, e o marcador da onda criado em modo
 * exclusivo.
 *
 * A versão anterior guardava a lista de participantes DENTRO de um
 * `onda-atual.json` único: cada subagente lia, se acrescentava e regravava.
 * Com N hooks disparando ao mesmo tempo isso perde dado de duas formas — o
 * rename do Windows falha com EPERM quando outro processo tem o destino
 * aberto, e mesmo os que passam se sobrescrevem (atualização perdida clássica).
 *
 * Medido, com processos reais concorrentes:
 *
 *     4 simultâneos  →  0 de 4 perdidos
 *     8 simultâneos  →  3 de 8 perdidos
 *    16 simultâneos  →  9 de 16 perdidos
 *
 * `n` subcontado infla `custo/n` — erra para o lado seguro, mas erra, e piora
 * justo quando a onda é maior, que é o caso para o qual isto existe.
 *
 * Agora cada participante grava só o SEU arquivo, com o próprio id no nome:
 * ninguém escreve onde outro escreve, então não há corrida. Contar é listar a
 * pasta na hora de fechar.
 */
function inicio(ev, est, nowS) {
  fs.mkdirSync(VOO, { recursive: true });
  fs.mkdirSync(core.F.ondaParts, { recursive: true });

  // Ordem importa: quem olha o céu antes de entrar nele sabe se é o primeiro.
  const primeiro = emVoo().length === 0;

  core.gravarJson(arquivoVoo(ev.agent_id), {
    tipo: ev.agent_type || null, sessao: ev.session_id || null, t0: nowS,
  });
  core.gravarJson(arquivoParte(ev.agent_id), {
    id: ev.agent_id, tipo: ev.agent_type || null, t0: nowS,
  });

  if (!primeiro) return;

  /*
   * 'wx' falha se o arquivo já existe, então dois que se acharem "primeiros"
   * no mesmo instante não se sobrescrevem: o segundo simplesmente desiste. É
   * a diferença de milissegundos no t0 da onda, que não muda nada, contra uma
   * gravação perdida, que mudaria.
   */
  try {
    fs.writeFileSync(core.F.ondaAtual, JSON.stringify({
      t0: nowS, estado_t0: core.tConfirmado(est), sessao: ev.session_id || null,
      pct5_0: est.pct5, pct7_0: est.pct7,
      reset5_0: est.reset5, reset7_0: est.reset7,
    }, null, 2), { flag: 'wx' });
  } catch (_) { /* outro abriu a onda primeiro: correto, segue */ }
}

/*
 * Fecha a onda quando o último subagente sai, e converte o Δ do período em
 * custo por agente.
 *
 * A divisão por participante é média, não atribuição: dentro de uma onda não
 * dá para saber qual agente gastou o quê, e fingir que dá seria pior. Fica
 * marcado como `atribuicao: 'onda'` para o audit poder dizer isso.
 */
function fim(ev, est, nowS, cfgPoda) {
  const f = arquivoVoo(ev.agent_id);
  const meu = core.lerJson(f, null);
  try { fs.unlinkSync(f); } catch (_) {}
  if (!meu) return;

  // Ainda tem gente em voo: a onda continua, não há o que fechar.
  if (emVoo().length > 0) return;

  const onda = core.lerJson(core.F.ondaAtual, null);
  const parts = listar(core.F.ondaParts)
    .map(n => core.lerJson(path.join(core.F.ondaParts, n), null))
    .filter(Boolean);

  try { fs.unlinkSync(core.F.ondaAtual); } catch (_) {}
  apagarPasta(core.F.ondaParts);

  if (!onda) return;
  const n = parts.length;
  if (n < 1) return;

  const motivos = [];

  // A janela virou no meio: o Δ não é custo, é reset. Descarta de vez.
  if (est.reset5 !== onda.reset5_0) return;

  /*
   * D24 aplicado aqui também: o que vale é a CONFIRMAÇÃO, não a observação.
   *
   * Uma sessão de terminal aberta e parada continua rodando o sensor a cada 20s
   * e regravando o mesmo número. `est.t` avança, o percentual não. Comparando
   * por `est.t`, a guarda passava e a onda era registrada custando 0% — medição
   * falsa com cara de verdadeira, e ela puxa a média para baixo, que é o lado
   * PERIGOSO de errar.
   *
   * É o cenário normal de quem trabalha na extensão do VS Code: ela não executa
   * status line, então quem alimenta o mural é uma janela de terminal que pode
   * estar ociosa o tempo todo.
   */
  if (core.tConfirmado(est) === onda.estado_t0) return;

  const d5 = (core.num(est.pct5) !== null && core.num(onda.pct5_0) !== null)
    ? est.pct5 - onda.pct5_0 : null;
  const d7 = (core.num(est.pct7) !== null && core.num(onda.pct7_0) !== null)
    ? est.pct7 - onda.pct7_0 : null;
  if (d5 === null || d5 < 0) return;

  // Outra sessão escrevendo no período contamina o Δ — e isso o histórico por
  // sessão (D7) permite detectar. Não desqualifica a amostra (D32): infla o
  // custo, que é o lado seguro de errar.
  const outras = new Set();
  for (const h of core.lerHistorico()) {
    if (h.t >= onda.t0 && h.t <= nowS && h.sessao && h.sessao !== onda.sessao) {
      outras.add(h.sessao);
    }
  }
  if (outras.size > 0) motivos.push(outras.size + ' outra(s) sessão(ões) escrevendo no período');

  const limpa = motivos.length === 0;
  const dur = nowS - onda.t0;

  core.appendJsonl(core.F.ondas, {
    t: nowS, n, dur_s: dur, custo5: d5, custo7: d7, limpa, motivos,
    sessao: onda.sessao, tipos: parts.map(p => p.tipo),
  });

  /*
   * Poda aqui porque fechar onda é evento raro — varrer diretório a cada hook
   * seria pior que o problema. O histórico é lido INTEIRO por lerHistorico() em
   * toda invocação de hook; sem poda, cada subagente passa a pagar uma leitura
   * por sessão que já existiu.
   */
  try { core.podar(cfgPoda.dias, cfgPoda.max_linhas); } catch (_) {}

  // Uma linha por participante, com o custo médio da onda. `custoPorTipo` lê
  // daqui sem precisar saber que a medição foi coletiva.
  for (const p of parts) {
    core.appendJsonl(core.F.agentes, {
      t: nowS, tipo: p.tipo, sessao: onda.sessao,
      dur_s: dur, custo5: d5 / n, custo7: d7 === null ? null : d7 / n,
      limpa, motivos, atribuicao: 'onda', onda_n: n,
    });
  }
}

/*
 * D30 — o vigia do workflow.
 *
 * Os outros dois avisos não cobrem o cenário que mais importa. O `aviso` pega
 * carona na mensagem do humano: durante um workflow ninguém está digitando,
 * então ele nunca roda. O `admissao` dispara uma vez, no lançamento — e um
 * workflow queima 10% em 15 minutos DEPOIS disso.
 *
 * `SubagentStop` é o único evento que bate ponto sozinho enquanto o trabalho
 * corre. E ele não viola o D3 (não acordar agente ocioso): se ele disparou, há
 * trabalho em curso por definição. É carona, não despertador.
 *
 * Fala por `systemMessage`, único canal que o SubagentStop aceita — ele não
 * suporta `additionalContext`. Nunca bloqueia.
 */
function vigiar(cfg, est, nowS) {
  if (!cfg.ligado || !cfg.vigia.ligado) return null;

  const j = core.lerJanelas(est, cfg, nowS, core.lerHistorico());
  const linhas = [];
  const chaves = [];
  for (const [jan, rot, lim] of [[j.cinco, '5h', cfg.vigia.limiar_5h],
                                 [j.sete, 'semanal', cfg.vigia.limiar_7d]]) {
    if (jan.pctParaDecidir === null || jan.pctParaDecidir < lim) continue;
    const quando = jan.segAteReset !== null
      ? `, reseta em ${core.fmtDuracao(jan.segAteReset)}` : '';
    linhas.push(`${rot}: ${jan.pctParaDecidir.toFixed(0)}%${quando}`);
    // Assinatura por faixa de 5%: durante workflow a cota anda rápido, e cada
    // faixa nova merece ser dita uma vez.
    chaves.push(`${rot}:${jan.resetsAt}:${Math.floor(jan.pctParaDecidir / 5)}`);
  }
  if (!linhas.length) return null;

  const assinatura = chaves.join('|');
  const ult = core.lerJson(core.F.vigiaUltimo, null);
  if (ult && ult.assinatura === assinatura &&
      nowS - ult.t < cfg.vigia.repetir_min * 60) return null;
  core.gravarJson(core.F.vigiaUltimo, { t: nowS, assinatura });

  return '[cota] Subagente terminou. ' + linhas.join(' · ') +
         '. Antes da próxima onda, rode `cota cabe <n>` — e se não couber, ' +
         'pare limpo e diga o horário do reset em vez de reduzir por conta própria.';
}

try {
  const ev = lerStdin();
  if (ev && ev.agent_id) {
    const cfg = core.lerConfig();
    const nowS = core.agora();
    limparOrfaos(nowS, cfg.medidor.orfao_max_s);
    core.limparTmp();
    const est = core.lerEstado();
    if (est) {
      if (ev.hook_event_name === 'SubagentStart') inicio(ev, est, nowS);
      else if (ev.hook_event_name === 'SubagentStop') {
        fim(ev, est, nowS, cfg.poda);
        // Medir primeiro, vigiar depois: o aviso deve refletir o custo que
        // acabou de ser contabilizado, não o estado anterior a ele.
        const msg = vigiar(cfg, core.lerEstado() || est, core.agora());
        if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
      }
    }
  }
} catch (_) { /* medir nunca pode atrapalhar o trabalho */ }
process.exit(0);
