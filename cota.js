#!/usr/bin/env node
'use strict';
/*
 * cota.js — o leitor. Garante leitura fresca da cota e responde.
 *
 *   cota                    situação das duas janelas
 *   cota cabe <n> [tipo]    a cota aguenta lançar n subagentes?
 *   cota sondar             lê a cota agora, ignorando o cache
 *   cota audit              em que elo a corrente quebrou
 *   cota on | off           liga/desliga a ferramenta inteira (D2)
 *   cota config [c] [v]     mostra ou muda a configuração (D8)
 *   cota limpar             poda histórico velho (D38)
 *   --json                  saída para script
 *   --codex                 o mesmo, para o Codex em vez do Claude Code
 */

// Tem que vir antes do require do core: é ele que escolhe a pasta de estado
// (~/.claude/cota ou ~/.codex/cota) pelo provedor.
if (process.argv.includes('--codex')) process.env.COTA_PROVIDER = 'codex';

const core = require('./lib/core');
const an = require('./lib/analise');
const sonda = require('./lib/sonda');
const produto = core.CODEX ? 'Codex' : 'Claude Code';
const nomeCmd = core.CODEX ? 'cota --codex' : 'cota';
// O que só existe no Codex: estimativa por perfil, política de economia e
// diagnóstico dos hooks. No Claude nada disso é carregado.
const cx = core.CODEX ? {
  estimativa: require('./lib/codex/estimativa'),
  economia: require('./lib/codex/economia'),
  hooks: require('./lib/codex/hooks'),
} : null;
let perfilSelecionado = { modelo: null, esforco: null, velocidade: null };

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', cy: '\x1b[36m',
            g: '\x1b[32m', y: '\x1b[33m', v: '\x1b[31m' };

const jsonCodex = core.CODEX && process.argv.includes('--json');
const mensagens = [];
const say = s => jsonCodex ? mensagens.push(s === undefined ? '' : String(s)) : console.log(s === undefined ? '' : s);
function falhar(codigo, mensagem) {
  throw Object.assign(new Error(mensagem), { code: codigo });
}

function barra(p, w) {
  w = w || 18;
  if (p === null) return C.d + '·'.repeat(w) + C.r;
  const n = Math.min(w, Math.max(0, Math.round((p / 100) * w)));
  const cor = p >= 90 ? C.v : p >= 70 ? C.y : C.g;
  return cor + '█'.repeat(n) + C.d + '░'.repeat(w - n) + C.r;
}

/*
 * D40 — antes de responder, garante leitura fresca: se a última passou de
 * `sonda.idade_s`, lê de novo (~1,5s, custo zero). É o que faz o
 * `cota cabe 10` responder com o número de agora.
 */
function ctx(sondar) {
  const cfg = core.lerConfig();
  if (sondar !== false && cfg.ligado) {
    try {
      const r = sonda.garantirFresco(cfg.sonda.idade_s);
      if (core.CODEX && (r.ok === false || /falhou/.test(r.motivo || ''))) {
        const ultimo = core.lerJson(core.F.sonda, {});
        falhar('SONDA_FALHOU', r.erro || ultimo.erro || r.motivo);
      }
    } catch (e) { if (core.CODEX) throw e; }
  }
  const est = core.lerEstado();
  if (core.CODEX && sondar !== false) {
    if (!cfg.ligado) falhar('DESATIVADA', 'A ferramenta cota está desativada.');
    if (!est) falhar('SEM_DADO', 'Sem leitura gravada da cota.');
  }
  const nowS = core.agora();
  const hist = core.lerHistorico();
  const janelas = est ? core.lerJanelas(est, cfg, nowS, hist) : null;
  const trechos = core.lerJsonl(core.F.trechos), agentes = core.lerJsonl(core.F.agentes);
  const base = core.CODEX
    ? cx.estimativa.baseCodex(trechos, agentes, { nowS, perfil: perfilSelecionado,
      meiaVidaDias: cfg.estimativa.meia_vida_dias, maxDias: cfg.estimativa.max_dias })
    : an.base(trechos, agentes);
  return { cfg, est, nowS, hist, janelas, base };
}

// Saída para script: tudo que o leitor sabe, sem cor e sem prosa.
function relatorioJson() {
  const { cfg, est, nowS, hist, janelas, base } = ctx();
  if (!est) return { ligado: cfg.ligado, estado: null, motivo: 'sem leitura gravada' };
  const r5 = an.ritmo(hist, 'pct5', 'reset5', est.reset5, est);
  const r7 = an.ritmo(hist, 'pct7', 'reset7', est.reset7, est);
  return {
    ligado: cfg.ligado,
    leitura_em: est.t,
    idade_s: nowS - est.t,
    cinco_horas: Object.assign({}, janelas.cinco,
      { ritmo_pct_hora: r5.pctPorHora, ritmo_medido_h: r5.deltaHoras }),
    sete_dias: Object.assign({}, janelas.sete,
      { ritmo_pct_hora: r7.pctPorHora, ritmo_medido_h: r7.deltaHoras }),
    semanal_por_modelo: est.modelos || [],
    ...(core.CODEX ? { provider: 'codex', plano: est.plano, limites: est.limites,
      creditos: est.creditos, resets_disponiveis: est.resets_disponiveis,
      estimativa: base.metadados, economia: cx.economia.avaliarEconomia(janelas, cfg),
      hooks: cx.hooks.diagnosticoHooks() } : {}),
    ritmo_por_agente: base.ritmo,
    duracao_por_agente: base.duracao,
  };
}

/* ------------------------------- status ------------------------------- */

function linhaJanela(rotulo, jan, hist, est, chavePct, chaveReset, semanal) {
  if (!jan.presente) { say('  ' + C.d + rotulo + ': sem dado' + C.r); return; }

  const pct = jan.pct;
  let quando = '';
  if (jan.resetsAt !== null) {
    // D11 — horizonte curto: relativo na frente. Longo: dia da semana na frente.
    quando = semanal && jan.segAteReset > 86400
      ? `reseta ${core.fmtDiaHora(jan.resetsAt)} ${C.d}(em ${core.fmtDuracao(jan.segAteReset)})${C.r}`
      : `reseta em ${core.fmtDuracao(jan.segAteReset)} ${C.d}(${core.fmtHora(jan.resetsAt)})${C.r}`;
  }
  say(`  ${C.b}${rotulo.padEnd(4)}${C.r}${barra(pct)}  ${pct.toFixed(1).padStart(5)}%   ${quando}`);

  const marca = { fresco: '', piso: C.y + ' (pelo menos — leitura velha)' + C.r,
                  expirado: C.y + ' JANELA VIROU — valor atual desconhecido' + C.r,
                  desconhecido: C.y + ' desconhecido (monotonia violada, D5)' + C.r }[jan.estado] || '';
  if (marca) say('      ' + marca);

  const rit = an.ritmo(hist, chavePct, chaveReset, est[chaveReset], est);
  if (rit.pctPorHora !== null) {
    // D28 — medição do passado recente, nunca projeção.
    say(`      ${C.d}ritmo${C.r} ${rit.pctPorHora.toFixed(1)}%/h ${C.d}nos últimos ` +
        `${core.fmtDuracao(rit.deltaHoras * 3600)} (${rit.amostras} amostras)${C.r}`);
  } else if (rit.motivo) {
    say(`      ${C.d}ritmo: ${rit.motivo}${C.r}`);
  }
}

function cmdStatus(json) {
  if (json) { const r = relatorioJson(); say(JSON.stringify(r, null, 2)); return r.estado === null ? 1 : 0; }
  const { cfg, est, nowS, hist, janelas, base } = ctx();

  if (!cfg.ligado) {
    say('');
    say(C.y + 'A ferramenta cota está desativada.' + C.r + C.d + '  (' + nomeCmd + ' on para religar)' + C.r);
    say('');
    return 2;
  }
  if (!est) { semDado(); return 1; }

  say('');
  say(C.cy + C.b + 'cota' + C.r + C.d + '  — limites de uso do ' + produto + C.r);
  say('');
  linhaJanela('5h', janelas.cinco, hist, est, 'pct5', 'reset5', false);
  say('');
  linhaJanela('7d', janelas.sete, hist, est, 'pct7', 'reset7', true);
  if (core.CODEX) {
    // Com folga, a política não tem o que dizer; só fala quando muda o plano.
    const eco = cx.economia.avaliarEconomia(janelas, cfg);
    if (!['normal', 'desligada'].includes(eco.nivel)) say('  ' + C.y + eco.mensagem + C.r);
    const saldo = Number(est.creditos && est.creditos.balance);
    const extras = [];
    if (Number.isFinite(saldo) && saldo > 0) extras.push('créditos ' + saldo.toFixed(2));
    if (est.resets_disponiveis) extras.push('resets guardados: ' + est.resets_disponiveis);
    if (extras.length) say(C.d + '      ' + extras.join(' · ') + ' (o cota só mostra, nunca usa)' + C.r);
    if (Object.keys(est.limites || {}).some(k => k !== 'codex'))
      say(C.d + '      há limites adicionais: veja --json. O cabe avalia só a cota geral.' + C.r);
  }
  // Sub-limite semanal por modelo: pode estourar antes do agregado. Só da
  // janela viva, senão é número morto.
  const modelos = (est.modelos || []).filter(m => m.reset === null || m.reset > nowS);
  if (modelos.length) {
    say(C.d + '      por modelo: ' + C.r +
        modelos.map(m => `${m.nome} ${m.pct === null ? '?' : m.pct.toFixed(0) + '%'}`).join(C.d + ' · ' + C.r));
  }
  say('');

  const diag = diagnostico(nowS, cfg, est);
  say((diag.caso === 'ok' ? C.d : C.y) + `  leitura de ${core.fmtDuracao(nowS - est.t)} atrás` +
      C.d + (est.plano ? '  ·  plano ' + est.plano : '') + C.r);

  // D48 — o ritmo de um subagente (quanto da janela de 5h por hora rodando) e
  // quanto tempo eles costumam rodar: é disso que sai o `cabe`.
  const linhaBase = k => {
    const m = an.medioPara(base, k === '__geral' ? null : k);
    if (!m || (k !== '__geral' && m.fonte === 'geral')) return null;
    return `${k === '__geral' ? 'geral' : k} ${m.r5.toFixed(1)}%/h · ${core.fmtDuracao(m.dur_s)}` +
           `${C.d}(${m.horas.toFixed(1)}h medidas, ${m.agentes} agente(s))${C.r}`;
  };
  const geral = linhaBase('__geral');
  if (core.CODEX) mostrarQualidade(base.metadados);
  if (geral) {
    const tipos = Object.keys(base.ritmo).filter(k => k !== '__geral').map(linhaBase).filter(Boolean);
    say(C.d + '  por subagente: ' + C.r + geral + (tipos.length ? C.d + '  ·  ' + C.r + tipos.join(C.d + ' · ' + C.r) : ''));
  } else {
    say(C.d + '  por subagente: ainda sem medida de ritmo e duração' + C.r);
  }
  // D36 — o número acima não vale se a sonda quebrou. Dizer isso aqui, com o
  // conserto junto, é a diferença entre consertar e achar que não funciona.
  if (diag.caso !== 'ok') {
    say('');
    say(C.y + '  ⚠ ' + diag.titulo + C.r);
    for (const c of diag.causas) say(C.d + '    · ' + c + C.r);
    receita();
  }
  say('');
  return 0;
}

/*
 * A corrente tem um elo só, o `get_usage` do claude. Se ele falha, o erro dele É
 * o diagnóstico (D36). Leitura ainda fresca não é problema, mesmo com a
 * última sonda quebrada: o número que importa está bom.
 */
function diagnostico(nowS, cfg, est) {
  const ok = { caso: 'ok', titulo: null, causas: [] };
  if (est && nowS - est.t <= cfg.idade_max_s) return ok;
  const s = core.lerJson(core.F.sonda, null);
  if (!s) {
    return { caso: 'sonda-nunca-rodou', titulo: 'A leitura da cota ainda não rodou.',
             causas: ['Ela roda sozinha na próxima consulta ao `cota`.'] };
  }
  if (s.ok) return ok;
  return {
    caso: 'sonda-falhou',
    titulo: 'A leitura da cota falhou.',
    causas: [String(s.erro || 'sem detalhe'), 'executável: ' + (s.exe || 'nenhum encontrado')],
  };
}

function receita() {
  if (core.CODEX) {
    say('');
    say(C.b + '  O que fazer:' + C.r);
    say('  1. Rode ' + C.cy + 'cota --codex sondar' + C.r + ' — tenta de novo e mostra o erro inteiro.');
    say('  2. Confira o login com ' + C.cy + 'codex login status' + C.r + ' (precisa ser conta ChatGPT).');
    say('  3. Se o Codex não foi achado, defina ' + C.cy + 'COTA_CODEX' + C.r + ' com o caminho do executável.');
    say('  4. Enquanto isso, trate a cota como SEM DADO. A referência é o /status do Codex.');
    return;
  }
  say('');
  say(C.b + '  O que fazer:' + C.r);
  say('  1. Rode ' + C.cy + 'cota sondar' + C.r + ' — tenta de novo e mostra o erro inteiro.');
  say('  2. Se o claude não foi achado, defina ' + C.cy + 'COTA_CLAUDE' + C.r +
      ' com o caminho do executável.');
  say('  3. Enquanto isso, trate a cota como SEM DADO. O /usage continua visível');
  say('     para você no painel "Account & usage" da extensão ou no terminal.');
}

function semDado() {
  const d = diagnostico(core.agora(), core.lerConfig(), core.lerEstado());
  say('');
  say(C.y + 'Sem leitura da cota.' + C.r + (d.titulo ? '  ' + d.titulo : ''));
  for (const c of d.causas) say(C.d + '  · ' + c + C.r);
  if (d.caso !== 'sonda-nunca-rodou') receita();
  say(C.d + '  Diagnóstico completo: ' + C.r + nomeCmd + ' audit');
  say('');
}

/* -------------------------------- cabe -------------------------------- */

function cmdCabe(n, tipo, json) {
  const { cfg, est, nowS, janelas, base } = ctx();
  if (!cfg.ligado) { say(C.y + 'ferramenta cota desativada' + C.r); return 2; }
  if (!est) { semDado(); return 1; }

  const res = an.admissao({ janelas, base, cfg, n, tipo, nowS });
  if (core.CODEX) {
    res.estimativa = base.metadados;
    res.hooks = cx.hooks.diagnosticoHooks();
    res.economia = cx.economia.avaliarEconomia(janelas, cfg);
    if (res.economia.iniciar_nova_onda === false) {
      res.veredito_calculo = res.veredito;
      res.quantos_cabem_calculo = res.quantosCabem;
      res.quantosCabem = 0;
      res.veredito = res.economia.nivel === 'sem_dado' ? 'sem_dado' : 'nao_cabe';
      res.motivo = 'Recomendação de economia: ' + res.economia.mensagem;
      res.onda = { tamanho: 0, restantes: n, porque: res.economia.mensagem };
    }
  }
  if (json) { say(JSON.stringify(res, null, 2)); return 0; }

  const rot = {
    vai:        C.g + 'VAI' + C.r,
    apertado:   C.y + 'APERTADO' + C.r,
    nao_cabe:   C.v + 'NÃO CABE' + C.r,
    sem_base:   C.y + 'SEM BASE' + C.r,
    sem_dado:   C.y + 'SEM DADO' + C.r,
  }[res.veredito];

  say('');
  say(`${C.b}cabem ${n} subagente(s)${tipo ? ' do tipo ' + tipo : ''}?${C.r}   →   ${rot}`);
  say('');
  say('  ' + res.motivo);
  if (core.CODEX) mostrarQualidade(base.metadados);
  if (res.janelaCritica) say(C.d + '  janela crítica: ' + C.r + res.janelaCritica);
  if (res.quantosCabem !== null) {
    say(C.d + '  cabem agora: ' + C.r + res.quantosCabem + ' subagente(s)');
  }
  // D16 — esperar é resposta.
  if (res.esperarAte) {
    say(C.cy + `  ou espere até ${core.fmtHora(res.esperarAte)} ` +
        `(${core.fmtDuracao(res.esperarAte - nowS)}) e a janela de 5h volta inteira` + C.r);
  }
  // D29 — a resposta acionável não é "cabe?", é "quantos AGORA?".
  if (res.onda && res.onda.tamanho === 0) {
    say('  Nenhuma nova onda recomendada agora.');
  } else if (res.onda && res.onda.restantes > 0) {
    say('');
    say(C.cy + C.b + `  dispare ${res.onda.tamanho} agora` + C.r +
        C.d + `, depois reavalie (faltam ${res.onda.restantes})` + C.r);
    if (res.onda.porque) say(C.d + '  ' + res.onda.porque + C.r);
  } else if (res.onda && res.onda.tamanho === n && n > 1) {
    say(C.d + `  pode disparar os ${n} de uma vez` + C.r);
  }
  // D48 — para agente longo, o reset corta o que cai nesta janela de 5h; o
  // resto vai para as seguintes, e é a semanal que paga a duração inteira.
  const j7 = res.janelas.sete;
  if (j7 && j7.custoTotal !== null && res.janelaCritica !== '7d') {
    say(C.d + `  semanal: ${j7.custoTotal.toFixed(1)}% de um orçamento de ${j7.orcamento.toFixed(1)}%` + C.r);
  }
  if (res.base) {
    const b = res.base;
    say(C.d + `  base: ${b.fonte}, ${b.ritmo5_h.toFixed(1)}%/h por subagente × ${core.fmtDuracao(b.duracao_s)} típicos` +
        ` (${b.horas.toFixed(1)}h de subagente medidas em ${b.trechos} trecho(s), ${b.agentes} duração(ões))` + C.r);
  }
  say('');
  return res.veredito === 'nao_cabe' ? 1 : 0;
}

/* ------------------------------- sondar ------------------------------- */

/*
 * D43 — "o claude mudou de pasta" dito em voz alta por uma semana. Não há o
 * que corrigir (o caminho é procurado a cada sonda), mas é a primeira
 * pergunta quando algo quebra logo depois de uma atualização da extensão.
 */
function trocaDoClaude(r, nowS) {
  if (!r || !r.exe_anterior || !r.exe_mudou_em || nowS - r.exe_mudou_em > 7 * 86400) return null;
  return `  (mudou de ${sonda.rotuloExe(r.exe_anterior)} há ` +
         `${core.fmtDuracao(nowS - r.exe_mudou_em)}, achado sozinho)`;
}

// Lê agora, ignorando a idade da leitura e a pausa depois de falha: é o
// "tenta de novo" deliberado.
function cmdSondar(json) {
  const r = sonda.sondar({});
  if (json) { say(JSON.stringify(r, null, 2)); return core.CODEX && !r.ok ? 1 : 0; }
  const nowS = core.agora();
  say('');
  if (r.ok) {
    say(C.g + '  sonda ok' + C.r + C.d + `  — ${r.ms}ms` +
        (r.versao ? `, Claude Code ${r.versao}` : '') + (r.plano ? `, plano ${r.plano}` : '') + C.r);
    say(C.d + '  ' + r.exe + C.r);
    const troca = trocaDoClaude(r, nowS);
    if (troca) say(C.cy + '  claude: ' + sonda.rotuloExe(r.exe) + troca + C.r);
    if (r.pulados) say(C.d + '  pulados (não executaram): ' + r.pulados.join(', ') + C.r);
    return cmdStatus(false);
  }
  say(C.y + '  a sonda falhou: ' + C.r + r.erro);
  say(C.d + '  executável: ' + (r.exe || 'nenhum encontrado') + C.r);
  receita();
  say('');
  return core.CODEX ? 1 : 0;
}

/* -------------------------------- audit -------------------------------- */

/*
 * D20 — o audit não depende do que ele audita: diz em que elo a corrente
 * quebrou, nunca só "sem dados". E sempre sonda de verdade — é o teste da
 * corrente inteira, não pode aproveitar leitura de cache.
 */
function cmdAudit(json) {
  const r = sonda.sondar({});
  const { cfg, est, nowS, hist, base, janelas } = ctx(false);
  const achados = [];
  const add = (ok, titulo, detalhe) => achados.push({ ok, titulo, detalhe });

  add(!!r.exe, 'executável do ' + (core.CODEX ? 'Codex' : 'claude') + ' encontrado', r.exe
    ? sonda.rotuloExe(r.exe) + (trocaDoClaude(r, nowS) || '')
    : 'nem no PATH, nem em ~/.local/bin, nem na extensão do VS Code — defina ' + (core.CODEX ? 'COTA_CODEX' : 'COTA_CLAUDE'));
  add(r.ok, 'a leitura da cota (' + (core.CODEX ? 'account/rateLimits/read' : 'get_usage') + ') respondeu', r.ok
    ? `${r.ms}ms` + (r.plano ? `, plano ${r.plano}` : '') + `, 5h=${r.pct5}% 7d=${r.pct7}%`
    : r.erro);

  add(!!est, 'existe leitura gravada', est ? `de ${core.fmtDuracao(nowS - est.t)} atrás` : 'nenhuma');
  if (est) {
    const idade = nowS - est.t;
    add(idade <= cfg.idade_max_s, 'leitura fresca',
        `${core.fmtDuracao(idade)} atrás (limite ${core.fmtDuracao(cfg.idade_max_s)})`);

    const faixa = v => v === null || (v >= 0 && v <= 100);
    add(faixa(est.pct5) && faixa(est.pct7), 'percentuais dentro de 0–100',
        `5h=${est.pct5} 7d=${est.pct7}`);

    // Suspeita, não veredito: pega relógio local torto ou dado corrompido.
    const dentro = (reset, maxS) => reset === null || (reset - nowS <= maxS + 60);
    add(dentro(est.reset5, 5 * 3600), 'reset de 5h no máximo 5h à frente',
        est.reset5 ? core.fmtDuracao(est.reset5 - nowS) : '— (janela não iniciada)');
    add(dentro(est.reset7, 7 * 86400), 'reset semanal no máximo 7d à frente',
        est.reset7 ? core.fmtDuracao(est.reset7 - nowS) : '—');

    add(janelas.cinco.estado !== 'expirado', 'janela de 5h ainda válida', janelas.cinco.estado);
    add(core.monotoniaOk(hist, 'pct5', 'reset5', est.reset5),
        'monotonia da janela de 5h (D5)', 'percentual nunca caiu dentro da janela');
  }

  // Informativo: instalação nova não tem amostra, e isso não é falha.
  const g = an.medioPara(base, null);
  add(true, 'medida de ritmo e duração por subagente', g
    ? `${g.r5.toFixed(1)}%/h, ${core.fmtDuracao(g.dur_s)} típicos — ${g.horas.toFixed(1)}h em ${g.trechos} trecho(s)`
    : 'nenhuma ainda — a primeira onda do `cabe` é de calibração');

  const hooks = core.CODEX ? cx.hooks.diagnosticoHooks() : null;
  if (json) { say(JSON.stringify({ achados, sonda: r, ...(core.CODEX ? { hooks, estimativa: base.metadados } : {}) }, null, 2)); return core.CODEX && achados.some(a => !a.ok) ? 1 : 0; }

  say('');
  say(C.cy + C.b + 'cota audit' + C.r + C.d + '  — em que elo a corrente quebrou' + C.r);
  say('');
  let falhas = 0;
  for (const a of achados) {
    if (!a.ok) falhas++;
    say(`  ${a.ok ? C.g + ' ok ' : C.v + 'FALHA'}${C.r}  ${a.titulo}` +
        (a.detalhe ? C.d + '  — ' + a.detalhe + C.r : ''));
  }
  if (!r.ok) receita();
  if (hooks) {
    say('  Hooks: ' + (hooks.instalado ? 'instalados' : 'instalação incompleta') + ' · coleta: ' + hooks.coleta);
    say('  ' + hooks.aviso);
    if (hooks.ultimo_erro) say('  Última falha do hook: ' + hooks.ultimo_erro.codigo);
  }
  say('');
  say(falhas === 0 ? C.g + '  nenhuma falha' + C.r : C.v + `  ${falhas} falha(s)` + C.r);
  say('');
  return falhas === 0 ? 0 : 1;
}

/* ------------------------------ liga/config ------------------------------ */

function cmdLiga(ligado) {
  const cfg = core.lerConfig();
  cfg.ligado = ligado;
  core.gravarConfig(cfg);
  say(ligado ? C.g + 'cota ligada' + C.r : C.y + 'cota desligada' + C.r +
      C.d + ' (nada sonda nem avisa até religar)' + C.r);
  return 0;
}

function cmdConfig(caminho, valor) {
  const cfg = core.lerConfig();
  if (!caminho) { say(JSON.stringify(cfg, null, 2)); return 0; }

  const partes = caminho.split('.');
  let o = cfg;
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof o[partes[i]] !== 'object' || o[partes[i]] === null) {
      say(C.v + 'chave inexistente: ' + caminho + C.r); return 1;
    }
    o = o[partes[i]];
  }
  const ultima = partes[partes.length - 1];
  if (!(ultima in o)) { say(C.v + 'chave inexistente: ' + caminho + C.r); return 1; }
  if (valor === undefined) { say(String(o[ultima])); return 0; }

  /*
   * D37 — valida contra o TIPO do padrão, e recusa o que não converte.
   *
   * Sem isto, `cota config aviso.limiar_5h abc` gravava a string "abc". Nada
   * explodia: a comparação `pct < "abc"` dá false para sempre, e o aviso
   * simplesmente parava de disparar — sem erro, sem sintoma.
   */
  const padrao = partes.reduce((o2, k) => (o2 == null ? undefined : o2[k]), core.CONFIG_PADRAO);
  const tipo = typeof padrao;
  let convertido;
  if (tipo === 'boolean') {
    if (!/^(true|false|1|0|sim|nao|não)$/i.test(valor)) {
      say(C.v + `${caminho} espera true ou false, recebeu "${valor}"` + C.r);
      return 1;
    }
    convertido = /^(true|1|sim)$/i.test(valor);
  } else if (tipo === 'number') {
    convertido = Number(valor);
    if (!Number.isFinite(convertido)) {
      say(C.v + `${caminho} espera um número, recebeu "${valor}"` + C.r);
      return 1;
    }
    // Limiar fora de 0–100 desliga o aviso sem dizer que desligou.
    if (/limiar|_acima_de$/.test(ultima) && (convertido < 0 || convertido > 100)) {
      say(C.v + `${caminho} é um percentual: use 0 a 100 (recebeu ${convertido})` + C.r);
      return 1;
    }
    if (/_min$|_s$|orfao|dias|linhas/.test(ultima) && convertido < 0) {
      say(C.v + `${caminho} não pode ser negativo` + C.r);
      return 1;
    }
    if (partes[0] === 'estimativa' && convertido <= 0) {
      say(C.v + `${caminho} deve ser maior que zero` + C.r);
      return 1;
    }
    if (ultima === 'margem' && (convertido <= 0 || convertido > 1)) {
      say(C.v + `margem é uma fração: use algo entre 0 e 1 (recebeu ${convertido})` + C.r);
      return 1;
    }
  } else {
    convertido = valor;
  }

  o[ultima] = convertido;
  if (core.CODEX && partes[0] === 'economia') {
    const e = cfg.economia;
    if (![e.reduzir_acima_de, e.concluir_acima_de].every(v => Number.isFinite(v) && v >= 0 && v <= 100) ||
        e.concluir_acima_de < e.reduzir_acima_de) {
      falhar('CONFIG_INVALIDA', 'Economia: use 0–100 e concluir_acima_de >= reduzir_acima_de.');
    }
  }
  core.gravarConfig(cfg);
  say(caminho + ' = ' + o[ultima]);
  return 0;
}

/* -------------------------------- limpar ------------------------------- */

function cmdLimpar(dias, maxLinhas) {
  const cfg = core.lerConfig();
  /*
   * Inteiro não negativo, ou nada (vale a config). Um negativo punha o corte
   * no futuro e `cota limpar -1` apagava o histórico e todas as amostras de
   * custo; e "0" virava 14 calado, porque 0 é falso.
   */
  const inteiro = (v, padrao, rotulo) => {
    if (v === undefined) return padrao;
    if (!/^\d+$/.test(String(v))) {
      say(C.v + `${rotulo} tem que ser um número inteiro de 0 para cima (recebeu "${v}")` + C.r);
      return null;
    }
    return Number(v);
  };
  const d = inteiro(dias, cfg.poda.dias, 'dias');
  const m = inteiro(maxLinhas, cfg.poda.max_linhas, 'linhas');
  if (d === null || m === null) {
    say('uso: cota limpar [dias] [linhas]   ex.: cota limpar 7');
    return 1;
  }

  core.limparTmp(0);
  const r = core.podar(d, m, { folgaS: 0 });
  const legado = core.removerLegado();
  say('');
  say(`  histórico e amostras: ${r.truncados} arquivo(s) podado(s)` +
      C.d + `  (mais velho que ${d} dias, ou além de ${m} linhas)` + C.r);
  if (legado.length) say(`  restos de versões anteriores removidos: ${legado.join(', ')}`);
  say('');
  return 0;
}

/* -------------------------------- main -------------------------------- */

/*
 * D27 — a prova de idiota, de propósito.
 *
 * Quem chama isto é um agente que nunca viu a ferramenta, num shell que pode
 * ser qualquer um. Errar o comando e receber "code 1" é o pior desfecho: o
 * agente conclui que a ferramenta está quebrada e segue sem checar a cota.
 * Então: sinônimo é aceito, número solto vira `cabe`, comando desconhecido
 * mostra a situação, e nada sai com erro por digitação.
 */

// tira acento e caixa, para 'diagnóstico' == 'diagnostico' == 'DIAGNOSTICO'
const normalizar = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/^-+/, '');

const SINONIMOS = {
  status: ['status', 'st', 'ver', 'agora', 'situacao', 'estado', 'cota', 'quanto', 'usage', 'checkpoint'],
  cabe:   ['cabe', 'aguenta', 'posso', 'suporta', 'check', 'cabem'],
  sondar: ['sondar', 'sonda', 'atualizar', 'renovar', 'refresh'],
  audit:  ['audit', 'auditoria', 'auditar', 'debug', 'diagnostico', 'conferir', 'doctor'],
  on:     ['on', 'ligar', 'liga', 'ativar', 'ativa'],
  off:    ['off', 'desligar', 'desliga', 'desativar', 'desativa'],
  config: ['config', 'configuracao', 'configurar', 'set'],
  limpar: ['limpar', 'limpeza', 'podar', 'poda', 'clean'],
  ajuda:  ['ajuda', 'help', 'h', '?', 'comandos'],
};

function resolver(bruto) {
  const n = normalizar(bruto);
  if (!n) return 'status';
  for (const [canonico, lista] of Object.entries(SINONIMOS)) {
    if (lista.includes(n)) return canonico;
  }
  // "cota 10" quer dizer "cabe 10?" — é o que qualquer um digitaria.
  if (/^\d+$/.test(n)) return 'cabe-numero-solto';
  return null;
}

function ajuda() {
  const c = s => ('  ' + nomeCmd + (s ? ' ' + s : '')).padEnd(core.CODEX ? 34 : 26);
  say('');
  say('  cota — limites de uso do ' + produto);
  say('');
  say(c('') + 'situação agora');
  say(c('cabe 10') + 'a cota aguenta 10 subagentes?');
  say(c('cabe 10 Explore') + 'idem, usando o custo médio desse tipo');
  say(c('sondar') + 'lê a cota agora, ignorando o cache');
  say(c('audit') + 'diagnóstico: onde a corrente quebrou');
  say(c('off') + 'desliga a ferramenta (on religa)');
  say(c('config') + 'mostra a configuração');
  say(c('limpar') + 'poda histórico velho');
  if (core.CODEX) say('  --modelo X --esforco Y --velocidade Z  seleciona o perfil da estimativa (omitido = desconhecido)');
  else say(c('--codex') + 'o mesmo, para o Codex');
  say('');
  say('  Aceita sinônimo (ver, aguenta, debug...) e número solto:');
  say(`  "${nomeCmd} 10" é o mesmo que "${nomeCmd} cabe 10".`);
  say('');
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const args = argv.filter(a => a !== '--json' && a !== '--codex');

// Codex: de que perfil e com que confiança é a base de custo. Em cinza: é
// contexto do número, não o número.
function mostrarQualidade(m) {
  if (!m) return;
  const d = s => say(C.d + '  ' + s + C.r);
  d('perfil: ' + Object.entries(m.perfil).map(([k, v]) => k + '=' + (v || 'desconhecido')).join(' · '));
  d('confiança da base: ' + m.confianca.nivel + ' (heurística) · ' + m.amostras.trechos +
    ' trecho(s), ' + m.amostras.agentes + ' agente(s), ' + m.amostras.horas.toFixed(2) + 'h observadas');
  if (m.idade.maisRecenteS !== null) d('amostra mais recente: ' + core.fmtDuracao(m.idade.maisRecenteS) + ' atrás');
  if (m.variabilidade.ritmo5CV !== null) d('variação relativa do ritmo: ' + (m.variabilidade.ritmo5CV * 100).toFixed(0) + '%');
  d(m.aviso);
  if (m.perfisDisponiveis?.length > 1) d('outros perfis registrados: veja --json e selecione com --modelo/--esforco/--velocidade.');
}

function extrairPerfil() {
  if (!core.CODEX) return;
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--(modelo|esforco|velocidade)(?:=(.*))?$/);
    if (!m) continue;
    const separado = m[2] === undefined;
    const valor = separado ? args[i + 1] : m[2];
    if (!valor || !valor.trim() || valor.startsWith('--')) falhar('ARGUMENTO_INVALIDO', 'Falta valor para --' + m[1]);
    perfilSelecionado[m[1]] = valor.trim();
    args.splice(i, separado ? 2 : 1); i--;
  }
}

let code = 0;
try {
  extrairPerfil();
  const cmd = resolver(args[0]);

  if (cmd === 'ajuda') { ajuda(); code = 0; }
  else if (cmd === 'cabe-numero-solto') { code = cmdCabe(Number(args[0]), args[1], json); }
  else if (cmd === 'cabe') {
    // Sem número: em vez de assumir 1 calado, diz o que faltou e mostra a
    // situação, para a resposta nunca ser inútil.
    const n = Number(args[1]);
    if (!Number.isFinite(n) || n < 1) {
      if (core.CODEX) falhar('ARGUMENTO_INVALIDO', 'Informe o número de agentes: cota cabe 10.');
      say('(faltou o número de agentes — ex.: cota cabe 10. Situação atual:)');
      say('');
      code = cmdStatus(json);
    } else {
      code = cmdCabe(n, args[2], json);
    }
  }
  else if (cmd === 'status') code = cmdStatus(json);
  else if (cmd === 'sondar') code = cmdSondar(json);
  else if (cmd === 'audit')  code = cmdAudit(json);
  else if (cmd === 'on')     code = cmdLiga(true);
  else if (cmd === 'off')    code = cmdLiga(false);
  else if (cmd === 'config') code = cmdConfig(args[1], args[2]);
  else if (cmd === 'limpar') code = cmdLimpar(args[1], args[2]);
  else {
    if (core.CODEX) falhar('COMANDO_INVALIDO', 'Comando desconhecido: ' + args[0]);
    // Desconhecido: mostra a situação assim mesmo. Sair com erro faria o
    // agente desistir da ferramenta por causa de uma digitação.
    say('(não conheço "' + args[0] + '". Situação atual:)');
    say('');
    code = cmdStatus(json);
    ajuda();
  }
} catch (e) {
  if (core.CODEX) {
    const codigo = String(e.code || 'ERRO_INTERNO');
    const mensagem = String(e.message || e);
    const acao = /^(EPERM|EACCES)$/.test(codigo)
      ? 'Verifique a permissão de escrita no cache e as restrições do sandbox. COTA_CODEX_DIR permite escolher outra pasta de cache.'
      : 'Rode cota audit para o diagnóstico. Trate como SEM DADO por enquanto.';
    if (json) { mensagens.length = 0; say(JSON.stringify({ ok: false, provider: 'codex', erro: { codigo, mensagem, acao } })); }
    else { say('cota: ' + codigo + ': ' + mensagem); say(acao); }
    code = codigo === 'DESATIVADA' ? 2 : 1;
  } else {
  // Nunca estoura na cara de quem chamou: um traceback faria o agente
  // concluir "ferramenta quebrada" e seguir sem checar a cota.
  say('cota: falhou aqui dentro — ' + String((e && e.message) || e));
  say('Rode `cota audit` para o diagnóstico. Trate como SEM DADO por enquanto.');
  code = 0;
  }
}
if (jsonCodex) {
  const texto = mensagens.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  let resultado;
  try { resultado = JSON.parse(texto); }
  catch (_) { resultado = code ? { ok: false, provider: 'codex', erro: { codigo: 'COMANDO_FALHOU', mensagem: texto.trim() } } : { ok: true, provider: 'codex', resultado: texto.trim() }; }
  // Preserve the successful command payloads; all failures expose a stable code.
  if (code && resultado && typeof resultado === 'object' && !Array.isArray(resultado)) {
    resultado.ok = false;
    resultado.provider = 'codex';
    if (!resultado.erro || typeof resultado.erro !== 'object') resultado.erro = {
      codigo: resultado.achados ? 'AUDIT_FALHOU' : 'SONDA_FALHOU',
      mensagem: resultado.erro || 'O diagnóstico encontrou falhas.',
    };
  }
  console.log(JSON.stringify(resultado, null, 2));
}
process.exit(code);
