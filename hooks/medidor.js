#!/usr/bin/env node
'use strict';
/*
 * medidor.js — hooks SubagentStart e SubagentStop.
 *
 * Mede quanto custa um subagente, em % da janela, e vigia a cota durante o
 * trabalho (D30).
 *
 * D47 — a medição é feita em TRECHOS. A cota é um número só, da conta
 * inteira: o custo de um subagente não se lê direto. Então a cota é lida em
 * marcos, e o que ela subiu entre dois marcos é dividido entre os subagentes
 * que rodaram naquele trecho, pelo TEMPO que cada um rodou dentro dele. Quando
 * um subagente termina, a soma das partes dele é o custo, e entra na base na
 * hora — sem esperar os outros.
 *
 *   10:00 marco 40%   A e B começam
 *   10:03 B termina → marco 46%: 6% pelos 3min de A e de B → B custou 3%
 *   10:05 A termina → marco 48%: 2% só para A               → A custou 3+2 = 5%
 *
 * Antes (D31) a unidade era a onda inteira, do primeiro subagente ao último,
 * e ela só fechava com o céu vazio. Mas os hooks são globais: com agentes de
 * outra sessão rodando, o céu quase nunca esvaziava, e nada era medido.
 *
 * Um subagente que termina só lê a cota se o trecho em curso já tiver
 * `medidor.trecho_s` (2min) ou se o céu esvaziou; senão a parte dele sai no
 * próximo marco. Assim a leitura (~1,5s) não segura cada um que termina.
 *
 * Nada aqui faz leitura-alteração-regravação de arquivo compartilhado (D33):
 * cada subagente grava só os próprios arquivos, e quem fecha um trecho o
 * reivindica renomeando o marco — só um consegue.
 *
 * Nunca bloqueia — parar é decisão do agente (D17), e SubagentStop bloquearia
 * o subagente errado (o que já terminou).
 */

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const sonda = require('../lib/sonda');

const VOO = core.F.emVoo;
const FIM = core.F.terminados;
const ACUM = core.F.acumulado;

// Quem começou até isto antes da cadeia de marcos ainda conta como coberto
// por ela: subagentes disparados juntos começam com milissegundos de diferença.
const FOLGA_CADEIA_MS = 5000;

function lerStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

const seguro = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const arq = (dir, id) => path.join(dir, seguro(id) + '.json');
const apagar = p => { try { fs.unlinkSync(p); } catch (_) {} };

function listar(dir) {
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
}
const ler = dir => listar(dir).map(n => Object.assign(
  {}, core.lerJson(path.join(dir, n), {}), { arquivo: path.join(dir, n), id: n.slice(0, -5) }));
const emVoo = () => listar(VOO);

// Registro antigo, de antes do D47, guarda o início em segundos.
const t0De = e => (core.num(e.t0_ms) !== null ? e.t0_ms : (core.num(e.t0) || 0) * 1000);

// Alguém está fechando um trecho agora: o marco foi renomeado para isto.
function fechandoAgora() {
  let nomes = [];
  try { nomes = fs.readdirSync(core.DIR); } catch (_) { return false; }
  return nomes.some(n => {
    if (!n.startsWith('marco.json.fechando.')) return false;
    try { return Date.now() - fs.statSync(path.join(core.DIR, n)).mtimeMs < 60000; }
    catch (_) { return false; }
  });
}

// A cadeia de marcos acabou sem medida: nada dela serve para a próxima.
function descartarTudo() {
  apagar(core.F.marco);
  for (const d of [FIM, ACUM]) for (const n of listar(d)) apagar(path.join(d, n));
}

/*
 * D25 — varrer órfãos antes de qualquer coisa. Se a sessão morre com um
 * subagente rodando, o `SubagentStop` dele nunca dispara. Passadas 2h, o
 * registro sai — e a parte que ele acumulou se perde junto: não há como saber
 * o que era dele.
 */
function limparOrfaos(maxS) {
  let removidos = 0;
  for (const e of ler(VOO)) {
    if (Date.now() - t0De(e) > maxS * 1000) {
      apagar(e.arquivo); apagar(arq(ACUM, e.id)); removidos++;
    }
  }
  if (removidos && emVoo().length === 0 && !fechandoAgora()) descartarTudo();
}

/* ------------------------------ começar ------------------------------ */

function inicio(ev, cfg) {
  const agora = Date.now();
  core.gravarJson(arq(VOO, ev.agent_id), {
    tipo: ev.agent_type || null, sessao: ev.session_id || null, t0_ms: agora,
  });

  /*
   * Sem marco, e ninguém fechando um trecho agora: abre uma cadeia. É o caso
   * do primeiro subagente com o céu vazio — e também o de uma cadeia perdida
   * com gente em voo, que assim se recupera sozinha. Quem já estava rodando
   * antes da cadeia não tem o custo inteiro coberto e não vira amostra.
   * Com alguém fechando, não abre: quem fecha grava o marco seguinte.
   */
  if (fs.existsSync(core.F.marco) || fechandoAgora()) return;
  sonda.garantirFrescoHook(cfg.sonda.idade_s);
  const est = core.lerEstado();
  if (!est || core.num(est.pct5) === null) return;
  try {
    fs.writeFileSync(core.F.marco, JSON.stringify({
      t_ms: core.tMs(est), pct5: est.pct5, pct7: est.pct7,
      reset5: est.reset5, reset7: est.reset7, cadeia_ms: agora,
    }, null, 2), { flag: 'wx' });
  } catch (_) { /* outro abriu primeiro: correto, segue */ }
}

/* ------------------------------ terminar ------------------------------ */

function fim(ev, cfg) {
  const meu = core.lerJson(arq(VOO, ev.agent_id), null);
  if (!meu) return;
  // Grava o fim antes de sair do céu: em nenhum instante ele some dos dois.
  core.gravarJson(arq(FIM, ev.agent_id), Object.assign({}, meu, { t1_ms: Date.now() }));
  apagar(arq(VOO, ev.agent_id));

  const ultimo = emVoo().length === 0;
  const marco = core.lerJson(core.F.marco, null);
  if (!marco) {
    // Sem cadeia não há o que medir; se ninguém mais roda, limpa.
    if (ultimo && !fechandoAgora()) descartarTudo();
    return;
  }
  // Trecho curto e ainda há gente: a parte dele sai no próximo marco.
  if (!ultimo && Date.now() - core.num(marco.t_ms) < cfg.medidor.trecho_s * 1000) return;
  fecharTrecho(cfg);
}

/*
 * Fecha o trecho em curso: lê a cota, divide o que ela subiu pelo tempo de
 * cada subagente no trecho, e grava o custo de quem já terminou.
 *
 * Quem fecha reivindica o trecho renomeando o marco: dois fechando juntos, só
 * um consegue, e o outro segue sem esperar. A leitura tem de ser PEDIDA
 * depois do fim do trecho (D41) — uma que já estava em curso não o inclui.
 */
function fecharTrecho(cfg) {
  // Mais de uma volta só se alguém terminou DURANTE a leitura e o céu esvaziou.
  for (let volta = 0; volta < 3; volta++) {
    const meu = core.F.marco + '.fechando.' + process.pid;
    try { fs.renameSync(core.F.marco, meu); } catch (_) { return; }
    // Renomear não muda a data do arquivo; sem isto o marco reivindicado
    // pareceria velho, e um subagente que começasse agora abriria outra cadeia.
    try { const t = new Date(); fs.utimesSync(meu, t, t); } catch (_) {}
    const marco = core.lerJson(meu, null);

    const tFim = Date.now();
    sonda.garantirFrescoHook(0, { depoisDeMs: tFim });
    const est = core.lerEstado();

    if (!marco || !est || core.tMs(est) < tFim) {
      // Sem leitura nova. Ainda há gente: devolve o marco, e o próximo fecha
      // um trecho maior. Ninguém mais: a cadeia acaba sem medida — um Δ de
      // número velho seria 0%, medição falsa que puxa a média para baixo.
      if (emVoo().length) { try { fs.renameSync(meu, core.F.marco); } catch (_) { apagar(meu); } }
      else { apagar(meu); descartarTudo(); }
      return;
    }
    apagar(meu);
    repartir(marco, est, tFim);

    // A cadeia continua se ainda há gente — em voo, ou que terminou durante a
    // leitura e ficou para o próximo trecho.
    if (emVoo().length || listar(FIM).length) {
      try {
        fs.writeFileSync(core.F.marco, JSON.stringify({
          t_ms: core.tMs(est), pct5: est.pct5, pct7: est.pct7,
          reset5: est.reset5, reset7: est.reset7, cadeia_ms: marco.cadeia_ms,
        }, null, 2), { flag: 'wx' });
      } catch (_) {}
    }
    if (emVoo().length === 0 && listar(FIM).length > 0) continue;
    return;
  }
}

function repartir(marco, est, tFim) {
  const ini = core.num(marco.t_ms);
  const fim = ler(FIM).filter(e => core.num(e.t1_ms) !== null && e.t1_ms <= tFim);
  const terminou = new Set(fim.map(e => e.id));
  // Quem mudou de pasta no meio da leitura aparece nas duas: vale o fim.
  const partes = fim.concat(ler(VOO).filter(e => !terminou.has(e.id) && t0De(e) < tFim));
  const tempo = e => Math.max(0, Math.min(e.t1_ms || tFim, tFim) - Math.max(t0De(e), ini));
  const total = partes.reduce((s, e) => s + tempo(e), 0);

  // A janela virou (ou o número caiu) no meio do trecho: o Δ é reset, não custo.
  const valido = est.reset5 === marco.reset5 && core.num(est.pct5) !== null &&
                 core.num(marco.pct5) !== null && est.pct5 >= marco.pct5;
  const d5 = valido ? est.pct5 - marco.pct5 : null;
  const d7 = valido && core.num(est.pct7) !== null && core.num(marco.pct7) !== null
    ? est.pct7 - marco.pct7 : null;

  core.appendJsonl(core.F.trechos, {
    t: core.agora(), dur_s: Math.round((tFim - ini) / 1000), custo5: d5, custo7: d7,
    agentes: partes.length, tempo_agentes_s: Math.round(total / 1000), valido,
  });

  for (const e of partes) {
    const a = core.lerJson(arq(ACUM, e.id), { s5: 0, s7: 0, trechos: 0, incompleto: false });
    if (!valido) a.incompleto = true;
    else if (total > 0) {
      const fracao = tempo(e) / total;
      a.s5 += d5 * fracao;
      if (d7 !== null) a.s7 += d7 * fracao;
      a.trechos++;
    }
    if (!terminou.has(e.id)) { core.gravarJson(arq(ACUM, e.id), a); continue; }

    // Terminou: a soma das partes é o custo — se a cadeia cobriu a vida
    // inteira dele. Quem começou antes dela (cadeia perdida e recomeçada)
    // teria custo subcontado, o lado perigoso de errar: não vira amostra.
    const coberto = t0De(e) >= core.num(marco.cadeia_ms) - FOLGA_CADEIA_MS;
    if (!a.incompleto && coberto) {
      core.appendJsonl(core.F.agentes, {
        t: core.agora(), tipo: e.tipo || null, sessao: e.sessao || null,
        dur_s: Math.round((e.t1_ms - t0De(e)) / 1000),
        custo5: a.s5, custo7: a.s7,
        atribuicao: 'tempo', trechos: a.trechos,
      });
    }
    apagar(arq(ACUM, e.id));
    apagar(e.arquivo);
  }
}

// Desligada (D2): não mede nem lê — mas não pode deixar nada para trás.
function descartar(ev) {
  apagar(arq(VOO, ev.agent_id)); apagar(arq(FIM, ev.agent_id)); apagar(arq(ACUM, ev.agent_id));
  if (emVoo().length === 0 && !fechandoAgora()) descartarTudo();
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
    limparOrfaos(cfg.medidor.orfao_max_s);
    core.limparTmp();

    if (ev.hook_event_name === 'SubagentStart') {
      if (cfg.ligado) inicio(ev, cfg);
    } else if (ev.hook_event_name === 'SubagentStop') {
      if (cfg.ligado) fim(ev, cfg); else descartar(ev);
      // O vigia precisa de número vivo no meio do workflow, mas não pode
      // segurar o subagente esperando outra leitura: só aproveita a vez.
      if (cfg.ligado) sonda.garantirFrescoHook(cfg.sonda.vigia_s, { esperar: false });
      // Medir primeiro, vigiar depois: o aviso deve refletir o custo que
      // acabou de ser contabilizado, não o estado anterior a ele.
      const est = core.lerEstado();
      const msg = est && vigiar(cfg, est, core.agora());
      if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
    }
  }
} catch (_) { /* medir nunca pode atrapalhar o trabalho */ }
process.exit(0);
