#!/usr/bin/env node
'use strict';
/*
 * cota.js — o leitor. Interpreta o mural e responde as perguntas.
 *
 *   cota                    situação das duas janelas
 *   cota cabe <n> [tipo]    a cota aguenta lançar n subagentes?
 *   cota audit              diagnóstico das três camadas
 *   cota audit ok           registra que bateu com o /usage
 *   cota audit <5h> [7d]    registra os valores que o /usage mostrou
 *   cota on | off           liga/desliga a ferramenta inteira (D2)
 *   cota config [c] [v]     mostra ou muda a configuração (D8)
 *   --json                  saída para script
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./lib/core');
const an = require('./lib/analise');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', cy: '\x1b[36m',
            g: '\x1b[32m', y: '\x1b[33m', v: '\x1b[31m' };

const say = s => console.log(s === undefined ? '' : s);

function barra(p, w) {
  w = w || 18;
  if (p === null) return C.d + '·'.repeat(w) + C.r;
  const n = Math.min(w, Math.max(0, Math.round((p / 100) * w)));
  const cor = p >= 90 ? C.v : p >= 70 ? C.y : C.g;
  return cor + '█'.repeat(n) + C.d + '░'.repeat(w - n) + C.r;
}

function ctx() {
  const cfg = core.lerConfig();
  const est = core.lerEstado();
  const nowS = core.agora();
  const hist = core.lerHistorico();
  const janelas = est ? core.lerJanelas(est, cfg, nowS, hist) : null;
  const custos = an.custoPorTipo(core.lerJsonl(core.F.agentes));
  return { cfg, est, nowS, hist, janelas, custos };
}

// Saída para script: tudo que o leitor sabe, sem cor e sem prosa.
function relatorioJson() {
  const { cfg, est, nowS, hist, janelas, custos } = ctx();
  if (!est) return { ligado: cfg.ligado, estado: null, motivo: 'sem leitura gravada' };
  const r5 = an.ritmo(hist, 'pct5', 'reset5', est.reset5);
  const r7 = an.ritmo(hist, 'pct7', 'reset7', est.reset7);
  return {
    ligado: cfg.ligado,
    modo_desconfiado: cfg.modo_desconfiado,
    leitura_em: est.t,
    idade_s: nowS - est.t,
    sessoes_no_mural: new Set(hist.map(h => h.sessao).filter(Boolean)).size,
    cinco_horas: Object.assign({}, janelas.cinco,
      { ritmo_pct_hora: r5.pctPorHora, ritmo_medido_h: r5.deltaHoras }),
    sete_dias: Object.assign({}, janelas.sete,
      { ritmo_pct_hora: r7.pctPorHora, ritmo_medido_h: r7.deltaHoras }),
    custo_por_agente: custos,
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

  const rit = an.ritmo(hist, chavePct, chaveReset, est[chaveReset]);
  if (rit.pctPorHora !== null) {
    // Sem projeção: o uso deste usuário não é estacionário (workflow violento,
    // depois dois dias parado, depois perguntas lentas). Extrapolar qualquer um
    // desses regimes sobre o relógio descreve os outros dois errado. O ritmo
    // fica como MEDIÇÃO do passado recente — que é o que ele de fato é.
    say(`      ${C.d}ritmo${C.r} ${rit.pctPorHora.toFixed(1)}%/h ${C.d}nos últimos ` +
        `${core.fmtDuracao(rit.deltaHoras * 3600)} (${rit.amostras} amostras)${C.r}`);
  } else if (rit.motivo) {
    say(`      ${C.d}ritmo: ${rit.motivo}${C.r}`);
  }
}

function cmdStatus(json) {
  const { cfg, est, nowS, hist, janelas, custos } = ctx();

  if (json) { say(JSON.stringify(relatorioJson(), null, 2)); return est ? 0 : 1; }

  if (!cfg.ligado) {
    say('');
    say(C.y + 'A ferramenta cota está desativada.' + C.r + C.d + '  (cota on para religar)' + C.r);
    say('');
    return 2;
  }
  if (!est) { semDado(); return 1; }

  say('');
  say(C.cy + C.b + 'cota' + C.r + C.d + '  — limites de uso do Claude Code' + C.r);
  say('');
  linhaJanela('5h', janelas.cinco, hist, est, 'pct5', 'reset5', false);
  say('');
  linhaJanela('7d', janelas.sete, hist, est, 'pct7', 'reset7', true);
  say('');

  const sessoes = new Set(hist.map(h => h.sessao).filter(Boolean));
  const idade = nowS - core.tConfirmado(est);
  const diag = diagnosticoMural(nowS);
  say((diag.caso === 'ok' ? C.d : C.y) +
      `  leitura de ${core.fmtDuracao(idade)} atrás` +
      C.d + `  ·  ${sessoes.size} sessão(ões) no mural` + C.r);

  const tipos = Object.entries(custos).filter(([k]) => k !== '__geral');
  if (custos.__geral) {
    const t = tipos.map(([k, v]) => `${k} ${v.media5.toFixed(2)}%${C.d}(n=${v.n})${C.r}`).join(' · ');
    say(C.d + '  custo por subagente: ' + C.r +
        `geral ${custos.__geral.media5.toFixed(2)}%${C.d}(n=${custos.__geral.n})${C.r}` +
        (t ? C.d + '  ·  ' + C.r + t : ''));
  } else {
    say(C.d + '  custo por subagente: ainda sem amostra limpa' + C.r);
  }
  if (cfg.modo_desconfiado) {
    say(C.y + '  ⚠ modo desconfiado: a última aferição divergiu do /usage (D22)' + C.r);
  }
  // O número acima não vale nada se o mural congelou. Dizer isso aqui, com o
  // conserto junto, é a diferença entre a pessoa consertar e a pessoa achar
  // que a ferramenta não funciona.
  if (diag.caso !== 'ok') {
    say('');
    say(C.y + '  ⚠ ' + diag.titulo + C.r);
    for (const c of diag.causas) say(C.d + '    · ' + c + C.r);
    receita(diag.conserto);
  }
  say('');
  return 0;
}

/*
 * Diagnóstico do mural, com o conserto junto.
 *
 * Três situações diferentes levam a "a ferramenta não funciona", e o conserto
 * de cada uma é outro. Documentar não resolve — quem instala não lê, e reclama
 * que não funciona. Então a mensagem que aparece na hora do problema é a
 * documentação.
 *
 *   sem batimento          → o sensor NUNCA rodou: sessão nova, ou a extensão
 *                            do VS Code (que não executa status line)
 *   batimento velho        → a janela de terminal que alimentava fechou
 *   batimento novo, valor  → terminal aberto mas ocioso: ele repete o mesmo
 *   confirmado velho         número, precisa de um loop
 */
function diagnosticoMural(nowS) {
  const bat = core.lerJson(core.F.batimento, null);
  const est = core.lerEstado();
  const cfg = core.lerConfig();

  if (!bat) {
    return {
      caso: 'sensor-nunca-rodou',
      titulo: 'O sensor nunca foi executado.',
      causas: [
        'Você está na EXTENSÃO DO VS CODE ou na web. Elas sobem o `claude` sem TUI e não executam status line — esta é a causa mais comum.',
        'Ou o `settings.json` foi editado agora e ainda não houve sessão nova (hooks e status line são lidos na inicialização).',
        'Ou o comando da status line falha ao executar (no Windows ele falha calado).',
      ],
      conserto: 'terminal-com-loop',
    };
  }
  const idadeBat = nowS - bat.t;
  if (idadeBat > 300) {
    return {
      caso: 'sensor-parou',
      titulo: `O sensor rodou pela última vez há ${core.fmtDuracao(idadeBat)}.`,
      causas: ['A janela de terminal que alimentava o mural foi fechada.'],
      conserto: 'terminal-com-loop',
    };
  }
  if (est) {
    const idadeConf = nowS - core.tConfirmado(est);
    if (idadeConf > cfg.idade_max_s) {
      return {
        caso: 'terminal-ocioso',
        titulo: `O sensor está rodando, mas o valor não muda há ${core.fmtDuracao(idadeConf)}.`,
        causas: [
          'A janela de terminal está aberta e ociosa. Ociosa, ela regrava o mesmo número: o `rate_limits` de uma sessão só se renova quando ELA recebe resposta da API.',
        ],
        conserto: 'loop',
      };
    }
  }
  return { caso: 'ok', titulo: null, causas: [], conserto: null };
}

function receita(qual) {
  if (!qual) return;
  say('');
  if (qual === 'terminal-com-loop') {
    say(C.b + '  O que fazer:' + C.r);
    say('  1. Abra uma janela de TERMINAL com o Claude Code (não a extensão).');
    say('  2. Nela, rode:');
  } else {
    say(C.b + '  O que fazer:' + C.r);
    say('  Na janela de terminal que já está aberta, rode:');
  }
  say('');
  say(C.cy + C.b + '       /loop 3m diga apenas: estou vivo' + C.r);
  say('');
  say(C.d + '  Use Haiku e esforço baixo nessa janela — ela não precisa pensar.' + C.r);
  say(C.d + '  Deixe aberta enquanto trabalhar. Detalhes no README, seção' + C.r);
  say(C.d + '  "Quem alimenta o mural".' + C.r);
}

function semDado() {
  const d = diagnosticoMural(core.agora());
  say('');
  say(C.y + 'Sem leitura da cota.' + C.r + (d.titulo ? '  ' + d.titulo : ''));
  if (d.causas.length) {
    say('');
    for (const c of d.causas) say(C.d + '  · ' + c + C.r);
  }
  receita(d.conserto);
  say(C.d + '  Diagnóstico completo: ' + C.r + 'cota audit' + C.r);
  say('');
}

/* -------------------------------- cabe -------------------------------- */

function cmdCabe(n, tipo, json) {
  const { cfg, est, nowS, hist, janelas, custos } = ctx();
  if (!cfg.ligado) { say(C.y + 'ferramenta cota desativada' + C.r); return 2; }
  if (!est) { semDado(); return 1; }

  const res = an.admissao({ janelas, custos, cfg, n, tipo, nowS });
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
  if (res.onda && res.onda.restantes > 0) {
    say('');
    say(C.cy + C.b + `  dispare ${res.onda.tamanho} agora` + C.r +
        C.d + `, depois reavalie (faltam ${res.onda.restantes})` + C.r);
    if (res.onda.porque) say(C.d + '  ' + res.onda.porque + C.r);
  } else if (res.onda && res.onda.tamanho === n && n > 1) {
    say(C.d + `  pode disparar os ${n} de uma vez` + C.r);
  }
  if (res.baseAmostras) {
    // Dizer "limpa" quando a base é a contaminada seria mentir sobre a
    // qualidade do número — e a credibilidade aqui é o produto (D32).
    if (res.baseQualidade === 'limpa') {
      say(C.d + `  base: média ${res.baseFonte} de ${res.baseAmostras} amostra(s) limpa(s)` + C.r);
    } else {
      say(C.d + `  base: média ${res.baseFonte} de ${res.baseAmostras} amostra(s), ` +
          `${res.baseLimpas} sem contaminação` + C.r);
      say(C.d + '  (outra sessão escreveu durante as medições; isso infla o custo, ' +
          'então o número erra para o lado seguro)' + C.r);
    }
  }
  say('');
  return res.veredito === 'nao_cabe' ? 1 : 0;
}

/* ------------------------------- leitura ------------------------------- */

/*
 * D23 — sensor manual. A extensão do VS Code não executa status line, então
 * lá não existe sensor automático. Aqui o humano é o sensor: lê o /usage e
 * digita. O resto do sistema não sabe a diferença — só marca a origem, porque
 * dado manual não se atualiza sozinho e o audit precisa dizer isso.
 *
 * O formato do prazo é o mesmo que o /usage mostra: "3h44", "54min", "2d3h".
 */
function parsePrazo(txt) {
  if (!txt) return null;
  const s = String(txt).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)(?:min|m)?)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const d = Number(m[1] || 0), h = Number(m[2] || 0), min = Number(m[3] || 0);
  // "3h44" = 3h44min; "54min" sozinho = 54 minutos.
  return d * 86400 + h * 3600 + min * 60;
}

function cmdLeitura(args) {
  const nowS = core.agora();
  const cfg = core.lerConfig();
  const anterior = core.lerEstado();

  const pct5 = Number(args[0]);
  const pct7 = Number(args[1]);
  if (!Number.isFinite(pct5) || !Number.isFinite(pct7)) {
    say('uso: cota leitura <5h%> <7d%> [prazo5h] [prazo7d]');
    say('     cota leitura 12 62 3h44 54min');
    say('');
    say('Os prazos são os que o /usage mostra em "Reinicia em ...".');
    say('Omitindo, reaproveita os resets da leitura anterior se ainda valerem.');
    return 1;
  }
  if (pct5 < 0 || pct5 > 100 || pct7 < 0 || pct7 > 100) {
    say(C.v + 'percentual fora de 0–100' + C.r);
    return 1;
  }

  const resolver = (prazo, anteriorReset, rotulo) => {
    const s = parsePrazo(prazo);
    if (s !== null) return nowS + s;
    if (core.num(anteriorReset) !== null && anteriorReset > nowS) return anteriorReset;
    say(C.y + `sem prazo para a janela ${rotulo}: informe (ex.: 3h44) — ` +
        `a leitura anterior não serve mais` + C.r);
    return null;
  };

  const reset5 = resolver(args[2], anterior && anterior.reset5, '5h');
  const reset7 = resolver(args[3], anterior && anterior.reset7, '7d');
  if (reset5 === null || reset7 === null) return 1;

  const snap = {
    t: nowS, t_confirmado: nowS, sessao: 'manual', origem: 'manual',
    pct5, reset5, pct7, reset7,
    tokens: null, ctx_pct: null, modelo: null, versao: null,
  };
  core.gravarEstado(snap, true);   // leitura manual sempre vence (D6/D23)
  core.appendSessao('manual', snap);

  say('');
  say(C.g + '  leitura manual registrada' + C.r);
  say(`  5h  ${pct5.toFixed(1)}%  reseta em ${core.fmtDuracao(reset5 - nowS)} ` +
      C.d + `(${core.fmtHora(reset5)})` + C.r);
  say(`  7d  ${pct7.toFixed(1)}%  reseta ` +
      (reset7 - nowS > 86400 ? core.fmtDiaHora(reset7)
                             : 'em ' + core.fmtDuracao(reset7 - nowS) + C.d + ` (${core.fmtHora(reset7)})` + C.r));
  say('');
  say(C.d + `  vale como fresca por ${core.fmtDuracao(cfg.idade_max_s)}; ` +
      `depois vira piso (mínimo garantido).` + C.r);
  say('');
  return 0;
}

/* -------------------------------- audit -------------------------------- */

function acharStatusLine() {
  const alvos = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  const achados = [];
  for (const p of alvos) {
    const j = core.lerJson(p, null);
    if (j && j.statusLine && j.statusLine.command) {
      achados.push({ arquivo: p, comando: j.statusLine.command,
                     refresh: j.statusLine.refreshInterval || null });
    }
  }
  return achados;
}

function cmdAudit(json) {
  const { cfg, est, nowS, hist, custos, janelas } = ctx();
  const achados = [];
  const add = (ok, titulo, detalhe) => achados.push({ ok, titulo, detalhe });

  /* --- camada 1: o código está certo? --- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-audit-'));
  try {
    const payload = JSON.stringify({
      session_id: 'audit', model: { id: 'x', display_name: 'X' },
      rate_limits: {
        five_hour: { used_percentage: 33.3, resets_at: nowS + 3600 },
        seven_day: { used_percentage: 44.4, resets_at: nowS + 86400 },
      },
    });
    const saida = execFileSync(process.execPath, [path.join(__dirname, 'sensor.js')], {
      input: payload, encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_COTA_DIR: tmp }),
    });
    const gravado = core.lerJson(path.join(tmp, 'estado.json'), null);
    add(/33/.test(saida) && gravado && gravado.pct5 === 33.3 && gravado.reset5 === nowS + 3600,
        'sensor processa payload conhecido', 'render + gravação conferem');
  } catch (e) {
    add(false, 'sensor processa payload conhecido', String(e.message).slice(0, 120));
  }

  /* --- camada 2: o dado está chegando? --- */
  const sl = acharStatusLine();
  add(sl.length > 0, 'statusLine cadastrado em settings.json',
      sl.length ? sl.map(s => path.basename(s.arquivo) + (s.refresh ? ` refresh=${s.refresh}s` : ' SEM refreshInterval')).join(', ')
                : 'nenhum settings.json com statusLine — o sensor nunca é chamado');
  if (sl.length) {
    // A armadilha do Windows: o Claude Code executa o comando via cmd.exe, que
    // trata "/c" como switch. Um caminho como ".../claude-limits/sensor.js"
    // vira "laude-limits" e o comando morre sem deixar rastro nenhum.
    if (process.platform === 'win32') {
      const comBarra = sl.filter(s => /^[A-Za-z]:\//.test(s.comando.trim()));
      add(comBarra.length === 0, 'comando sem barra normal no executável (Windows)',
        comBarra.length === 0 ? '' :
        'o cmd.exe engole "/c" do caminho e o comando falha calado — ' +
        'use um wrapper .cmd ou barras invertidas escapadas');
    }
    const aponta = sl.some(s => /sensor\.(js|cmd)/.test(s.comando));
    add(aponta, 'statusLine aponta para o sensor.js',
        aponta ? '' : 'aponta para outro script: ' + sl[0].comando);
    const semRefresh = sl.some(s => !s.refresh);
    if (semRefresh) add(false, 'refreshInterval configurado',
      'sem refreshInterval o sensor congela enquanto subagentes trabalham');
  }
  // O batimento separa dois problemas que de fora parecem o mesmo.
  // Com leitura manual (D23) o sensor não roda por definição: cobrar batimento
  // seria acusar falha onde não há.
  const bat = core.lerJson(core.F.batimento, null);
  const manual = est && est.origem === 'manual';
  if (manual) {
    add(true, 'modo manual (a extensão do VS Code não roda status line)',
        'a frescura depende de você rodar `cota leitura` depois do /usage');
  } else {
    add(!!bat, 'o Claude Code chamou o sensor', bat
      ? `há ${core.fmtDuracao(nowS - bat.t)}` + (bat.versao ? `, Claude Code ${bat.versao}` : '')
      : 'NUNCA — settings recém-editado só vale em sessão nova, ou o comando falha ao executar');
    if (bat) {
      add(nowS - bat.t <= 300, 'batimento recente',
          `último há ${core.fmtDuracao(nowS - bat.t)}` +
          (nowS - bat.t > 300 ? ' — sem refreshInterval o sensor congela com a sessão ociosa' : ''));
      add(bat.tinha_rate_limits === true, 'o payload traz rate_limits', bat.tinha_rate_limits
        ? `sessão ${String(bat.sessao).slice(0, 8)}`
        : 'o sensor RODA, mas o payload vem sem rate_limits — a conta não é Claude.ai ' +
          'Pro/Max, ou esta sessão ainda não teve a primeira resposta da API');
    }
  }

  add(!!est, 'existe leitura gravada', est
    ? (est.origem === 'manual' ? 'MANUAL — digitada, não se atualiza sozinha' : 'automática, do sensor')
    : 'nenhuma');

  if (est) {
    const idade = nowS - est.t;
    add(idade <= cfg.idade_max_s, 'leitura fresca',
        `${core.fmtDuracao(idade)} atrás (limite ${core.fmtDuracao(cfg.idade_max_s)})`);

    const faixa = v => v === null || (v >= 0 && v <= 100);
    add(faixa(est.pct5) && faixa(est.pct7), 'percentuais dentro de 0–100',
        `5h=${est.pct5} 7d=${est.pct7}`);

    // Suspeita, não veredito: a mecânica da janela não é documentada.
    const dentro = (reset, maxS) => reset === null || (reset - nowS <= maxS + 60);
    add(dentro(est.reset5, 5 * 3600), 'reset de 5h no máximo 5h à frente',
        est.reset5 ? core.fmtDuracao(est.reset5 - nowS) : '—');
    add(dentro(est.reset7, 7 * 86400), 'reset semanal no máximo 7d à frente',
        est.reset7 ? core.fmtDuracao(est.reset7 - nowS) : '—');

    add(janelas.cinco.estado !== 'expirado', 'janela de 5h ainda válida',
        janelas.cinco.estado);
    add(core.monotoniaOk(hist, 'pct5', 'reset5', est.reset5),
        'monotonia da janela de 5h (D5)', 'percentual nunca caiu dentro da janela');
  }

  const sessoes = new Set(hist.map(h => h.sessao).filter(Boolean));
  add(hist.length > 0, 'histórico com leituras', `${hist.length} linhas, ${sessoes.size} sessão(ões)`);
  if (sessoes.size === 1) add(true, 'apenas 1 sessão no mural',
    'normal se você usa uma sessão por vez; com várias, o dado fica mais fresco');

  const amostras = core.lerJsonl(core.F.agentes);
  const limpas = amostras.filter(a => a.limpa).length;
  add(limpas > 0, 'amostras limpas de custo por subagente',
      `${limpas} limpa(s) de ${amostras.length} medida(s)` +
      (limpas === 0 ? ' — a admissão ainda não tem base' : ''));

  /* --- camada 3: bate com a verdade? --- */
  const afer = core.lerJsonl(core.F.afericoes);
  const ultima = afer[afer.length - 1];
  add(afer.length > 0, 'aferição contra o /usage já feita',
      ultima ? `${afer.length} aferição(ões), última há ${core.fmtDuracao(nowS - ultima.t)}` +
               (ultima.desvio !== null && ultima.desvio !== undefined ? `, desvio ${ultima.desvio.toFixed(1)} pts` : '')
             : 'nunca — rode /usage e compare com `cota audit <valor>`');

  /*
   * D34 — atualização do Claude Code invalida a conferência.
   *
   * Esta ferramenta lê contratos oficiais: o JSON da status line e os eventos
   * de hook. Uma versão nova pode mexer neles, e o modo de falha é silencioso —
   * o sensor continua rodando e simplesmente não acha mais o que procurava.
   * Comparar a versão de agora com a da última aferição custa nada e transforma
   * "será que quebrou?" numa linha de saída.
   */
  // (o batimento ja foi lido acima, na camada 1)
  const vAgora = (bat && bat.versao) || (est && est.versao) || null;
  const vAferida = ultima && ultima.versao ? ultima.versao : null;
  if (vAgora && vAferida) {
    add(vAgora === vAferida, 'a aferição foi feita nesta versão do Claude Code',
        vAgora === vAferida ? vAgora
          : `aferido na ${vAferida}, rodando a ${vAgora} — revalide com /usage`);
  } else if (vAgora && afer.length > 0) {
    add(true, 'versão do Claude Code', vAgora + C.d + ' (aferição antiga, sem versão registrada)' + C.r);
  }

  if (json) { say(JSON.stringify({ achados, versao: vAgora, versao_aferida: vAferida, modo_desconfiado: cfg.modo_desconfiado }, null, 2)); return 0; }

  say('');
  say(C.cy + C.b + 'cota audit' + C.r + C.d + '  — o /usage é a verdade; isto audita o cota' + C.r);
  say('');
  let falhas = 0;
  for (const a of achados) {
    if (!a.ok) falhas++;
    say(`  ${a.ok ? C.g + ' ok ' : C.v + 'FALHA'}${C.r}  ${a.titulo}` +
        (a.detalhe ? C.d + '  — ' + a.detalhe + C.r : ''));
  }
  say('');
  say(C.d + '  Camada 3 é sua: rode ' + C.r + '/usage' + C.d + ' e compare. Depois registre com' + C.r);
  say(C.d + '    ' + C.r + 'node cota.js audit ok' + C.d + '            (bateu)' + C.r);
  say(C.d + '    ' + C.r + 'node cota.js audit 47 62' + C.d + '         (o /usage mostrou 47% e 62%)' + C.r);
  say('');
  say(falhas === 0 ? C.g + '  nenhuma falha' + C.r : C.v + `  ${falhas} falha(s)` + C.r);
  say('');
  return falhas === 0 ? 0 : 1;
}

// D21/D22 — a aferição humana fica gravada, e divergência rebaixa a ferramenta.
function cmdAferir(args) {
  const { cfg, est, nowS } = ctx();
  if (!est) { semDado(); return 1; }

  const TOLERANCIA = 5;
  let desvio = null, informado5 = null, informado7 = null, bateu;

  if (args[0] === 'ok') {
    bateu = true;
  } else {
    informado5 = Number(args[0]);
    if (!Number.isFinite(informado5)) {
      say('uso: cota audit ok   |   cota audit <5h> [7d]');
      return 1;
    }
    if (args[1] !== undefined) informado7 = Number(args[1]);
    desvio = est.pct5 === null ? null : informado5 - est.pct5;
    bateu = desvio === null || Math.abs(desvio) <= TOLERANCIA;
  }

  // Guarda a versão do Claude Code junto: a ferramenta lê contratos oficiais
  // (o JSON da status line, os eventos de hook), e uma atualização pode mexer
  // neles. Sabendo em que versão a conferência foi feita, o audit avisa quando
  // ela envelheceu (D34).
  const bat = core.lerJson(core.F.batimento, null);
  core.appendJsonl(core.F.afericoes, {
    t: nowS, nosso5: est.pct5, nosso7: est.pct7,
    informado5, informado7, desvio, bateu, idade_leitura: nowS - est.t,
    versao: (bat && bat.versao) || est.versao || null,
  });

  const novo = Object.assign({}, cfg, { modo_desconfiado: !bateu });
  core.gravarConfig(novo);

  say('');
  if (bateu) {
    say(C.g + '  aferição registrada: bateu.' + C.r +
        (cfg.modo_desconfiado ? C.d + ' Modo desconfiado desligado.' + C.r : ''));
  } else {
    say(C.v + `  aferição registrada: DIVERGIU ${desvio.toFixed(1)} pontos` + C.r);
    say(C.d + `  cota dizia ${est.pct5}%, o /usage mostrou ${informado5}%` + C.r);
    say(C.y + '  modo desconfiado LIGADO: a ferramenta para de autorizar operação pesada (D22)' + C.r);
  }
  say('');
  return bateu ? 0 : 1;
}

/* ------------------------------ liga/config ------------------------------ */

function cmdLiga(ligado) {
  const cfg = core.lerConfig();
  cfg.ligado = ligado;
  core.gravarConfig(cfg);
  say(ligado ? C.g + 'cota ligada' + C.r : C.y + 'cota desligada' + C.r +
      C.d + ' (o sensor continua gravando; religar volta na hora)' + C.r);
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
   * Valida contra o TIPO do padrão, e recusa o que não converte.
   *
   * Sem isto, `cota config aviso.limiar_5h abc` gravava a string "abc". Nada
   * explodia: a comparação `pct < "abc"` dá false para sempre, e o aviso
   * simplesmente parava de disparar — para sempre, sem erro, sem sintoma. Numa
   * ferramenta cujo produto é o aviso, esse é o pior desfecho possível.
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
    if (/limiar|perguntar_acima_de/.test(ultima) && (convertido < 0 || convertido > 100)) {
      say(C.v + `${caminho} é um percentual: use 0 a 100 (recebeu ${convertido})` + C.r);
      return 1;
    }
    if (/_min$|_s$|orfao/.test(ultima) && convertido < 0) {
      say(C.v + `${caminho} não pode ser negativo` + C.r);
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
  core.gravarConfig(cfg);
  say(caminho + ' = ' + o[ultima]);
  return 0;
}

/* -------------------------------- limpar ------------------------------- */

/*
 * Poda manual. O medidor já poda sozinho ao fechar uma onda, mas quem só
 * consulta (ou parou de usar subagente) nunca dispara aquilo — e o histórico é
 * lido inteiro a cada hook.
 */
function cmdLimpar(dias, maxLinhas) {
  const cfg = core.lerConfig();
  const d = Number.isFinite(Number(dias)) ? Number(dias) : cfg.poda.dias;
  const m = Number.isFinite(Number(maxLinhas)) ? Number(maxLinhas) : cfg.poda.max_linhas;

  const antes = { sessoes: 0, bytes: 0 };
  try { antes.sessoes = fs.readdirSync(core.F.sessoes).filter(n => n.endsWith('.jsonl')).length; } catch (_) {}
  const tamanho = () => { let t = 0;
    const varrer = dir => { for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) varrer(p); else t += st.size; } };
    try { varrer(core.DIR); } catch (_) {}
    return t; };
  antes.bytes = tamanho();

  core.limparTmp(0);
  const r = core.podar(d, m);

  let depois = 0;
  try { depois = fs.readdirSync(core.F.sessoes).filter(n => n.endsWith('.jsonl')).length; } catch (_) {}
  say('');
  say(`  sessões: ${antes.sessoes} → ${depois}` +
      C.d + `  (removidas as sem uso há mais de ${d} dias; a mais recente nunca sai)` + C.r);
  say(`  arquivos de amostra truncados em ${m} linhas: ${r.truncados}`);
  say(`  tamanho: ${(antes.bytes / 1024).toFixed(0)} KB → ${(tamanho() / 1024).toFixed(0)} KB`);
  say('');
  return 0;
}

/* -------------------------------- main -------------------------------- */

/*
 * A prova de idiota, de propósito.
 *
 * Quem chama isto é um agente que nunca viu a ferramenta, num shell que pode
 * ser qualquer um, sem ninguém para corrigir se ele errar o comando. Errar o
 * comando e receber "code 1" e uma linha de uso é o pior desfecho possível:
 * o agente conclui que a ferramenta está quebrada e segue sem checar a cota —
 * exatamente o acidente que ela existe para evitar.
 *
 * Então: sinônimo é aceito, número solto vira `cabe`, comando desconhecido
 * mostra a situação em vez de reclamar, e nada aqui sai com erro por digitação.
 */

// tira acento e caixa, para 'diagnóstico' == 'diagnostico' == 'DIAGNOSTICO'
const normalizar = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/^-+/, '');

const SINONIMOS = {
  status: ['status', 'st', 'ver', 'agora', 'situacao', 'estado', 'cota', 'quanto', 'usage'],
  cabe:   ['cabe', 'aguenta', 'posso', 'suporta', 'check', 'cabem'],
  audit:  ['audit', 'auditoria', 'auditar', 'debug', 'diagnostico', 'conferir', 'doctor'],
  leitura:['leitura', 'ler', 'registrar', 'anotar'],
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
  say('');
  say('  cota — limites de uso do Claude Code');
  say('');
  say('  cota                    situação agora');
  say('  cota cabe 10            a cota aguenta 10 subagentes?');
  say('  cota cabe 10 Explore    idem, usando o custo médio desse tipo');
  say('  cota audit              diagnóstico: onde a corrente quebrou');
  say('  cota audit 34 12        registra o que o /usage mostrou');
  say('  cota off  |  cota on    desliga / religa a ferramenta');
  say('  cota config            mostra a configuração');
  say('  cota limpar            poda histórico velho (o medidor já faz sozinho)');
  say('');
  say('  Aceita sinônimo (ver, aguenta, debug...) e número solto:');
  say('  "cota 10" é o mesmo que "cota cabe 10".');
  say('');
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const args = argv.filter(a => a !== '--json');

let code = 0;
try {
  const cmd = resolver(args[0]);

  if (cmd === 'ajuda') { ajuda(); code = 0; }

  else if (cmd === 'cabe-numero-solto') { code = cmdCabe(Number(args[0]), args[1], json); }

  else if (cmd === 'cabe') {
    // Sem número: em vez de assumir 1 calado, diz o que faltou e mostra a
    // situação, para a resposta nunca ser inútil.
    const n = Number(args[1]);
    if (!Number.isFinite(n) || n < 1) {
      say('(faltou o número de agentes — ex.: cota cabe 10. Situação atual:)');
      say('');
      code = cmdStatus(json);
    } else {
      code = cmdCabe(n, args[2], json);
    }
  }

  else if (cmd === 'status')  code = cmdStatus(json);
  else if (cmd === 'leitura') code = cmdLeitura(args.slice(1));
  else if (cmd === 'audit')   code = args.length > 1 ? cmdAferir(args.slice(1)) : cmdAudit(json);
  else if (cmd === 'on')      code = cmdLiga(true);
  else if (cmd === 'off')     code = cmdLiga(false);
  else if (cmd === 'config')  code = cmdConfig(args[1], args[2]);
  else if (cmd === 'limpar')  code = cmdLimpar(args[1], args[2]);

  else {
    // Desconhecido: mostra a situação assim mesmo. Sair com erro faria o
    // agente desistir da ferramenta por causa de uma digitação.
    say('(não conheço "' + args[0] + '". Situação atual:)');
    say('');
    code = cmdStatus(json);
    ajuda();
  }
} catch (e) {
  // Nunca estoura na cara de quem chamou. Um traceback faria o agente
  // concluir "ferramenta quebrada" e seguir sem checar a cota.
  say('cota: falhou aqui dentro — ' + String((e && e.message) || e));
  say('Rode `cota audit` para o diagnóstico. Trate como SEM DADO por enquanto.');
  code = 0;
}
process.exit(code);
