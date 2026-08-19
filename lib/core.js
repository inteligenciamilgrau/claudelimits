'use strict';
/*
 * core.js — mural, config, janelas e formatação.
 *
 * Nada aqui fala com o Claude Code. Só lê e escreve arquivo, e aplica as
 * regras de D4/D5/D6/D10/D11 do DECISOES.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.CLAUDE_COTA_DIR || path.join(os.homedir(), '.claude', 'cota');

const F = {
  estado:      path.join(DIR, 'estado.json'),
  config:      path.join(DIR, 'config.json'),
  sessoes:     path.join(DIR, 'sessoes'),
  agentes:     path.join(DIR, 'agentes.jsonl'),
  afericoes:   path.join(DIR, 'afericoes.jsonl'),
  avisoUltimo: path.join(DIR, 'aviso-ultimo.json'),
  emVoo:       path.join(DIR, 'em-voo.json'),
  batimento:   path.join(DIR, 'batimento.json'),
  vigiaUltimo: path.join(DIR, 'vigia-ultimo.json'),
  ondas:       path.join(DIR, 'ondas.jsonl'),
  ondaAtual:   path.join(DIR, 'onda-atual.json'),
  // Um arquivo por participante: sem arquivo compartilhado, sem corrida.
  ondaParts:   path.join(DIR, 'onda-participantes'),
};

const CONFIG_PADRAO = {
  ligado: true,
  idade_max_s: 900,
  modo_desconfiado: false,
  aviso:     { ligado: true, limiar_5h: 80, limiar_7d: 70, repetir_min: 30 },
  admissao:  { ligado: true, perguntar_acima_de: 75, margem: 0.7 },
  // Subagente nenhum roda 2h sem terminar: acima disso e orfao (D25).
  medidor:   { orfao_max_s: 7200 },
  // D30 — vigia de workflow. Fala no SubagentStop, que so dispara com trabalho
  // em curso. Limiar mais baixo que o do aviso: aqui a cota se move rapido.
  vigia:     { ligado: true, limiar_5h: 70, limiar_7d: 60, repetir_min: 5 },
  // Historico e lido inteiro a cada hook: sem poda ele vira custo por sessao
  // que ja existiu. Janela de decisao e de 7d, entao 14 dias e folga dobrada.
  poda:      { dias: 14, max_linhas: 5000 },
};

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const agora = () => Math.floor(Date.now() / 1000);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function garantirDir() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(F.sessoes, { recursive: true });
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
 * com 16, 4 em 16. Cada falha deixava um .tmp órfão e perdia a gravação.
 * Medido, não suposto (havia 6 órfãos de `onda-atual.json` no diretório real).
 *
 * A repetição resolve a colisão, que é de milissegundos. Se ainda assim falhar,
 * o .tmp é removido: órfão acumulado atrapalha quem for diagnosticar depois.
 */
function gravarJson(p, obj) {
  garantirDir();
  const tmp = p + '.' + process.pid + '.tmp';
  // 0600: o estado guarda id de sessão e perfil de uso. Não é segredo, mas
  // também não é assunto de outro usuário da máquina. No Windows quem manda
  // é a ACL e isto é inerte.
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  const recuperavel = { EPERM: 1, EACCES: 1, EBUSY: 1 };
  for (let tentativa = 0; ; tentativa++) {
    try { fs.renameSync(tmp, p); return true; }
    catch (e) {
      if (tentativa >= 5 || !recuperavel[e && e.code]) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (tentativa >= 5) return false;
        throw e;
      }
      dormir(10 * (tentativa + 1));
    }
  }
}

/*
 * Varre .tmp abandonados por processo que morreu entre escrever e renomear.
 * Só mexe no que está velho, para nunca competir com uma gravação em curso.
 */
function limparTmp(maxS) {
  const corte = Date.now() - (maxS || 300) * 1000;
  const varrer = dir => {
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of nomes) {
      if (!n.endsWith('.tmp')) continue;
      const p = path.join(dir, n);
      try { if (fs.statSync(p).mtimeMs < corte) fs.unlinkSync(p); } catch (_) {}
    }
  };
  varrer(DIR);
  varrer(F.sessoes);
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
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}

/* ------------------------------- config ------------------------------- */

// Merge raso por seção: config parcial no disco não perde os padrões novos.
function lerConfig() {
  const disco = semProto(lerJson(F.config, {}));
  const c = Object.assign({}, CONFIG_PADRAO, disco);
  for (const k of ['aviso', 'admissao', 'medidor', 'vigia', 'poda']) {
    c[k] = Object.assign({}, CONFIG_PADRAO[k], disco[k] || {});
  }
  return c;
}

const gravarConfig = c => gravarJson(F.config, c);

/*
 * Remove __proto__ de objeto vindo de JSON.
 *
 * `JSON.parse` cria `__proto__` como propriedade própria, mas `Object.assign`
 * usa [[Set]] e dispara o setter — o objeto de config saía com outro protótipo.
 * Não polui o `Object.prototype` global (verificado), e quem escreve no
 * config.json já está dentro do home do usuário. Ainda assim é sujeira barata
 * de limpar, e o dia em que alguém ler uma chave que não está no padrão o
 * protótipo envenenado responderia por ela.
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
 * D6: nunca sobrescreve cego. Só grava se o que chega for mais novo.
 *
 * `forcar` é para a leitura manual (D23): ela vem do /usage, é a fonte mais
 * autoritativa que existe aqui, e é ato deliberado do humano. Sem isso, duas
 * leituras manuais no mesmo segundo fariam a segunda ser silenciosamente
 * descartada pela guarda de tempo.
 */
function gravarEstado(snap, forcar) {
  const atual = lerEstado();
  // Rejeita só o estritamente mais velho. Com `<=`, duas leituras no mesmo
  // segundo (o debounce da status line é de 300ms) faziam a segunda ser
  // descartada — inclusive quando ela trazia confirmação nova (D24).
  if (!forcar && atual && num(atual.t) !== null && snap.t < atual.t) return false;
  gravarJson(F.estado, snap);
  return true;
}

// D7: um arquivo por sessão, juntados na leitura.
function appendSessao(sessionId, entry) {
  const id = String(sessionId || 'sem-sessao').replace(/[^A-Za-z0-9_-]/g, '_');
  appendJsonl(path.join(F.sessoes, id + '.jsonl'), entry);
}

/*
 * Poda do histórico (segurança por acumulação).
 *
 * `lerHistorico()` lê TODOS os arquivos de sessão a cada invocação de hook, e
 * os hooks rodam a cada subagente e a cada mensagem. Com dez sessões isso é
 * nada; com mil, cada subagente paga mil leituras de arquivo. O arquivo cresce
 * sozinho e ninguém percebe até ficar lento.
 *
 * Nada aqui é apagado por idade sozinho sem folga: só sessão cujo arquivo não
 * é tocado há `maxDias` e que não é a mais recente. As janelas de decisão são
 * de 5h e 7d — histórico de mês passado não serve para nada.
 */
function podar(maxDias, maxLinhas) {
  const corte = Date.now() - (maxDias || 14) * 86400000;
  const limite = maxLinhas || 5000;
  let removidos = 0, truncados = 0;

  try {
    const arqs = fs.readdirSync(F.sessoes).filter(n => n.endsWith('.jsonl'))
      .map(n => { const p = path.join(F.sessoes, n);
                  return { p, m: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.m - a.m);
    // A mais recente nunca sai: é a que alimenta o mural agora.
    for (const a of arqs.slice(1)) {
      if (a.m < corte) { try { fs.unlinkSync(a.p); removidos++; } catch (_) {} }
    }
  } catch (_) {}

  for (const arq of [F.agentes, F.ondas, F.afericoes]) {
    try {
      const NL = String.fromCharCode(10);
      const linhas = fs.readFileSync(arq, 'utf8').split(NL).filter(Boolean);
      if (linhas.length <= limite) continue;
      fs.writeFileSync(arq, linhas.slice(-limite).join(NL) + NL, { mode: 0o600 });
      truncados++;
    } catch (_) {}
  }
  return { removidos, truncados };
}

function lerHistorico() {
  let arquivos = [];
  try { arquivos = fs.readdirSync(F.sessoes).filter(n => n.endsWith('.jsonl')); } catch (_) { return []; }
  const tudo = [];
  for (const nome of arquivos) {
    const sid = nome.replace(/\.jsonl$/, '');
    for (const e of lerJsonl(path.join(F.sessoes, nome))) {
      e.sessao = e.sessao || sid;
      tudo.push(e);
    }
  }
  return tudo.sort((a, b) => a.t - b.t);
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
 * D4 — três estados, e os dois úteis erram para o lado seguro.
 * D5 — se a monotonia já foi violada, dado velho vira desconhecido.
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

/*
 * D24 — a idade que importa é a do último valor CONFIRMADO, não a da última
 * observação. Sessão ociosa repete o mesmo número indefinidamente com `t` novo;
 * usar `t` aí seria tratar dado podre como fresco.
 */
function tConfirmado(estado) {
  return num(estado.t_confirmado) !== null ? estado.t_confirmado : estado.t;
}

function lerJanelas(estado, cfg, nowS, hist) {
  hist = hist || [];
  const tc = tConfirmado(estado);
  return {
    cinco: avaliarJanela(estado.pct5, estado.reset5, tc, cfg, nowS,
      monotoniaOk(hist, 'pct5', 'reset5', estado.reset5)),
    sete: avaliarJanela(estado.pct7, estado.reset7, tc, cfg, nowS,
      monotoniaOk(hist, 'pct7', 'reset7', estado.reset7)),
  };
}

module.exports = {
  DIR, F, CONFIG_PADRAO, DIAS,
  agora, num, garantirDir, lerJson, gravarJson, lerJsonl, appendJsonl,
  dormir, limparTmp, podar, semProto,
  lerConfig, gravarConfig, lerEstado, gravarEstado, appendSessao, lerHistorico,
  fmtDuracao, fmtHora, fmtDiaHora,
  avaliarJanela, monotoniaOk, lerJanelas, tConfirmado,
};
