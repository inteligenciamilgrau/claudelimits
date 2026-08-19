#!/usr/bin/env node
'use strict';
/*
 * sensor.js — status line. A ÚNICA coisa do sistema que enxerga rate_limits.
 *
 * Contrato: https://code.claude.com/docs/en/statusline
 * Recebe o JSON da sessão no stdin, imprime uma linha, e grava o que viu.
 *
 * Regras: só observa e grava (não decide nada), é rápido, e nunca derruba a
 * status line — qualquer erro vira uma linha discreta. Grava mesmo com a
 * ferramenta desligada, para que religar volte a funcionar na hora (D2).
 */

const fs = require('fs');
const core = require('./lib/core');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m',
            green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };

function lerStdin() {
  const partes = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e) { if (e.code === 'EAGAIN') continue; if (e.code === 'EOF') break; throw e; }
    if (n === 0) break;
    partes.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(partes).toString('utf8');
}

const cor = p => (p === null ? C.dim : p >= 90 ? C.red : p >= 70 ? C.yellow : C.green);

/*
 * Batimento: prova de que o Claude Code chamou o sensor, gravada SEMPRE —
 * inclusive quando o payload não traz rate_limits.
 *
 * Sem isto, "o sensor nunca foi chamado" e "foi chamado mas o payload veio sem
 * rate_limits" são indistinguíveis do lado de fora, e são problemas diferentes:
 * o primeiro é settings/reinício, o segundo é conta ou sessão sem chamada de
 * API ainda. O audit precisa saber qual dos dois (D20).
 */
function batimento(d, nowS, tinha) {
  core.gravarJson(core.F.batimento, {
    t: nowS,
    tinha_rate_limits: tinha,
    sessao: (d && d.session_id) || null,
    modelo: (d && d.model && d.model.id) || null,
    versao: (d && d.version) || null,
  });
}

function gravar(d, nowS) {
  const rl = d.rate_limits;
  // Ausente: assinatura sem rate_limits, ou antes da 1a resposta da API.
  // Não sobrescreve um estado bom que já exista.
  const tinha = !!(rl && (rl.five_hour || rl.seven_day));
  batimento(d, nowS, tinha);
  if (!tinha) return;

  const cw = d.context_window || {};
  const snap = {
    t: nowS,
    sessao: d.session_id || null,
    pct5:   core.num(rl.five_hour && rl.five_hour.used_percentage),
    reset5: core.num(rl.five_hour && rl.five_hour.resets_at),
    pct7:   core.num(rl.seven_day && rl.seven_day.used_percentage),
    reset7: core.num(rl.seven_day && rl.seven_day.resets_at),
    // sinal secundário, nunca base de decisão (D13)
    tokens: core.num(cw.total_input_tokens),
    ctx_pct: core.num(cw.used_percentage),
    modelo: (d.model && d.model.id) || null,
    versao: d.version || null,
  };

  /*
   * D24 — observação não é confirmação.
   *
   * O `rate_limits` só se renova quando ESTA sessão recebe resposta da API.
   * Uma sessão aberta e ociosa continua rodando o sensor a cada refreshInterval
   * e repetindo o último valor que viu — enquanto outra sessão queima cota sem
   * ela saber. Aí `t` fica novo e o número fica velho: o pior dos mundos, dado
   * podre com carimbo fresco.
   *
   * `tokens` (total_input_tokens) muda a cada resposta da API. Se ele não
   * mudou, esta leitura é repetição, e a idade que vale para decidir é a do
   * último valor confirmado.
   */
  const anterior = core.lerEstado();
  const mesmaSessao = anterior && anterior.sessao === snap.sessao;
  // Dois sinais de informação nova, não um:
  //  - tokens mudaram  → houve resposta de API nesta sessão
  //  - percentual mudou → é dado novo por definição, venha de onde vier
  // O segundo cobre renovação SEM turno de modelo (ex.: um /usage), que o
  // primeiro sozinho classificaria como repetição.
  const houveRespostaNova = !mesmaSessao ||
    anterior.tokens !== snap.tokens ||
    anterior.pct5 !== snap.pct5 ||
    anterior.pct7 !== snap.pct7;
  snap.t_confirmado = houveRespostaNova ? nowS
    : (core.num(anterior.t_confirmado) !== null ? anterior.t_confirmado : anterior.t);

  core.gravarEstado(snap);   // D6: só se for mais novo

  // D7: histórico por sessão. Só grava quando algum percentual muda, para não
  // inflar o arquivo a cada refresh.
  const hist = core.lerJsonl(require('path').join(core.F.sessoes,
    String(snap.sessao || 'sem-sessao').replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl'));
  const ult = hist[hist.length - 1];
  const igual = ult && ult.pct5 === snap.pct5 && ult.pct7 === snap.pct7 &&
                ult.reset5 === snap.reset5 && ult.reset7 === snap.reset7;
  if (!igual) core.appendSessao(snap.sessao, snap);
}

/*
 * `velho` marca o percentual com "≥" quando a leitura não é confirmada há
 * muito tempo.
 *
 * Sem isso a status line engana: o countdown (↻) é calculado do relógio e
 * desce a cada refresh mesmo com o número parado há uma hora, dando aparência
 * de vida a dado morto. O "≥" diz o que o valor realmente vale nesse caso —
 * um piso, não uma medida (D4/D24).
 */
function janela(rotulo, w, nowS, semanal, velho) {
  if (!w || core.num(w.used_percentage) === null) return null;
  const p = w.used_percentage;
  let txt = cor(p) + rotulo + ' ' + (velho ? '≥' : '') + p.toFixed(0) + '%' + C.reset;
  if (core.num(w.resets_at) !== null) {
    // D11: horizonte curto mostra o relativo; longo mostra dia+hora.
    const s = w.resets_at - nowS;
    txt += C.dim + ' ↻' + (semanal && s > 86400
      ? core.fmtDiaHora(w.resets_at) : core.fmtDuracao(s)) + C.reset;
  }
  return txt;
}

function main() {
  const bruto = lerStdin();
  let d;
  try { d = JSON.parse(bruto); }
  catch (_) { process.stdout.write(C.dim + 'cota: stdin inválido' + C.reset); return; }

  const nowS = core.agora();
  try { gravar(d, nowS); } catch (_) { /* nunca derruba a status line */ }

  // Idade da confirmacao, para marcar o percentual como piso quando velho.
  let velho = false;
  try {
    const est = core.lerEstado();
    if (est) velho = (nowS - core.tConfirmado(est)) > core.lerConfig().idade_max_s;
  } catch (_) {}

  let cfg;
  try { cfg = core.lerConfig(); } catch (_) { cfg = core.CONFIG_PADRAO; }

  const partes = [];
  const modelo = d.model && d.model.display_name;
  if (modelo) partes.push(C.cyan + '[' + modelo + ']' + C.reset);

  const ctx = core.num(d.context_window && d.context_window.used_percentage);
  if (ctx !== null) partes.push(cor(ctx) + 'ctx ' + ctx.toFixed(0) + '%' + C.reset);

  // D2: desligada, a status line não mostra cota. Mas continua gravando acima.
  if (cfg.ligado) {
    const rl = d.rate_limits || {};
    const w5 = janela('5h', rl.five_hour, nowS, false, velho);
    const w7 = janela('7d', rl.seven_day, nowS, true, velho);
    if (w5) partes.push(w5);
    if (w7) partes.push(w7);
    if (!w5 && !w7) partes.push(C.dim + 'cota: aguardando 1ª resposta da API' + C.reset);
    if (cfg.modo_desconfiado) partes.push(C.yellow + '⚠ desconfiado' + C.reset);
  } else {
    partes.push(C.dim + 'cota off' + C.reset);
  }

  process.stdout.write(partes.join(C.dim + ' │ ' + C.reset));
}

try { main(); }
catch (e) { process.stdout.write('\x1b[2mcota: ' + String(e && e.message) + '\x1b[0m'); }
