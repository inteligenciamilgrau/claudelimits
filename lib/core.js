'use strict';
/*
 * core.js — mural, config, janelas e formatação.
 *
 * Nada aqui fala com o Claude Code: só lê e escreve arquivo. Quem traz o
 * número para o mural é a sonda (sonda.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX = process.env.COTA_PROVIDER === 'codex';
const DIR = CODEX
  ? process.env.COTA_CODEX_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cota')
  : process.env.CLAUDE_COTA_DIR || path.join(os.homedir(), '.claude', 'cota');
// A pasta do próprio Claude Code — de onde sai o registro de sessões abertas (D25).
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const F = {
  estado:      path.join(DIR, 'estado.json'),
  config:      path.join(DIR, 'config.json'),
  historico:   path.join(DIR, 'historico.jsonl'),
  agentes:     path.join(DIR, 'agentes.jsonl'),
  avisoUltimo: path.join(DIR, 'aviso-ultimo.json'),
  vigiaUltimo: path.join(DIR, 'vigia-ultimo.json'),
  // D47 — a medição em trechos. Um arquivo por subagente em cada pasta: cada
  // um só escreve os seus, sem corrida (D33). O marco é a última leitura da
  // cota, que abriu o trecho em curso.
  emVoo:       path.join(DIR, 'em-voo'),
  terminados:  path.join(DIR, 'terminados'),
  marco:       path.join(DIR, 'marco.json'),
  trechos:     path.join(DIR, 'trechos.jsonl'),
  // Mantido pelo Claude Code, um <pid>.json por sessão aberta (D25).
  sessoesClaude: path.join(CLAUDE_DIR, 'sessions'),
  // O batimento da sonda e a trava que impede N sondas juntas (D40).
  sonda:       path.join(DIR, 'sonda.json'),
  sondaTrava:  path.join(DIR, 'sonda.trava'),
  hooksEventos: path.join(DIR, 'hooks-eventos.jsonl'),
  hookErro: path.join(DIR, 'hook-erro.json'),
};

// Restos de versões anteriores: a que lia a status line (D44), a que media
// a onda inteira (D47) e a que somava o custo de cada agente (D48). Inofensivos, mas confundem quem for olhar a pasta — o
// instalador e o `cota limpar` removem.
const LEGADO = ['batimento.json', 'afericoes.jsonl', 'sessoes',
                'onda-atual.json', 'onda-participantes', 'ondas.jsonl', 'acumulado'];

const CONFIG_PADRAO = {
  ligado: true,
  // Acima disso, leitura que a sonda não conseguiu renovar vira piso (D4).
  idade_max_s: 900,
  aviso:     { ligado: true, limiar_5h: 80, limiar_7d: 70, repetir_min: 30 },
  admissao:  { ligado: true, perguntar_acima_de: 75, margem: 0.7 },
  // Órfão é quem perdeu a sessão, não quem passou da hora (D25): agente de 12h
  // existe. A idade só decide quando o registro de sessões não sabe dizer.
  // Um subagente que termina só lê a cota se o trecho em curso já tiver
  // `trecho_s` — senão a parte dele sai no próximo marco (D47).
  medidor:   { orfao_max_s: 172800, trecho_s: 120 },
  // D30 — vigia de workflow. Fala no SubagentStop, que só dispara com trabalho
  // em curso. Limiar mais baixo que o do aviso: aqui a cota se move rápido.
  vigia:     { ligado: true, limiar_5h: 70, limiar_7d: 60, repetir_min: 5 },
  // Histórico é lido inteiro a cada consulta: sem poda ele só cresce (D38).
  poda:      { dias: 14, max_linhas: 5000 },
  // D40 — idade a partir da qual cada ponto lê a cota de novo antes de decidir.
  // A leitura custa ~1,5s e zero cota: o `cota` e a admissão leem quase sempre,
  // o aviso (que atrasa a SUA mensagem) bem menos.
  sonda:     { idade_s: 60, aviso_s: 600, vigia_s: 180 },
  // Só no Codex: o peso das amostras pela idade (codex/estimativa.js) e a
  // política de parar de abrir ondas (codex/economia.js), em % consumido.
  ...(CODEX ? {
    estimativa: { meia_vida_dias: 7, max_dias: 30 },
    economia:   { ligado: true, reduzir_acima_de: 70, concluir_acima_de: 85 },
  } : {}),
};

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const agora = () => Math.floor(Date.now() / 1000);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function garantirDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function lerJson(p, padrao) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return padrao; }
}

// Espera síncrona, sem dependência: os hooks são processos curtos e não têm
// laço de eventos para esperar.
function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/*
 * Grava atômico (escreve em .tmp e renomeia), com repetição.
 *
 * O rename do Windows falha com EPERM quando outro processo tem o destino
 * aberto — e isso acontece de verdade: com 8 hooks simultâneos, 1 em 8 falhava;
 * com 16, 4 em 16. Cada falha deixava um .tmp órfão e perdia a gravação (D33).
 *
 * A repetição resolve a colisão, que é de milissegundos. Se ainda assim falhar,
 * o .tmp é removido: órfão acumulado atrapalha quem for diagnosticar depois.
 */
const gravarJson = (p, obj) => gravarTexto(p, JSON.stringify(obj, null, 2));

function gravarTexto(p, texto) {
  // A pasta do próprio arquivo, não só a raiz: a dos participantes de uma
  // onda é renomeada quando ela fecha, e quem grava naquele instante a recria.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  // 0600: o estado guarda perfil de uso. Não é segredo, mas também não é
  // assunto de outro usuário da máquina. No Windows quem manda é a ACL.
  fs.writeFileSync(tmp, texto, { mode: 0o600 });
  const recuperavel = { EPERM: 1, EACCES: 1, EBUSY: 1 };
  for (let tentativa = 0; ; tentativa++) {
    try { fs.renameSync(tmp, p); return true; }
    catch (e) {
      if (tentativa >= 5 || !recuperavel[e && e.code]) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (tentativa >= 5 && !CODEX) return false;
        throw e;
      }
      dormir(10 * (tentativa + 1));
    }
  }
}

/*
 * Varre o que processo morto deixou para trás: .tmp entre escrever e
 * renomear, e onda pela metade de desmontar (`.fechando.<pid>`). Só mexe no
 * que está velho, para nunca competir com quem ainda está trabalhando.
 */
function limparTmp(maxS) {
  const corte = Date.now() - (maxS == null ? 300 : maxS) * 1000;
  let nomes = [];
  try { nomes = fs.readdirSync(DIR); } catch (_) { return; }
  for (const n of nomes) {
    if (!n.endsWith('.tmp') && !n.includes('.fechando.')) continue;
    const p = path.join(DIR, n);
    try { if (fs.statSync(p).mtimeMs < corte) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
  }
}

function lerJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function appendJsonl(p, obj) {
  garantirDir();
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

/* ------------------------------- config ------------------------------- */

// Merge raso por seção: config parcial no disco não perde os padrões novos.
function lerConfig() {
  const disco = semProto(lerJson(F.config, {}));
  migrarEconomia(disco.economia);
  const c = Object.assign({}, CONFIG_PADRAO, disco);
  for (const k of Object.keys(CONFIG_PADRAO)) {
    if (typeof CONFIG_PADRAO[k] === 'object') c[k] = Object.assign({}, CONFIG_PADRAO[k], disco[k] || {});
  }
  return c;
}

// A primeira versão da economia do Codex media em % RESTANTE
// (evitar_ondas_abaixo_pct 30). Quem configurou assim continua valendo,
// convertido para % consumido como o resto da ferramenta.
function migrarEconomia(e) {
  if (!e || typeof e !== 'object') return;
  const velhas = { evitar_ondas_abaixo_pct: 'reduzir_acima_de', concluir_abaixo_pct: 'concluir_acima_de' };
  for (const [velha, nova] of Object.entries(velhas)) {
    if (num(e[velha]) !== null && !(nova in e)) e[nova] = 100 - e[velha];
    delete e[velha];
  }
}

const gravarConfig = c => gravarJson(F.config, c);

/*
 * Remove __proto__ de objeto vindo de JSON.
 *
 * `JSON.parse` cria `__proto__` como propriedade própria, mas `Object.assign`
 * usa [[Set]] e dispara o setter — o objeto de config saía com outro protótipo.
 * Não polui o `Object.prototype` global (verificado), e quem escreve no
 * config.json já está dentro do home do usuário. Ainda assim é sujeira barata
 * de limpar.
 */
function semProto(o) {
  if (!o || typeof o !== 'object') return o;
  const limpo = {};
  for (const k of Object.keys(o)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    limpo[k] = (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]))
      ? semProto(o[k]) : o[k];
  }
  return limpo;
}

/* -------------------------------- mural -------------------------------- */

const lerEstado = () => lerJson(F.estado, null);

/*
 * A leitura nova sempre substitui a anterior. Havia uma guarda "só se for mais
 * nova", e ela congelava o mural quando o relógio voltava (NTP, VM que
 * acordou): o estado ficava com hora do futuro e nenhuma leitura o vencia.
 * Duas sondas terminando fora de ordem só trocam uma leitura por outra de
 * segundos antes — não faz diferença.
 */
const gravarEstado = snap => gravarJson(F.estado, snap);

// Hora em que a leitura foi pedida, em ms. Estado antigo, sem `t_ms`, vale `t`.
const tMs = est => (num(est && est.t_ms) !== null ? est.t_ms : (num(est && est.t) || 0) * 1000);

// A última linha de um .jsonl, lendo só o fim do arquivo: quem chama está
// dentro de um hook que segura a sua mensagem, e o arquivo pode ter milhares
// de linhas.
function ultimaLinha(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const tam = fs.fstatSync(fd).size;
    const n = Math.min(tam, 4096);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, tam - n);
    const linhas = buf.toString('utf8').split('\n').filter(Boolean);
    return JSON.parse(linhas[linhas.length - 1]);
  } catch (_) { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

// Histórico só quando algum número muda — é dele que sai o ritmo (D13) e a
// checagem de monotonia (D5), e repetir o mesmo ponto só incha o arquivo.
// Como o número só muda nos pontos gravados, o histórico é uma escada: o
// valor num instante é o do último ponto até ali.
function registrarHistorico(snap) {
  const u = ultimaLinha(F.historico);
  if (u && u.pct5 === snap.pct5 && u.pct7 === snap.pct7 &&
      u.reset5 === snap.reset5 && u.reset7 === snap.reset7) return;
  appendJsonl(F.historico, { t: snap.t, pct5: snap.pct5, reset5: snap.reset5,
                             pct7: snap.pct7, reset7: snap.reset7 });
}

const lerHistorico = () => lerJsonl(F.historico).sort((a, b) => a.t - b.t);

/*
 * D38 — poda. O histórico e as amostras são lidos inteiros a cada consulta;
 * sem poda, cada `cota` passa a pagar por tudo o que já aconteceu. As janelas
 * de decisão são de 5h e 7d: histórico de mês passado não serve para nada.
 *
 * Reescrever um arquivo que outro processo pode estar acrescentando perde a
 * linha dele. Então a poda automática só reescreve quando há o que tirar com
 * folga — linha passada do prazo em mais de um dia, ou arquivo acima do teto —
 * o que dá uma vez por dia, não uma por onda; e grava atômico, para quem lê
 * nunca ver o arquivo pela metade. `folgaS: 0` é a poda pedida (`cota limpar`).
 */
function podar(maxDias, maxLinhas, opts) {
  const corteS = agora() - (maxDias == null ? 14 : maxDias) * 86400;
  const limite = maxLinhas == null ? 5000 : maxLinhas;
  const folgaS = opts && opts.folgaS != null ? opts.folgaS : 86400;
  const tDe = l => { try { return num(JSON.parse(l).t); } catch (_) { return null; } };
  let truncados = 0;
  for (const arq of [F.historico, F.agentes, F.trechos, ...(CODEX ? [F.hooksEventos] : [])]) {
    try {
      const linhas = fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean);
      const t0 = tDe(linhas[0]);
      const precisa = linhas.length > limite || (t0 !== null && t0 < corteS - folgaS);
      if (!precisa) continue;
      const vivas = linhas.filter(l => { const t = tDe(l); return t !== null && t >= corteS; })
        .slice(-limite);
      gravarTexto(arq, vivas.join('\n') + (vivas.length ? '\n' : ''));
      truncados++;
    } catch (_) {}
  }
  return { truncados };
}

function removerLegado() {
  const removidos = [];
  for (const n of LEGADO) {
    const p = path.join(DIR, n);
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); removidos.push(n); } catch (_) {}
  }
  return removidos;
}

/* ----------------------------- formatação ----------------------------- */

// D10: guarda absoluto, mostra relativo — sempre calculado na hora.
function fmtDuracao(s) {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h' + String(m).padStart(2, '0');
  return m + 'min';
}

const p2 = n => String(n).padStart(2, '0');

function fmtHora(epoch) {
  const d = new Date(epoch * 1000);
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
}

// D11: horizonte longo mostra dia da semana + data.
function fmtDiaHora(epoch) {
  const d = new Date(epoch * 1000);
  return DIAS[d.getDay()] + ' ' + p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + fmtHora(epoch);
}

/* ------------------------- estado de uma janela ------------------------- */

/*
 * D4 — leitura velha tem estados, e os dois úteis erram para o lado seguro.
 * D5 — se a monotonia já foi violada, dado velho vira desconhecido.
 *
 * Com a sonda a leitura quase sempre é fresca — mas se ela falhar, o número
 * gravado envelhece, e é aqui que ele deixa de valer como está.
 */
function avaliarJanela(pct, resetsAt, capturadoEm, cfg, nowS, monotoniaOk) {
  const r = {
    presente: false, pct: null, resetsAt: null, segAteReset: null,
    idade: null, estado: 'ausente', pctParaDecidir: null,
  };
  if (num(pct) === null) return r;

  r.presente = true;
  r.pct = pct;
  r.resetsAt = num(resetsAt);
  r.idade = nowS - capturadoEm;
  if (r.resetsAt !== null) r.segAteReset = r.resetsAt - nowS;

  if (r.resetsAt !== null && nowS >= r.resetsAt) {
    r.estado = 'expirado';          // a janela virou: o número não vale nada
    return r;
  }
  if (r.idade <= cfg.idade_max_s) {
    r.estado = 'fresco';
    r.pctParaDecidir = pct;
    return r;
  }
  if (monotoniaOk) {
    r.estado = 'piso';              // na mesma janela a cota só sobe
    r.pctParaDecidir = pct;
    return r;
  }
  r.estado = 'desconhecido';
  return r;
}

/*
 * D5 — a hipótese do piso se autocorrige: se a porcentagem cair dentro da
 * mesma janela, ela morre e o leitor passa a desconfiar de dado velho.
 */
function monotoniaOk(hist, chavePct, chaveReset, resetsAt) {
  if (resetsAt === null || resetsAt === undefined) return true;
  const pts = hist.filter(h => h[chaveReset] === resetsAt && num(h[chavePct]) !== null);
  for (let i = 1; i < pts.length; i++) {
    // tolerância de 0.5 para arredondamento do servidor
    if (pts[i][chavePct] < pts[i - 1][chavePct] - 0.5) return false;
  }
  return true;
}

function lerJanelas(estado, cfg, nowS, hist) {
  hist = hist || [];
  return {
    cinco: avaliarJanela(estado.pct5, estado.reset5, estado.t, cfg, nowS,
      monotoniaOk(hist, 'pct5', 'reset5', estado.reset5)),
    sete: avaliarJanela(estado.pct7, estado.reset7, estado.t, cfg, nowS,
      monotoniaOk(hist, 'pct7', 'reset7', estado.reset7)),
  };
}

module.exports = {
  DIR, F, LEGADO, CONFIG_PADRAO, DIAS, CODEX,
  agora, num, garantirDir, lerJson, gravarJson, gravarTexto, lerJsonl, appendJsonl,
  dormir, limparTmp, podar, removerLegado, semProto,
  lerConfig, gravarConfig, lerEstado, gravarEstado, tMs, registrarHistorico, lerHistorico,
  fmtDuracao, fmtHora, fmtDiaHora,
  avaliarJanela, monotoniaOk, lerJanelas,
};
