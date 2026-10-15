'use strict';
/*
 * sonda.js — lê a cota pelo protocolo de controle do CLI do Claude Code.
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *   entrada: {"type":"control_request","request_id":"cota",
 *             "request":{"subtype":"get_usage","skip_behaviors":true}}
 *
 * É a mensagem que a extensão do VS Code manda para o medidor de uso dela
 * (D39). Não é prompt: nenhum modelo é chamado, nenhuma cota é gasta, e não
 * existe caminho em que ela vire um turno. Responde em ~1,5s com os mesmos
 * números do /usage, e o processo sai sozinho quando a entrada fecha.
 *
 * O preço é o contrato: não é documentado, e o método do SDK que a envia se
 * chama `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Se mudar,
 * a sonda diz o que faltou — nunca inventa número (D36).
 *
 * SE O get_usage SUMIR UM DIA: volta para o `/usage` como prompt. A receita,
 * com a guarda que ela exige para não gastar cota, está no D39 (plano B).
 *
 * Mesmo rápida, ninguém lê a cada hook — só quando a leitura passou da idade,
 * e com trava para N hooks não lerem juntos (D40).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('./core');

const WINDOWS = process.platform === 'win32';

// Hook atrasa alguém (a sua mensagem, o subagente): espera menos que o CLI.
const TIMEOUT_MS = 30000;
const TIMEOUT_HOOK_MS = 10000;

// Marca o processo filho. Os hooks já vêm desligados na sessão da sonda, mas
// se um dia não vierem, um hook que sonda dispararia outra sonda, que
// dispararia o hook... A marca corta isso na raiz.
const MARCA = 'COTA_SONDA_ATIVA';

/* --------------------------- achar o claude --------------------------- */

// Compara "2.1.300" com "2.1.99" como número, não como texto.
function compararVersao(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/*
 * D43 — o binário que a extensão do VS Code traz embutido, que MUDA DE PASTA a
 * cada atualização: `anthropic.claude-code-2.1.299-win32-x64` vira
 * `...-2.1.300-...`. Por isso ele é procurado a cada sonda e nunca gravado em
 * lugar nenhum — não existe caminho velho para corrigir.
 *
 * O que o disco mostra depois de uma atualização (visto em 2.1.299 → 2.1.300):
 * a pasta velha CONTINUA lá, com o claude.exe inteiro, marcada em `.obsolete`
 * até o VS Code limpar. Quem diz qual versão está instalada é o
 * `extensions.json`. Então, em ordem:
 *
 *   1. a versão que o `extensions.json` registra — a instalada de fato;
 *   2. as pastas que existem, sem as do `.obsolete`, da mais nova para a mais
 *      velha — reserva para quando o registro não ajudar.
 *
 * "A mais nova" sozinha erraria num downgrade (a mais alta fica obsoleta, mas
 * ainda no disco) e numa atualização em curso (pasta nova, binário pela
 * metade, ainda fora do registro).
 */
function localDe(loc) {
  if (!loc) return null;
  let p = typeof loc === 'string' ? loc : (loc.fsPath || loc.path);
  if (!p) return null;
  if (WINDOWS && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);   // "/c:/Users/..." do VS Code
  return path.normalize(p);
}

function filhaDaExtensao(dir, pasta) {
  const igual = WINDOWS ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const p = path.resolve(pasta);
  return igual(path.dirname(p), path.resolve(dir)) &&
         /^anthropic\.claude-code-/i.test(path.basename(p));
}

function candidatosDaExtensao(home) {
  const exe = WINDOWS ? 'claude.exe' : 'claude';
  const binario = pasta => path.join(pasta, 'resources', 'native-binary', exe);
  const registrados = [], soltos = [];
  for (const raiz of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = path.join(home, raiz, 'extensions');
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch (_) { continue; }

    const reg = core.lerJson(path.join(dir, 'extensions.json'), []);
    for (const e of Array.isArray(reg) ? reg : []) {
      if (!e || !e.identifier || String(e.identifier.id).toLowerCase() !== 'anthropic.claude-code') continue;
      const pasta = e.relativeLocation ? path.join(dir, e.relativeLocation) : localDe(e.location);
      // O registro só pode apontar para uma pasta da própria extensão, filha
      // direta de extensions/. Um "../../qualquer-lugar" ali faria a sonda
      // executar o binário que estivesse lá (D45).
      if (pasta && filhaDaExtensao(dir, pasta) && fs.existsSync(binario(pasta))) {
        registrados.push({ p: binario(pasta), v: String(e.version || '0') });
      }
    }

    const obsoletos = core.lerJson(path.join(dir, '.obsolete'), {}) || {};
    for (const n of nomes) {
      const m = n.match(/^anthropic\.claude-code-(\d+(?:\.\d+)*)/);
      if (!m || obsoletos[n]) continue;
      if (fs.existsSync(binario(path.join(dir, n)))) soltos.push({ p: binario(path.join(dir, n)), v: m[1] });
    }
  }
  const porVersao = (a, b) => compararVersao(b.v, a.v);
  return registrados.sort(porVersao).concat(soltos.sort(porVersao)).map(x => x.p);
}


/*
 * Todos os claudes possíveis, na ordem de preferência: $COTA_CLAUDE, PATH,
 * ~/.local/bin, extensão do VS Code. A sonda tenta o primeiro e só passa ao
 * seguinte se ele nem chegar a executar (pasta apagada pela limpeza do VS Code
 * entre achar e rodar, binário pela metade).
 *
 * No Windows só vale `.exe`. O `claude.cmd` do npm exigiria `shell: true`, e
 * o Node recusa .cmd sem shell desde a correção de segurança de 2024 — com
 * shell, os argumentos (o JSON do --settings) passariam pelo cmd.exe. Não vale
 * o risco.
 */
function candidatosClaude(env, home) {
  env = env || process.env;
  home = home || os.homedir();

  // Definido, manda sozinho: apontar para um caminho errado tem que dar "não
  // achei", e não cair calado num outro claude que a pessoa não escolheu.
  // Aceita vários, separados como no PATH, na ordem de preferência.
  if (env.COTA_CLAUDE) {
    return env.COTA_CLAUDE.split(path.delimiter).filter(p => p && fs.existsSync(p));
  }

  const lista = [];
  const nome = WINDOWS ? 'claude.exe' : 'claude';
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    // Só entrada absoluta. Um "." no PATH faria um claude.exe plantado num
    // repositório clonado rodar pelo hook, sem ninguém pedir (D45).
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, nome);
    try { if (fs.statSync(p).isFile()) lista.push(p); } catch (_) {}
  }
  const local = path.join(home, '.local', 'bin', nome);
  if (fs.existsSync(local)) lista.push(local);
  return [...new Set(lista.concat(candidatosDaExtensao(home)))];
}

const acharClaude = (env, home) => candidatosClaude(env, home)[0] || null;

// "…/anthropic.claude-code-2.1.300-win32-x64/…/claude.exe" → "2.1.300"
function rotuloExe(p) {
  if (!p) return 'nenhum';
  const m = String(p).match(/claude-code-(\d+(?:\.\d+)*)/);
  return m ? 'extensão ' + m[1] : p;
}


/* ---------------------------- interpretar ---------------------------- */

const ID = 'cota';

/*
 * ISO → epoch, arredondado ao minuto.
 *
 * O servidor devolve o mesmo reset com ruído de fração de segundo: duas
 * leituras seguidas deram "10:59:59.506" e "11:00:00". E o resto do sistema
 * compara reset por IGUALDADE — é assim que sabe que a janela virou (medidor),
 * que a cota só sobe (D5) e que dois pontos são da mesma janela (ritmo). Sem
 * arredondar, cada leitura pareceria uma janela nova.
 */
const epoch = iso => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 60000) * 60 : null;
};

// Texto que vem de fora e vai parar na saída que o agente lê: só o que um
// nome de modelo, de plano ou uma mensagem de erro precisa ter, e curto.
const texto = (v, max) => (v === null || v === undefined ? '' :
  String(v).replace(/[^\w .,:()+-]/g, '').slice(0, max || 40));

/*
 * Da saída do CLI para o snapshot do mural.
 *
 * Função pura, para o teste poder alimentar com a resposta real capturada.
 * Nunca inventa número: se o formato mudou, devolve `erro` dizendo o que
 * faltou, e quem chamou não grava nada (D36).
 */
function interpretar(saida, nowS) {
  if (core.CODEX) return require('./codex/sonda').interpretar(saida, nowS);
  let resp = null;
  for (const l of String(saida || '').split(/\r?\n/)) {
    if (!l || l[0] !== '{') continue;
    let j; try { j = JSON.parse(l); } catch (_) { continue; }
    if (j.type === 'control_response' && j.response && j.response.request_id === ID) resp = j.response;
  }

  const r = { ok: false, erro: null, snap: null, plano: null };
  if (!resp) {
    r.erro = 'o claude não respondeu ao get_usage — esta versão do Claude Code pode não ter o pedido';
    return r;
  }
  if (resp.subtype !== 'success') {
    r.erro = 'o claude recusou o get_usage (' + (texto(resp.error, 120) || 'sem detalhe') +
             ') — o protocolo mudou nesta versão do Claude Code';
    return r;
  }

  const u = resp.response || {};
  r.plano = texto(u.subscription_type) || null;
  const rl = u.rate_limits;
  if (u.rate_limits_available === false || !rl || !Array.isArray(rl.limits)) {
    r.erro = 'não há limite de plano para ler' + (r.plano ? ` (plano: ${r.plano})` : '') +
             ' — precisa de Claude.ai Pro ou Max, ou o Claude Code não conseguiu consultar agora';
    return r;
  }

  const por = k => rl.limits.find(x => x && x.kind === k && core.num(x.percent) !== null);
  const s = por('session'), w = por('weekly_all');
  if (!s && !w) {
    r.erro = 'rate_limits sem "session" nem "weekly_all" — os nomes mudaram: ' +
             rl.limits.map(x => texto(x && x.kind)).join(', ');
    return r;
  }

  r.ok = true;
  r.snap = {
    t: nowS,
    pct5: s ? s.percent : null, reset5: s ? epoch(s.resets_at) : null,
    pct7: w ? w.percent : null, reset7: w ? epoch(w.resets_at) : null,
    // O sub-limite semanal por modelo (ex.: Fable): pode estourar antes do
    // agregado, então aparece no `cota`.
    modelos: rl.limits.filter(x => x && x.kind === 'weekly_scoped').map(x => ({
      nome: texto(x.scope && x.scope.model && x.scope.model.display_name) || '?',
      pct: core.num(x.percent), reset: epoch(x.resets_at),
    })),
    plano: r.plano,
  };
  return r;
}

/* ------------------------------- sondar ------------------------------- */

/*
 * O pedido, com `skip_behaviors`: sem ele o CLI ainda analisa "o que está
 * consumindo a sua cota" lendo os seus logs locais — ~2s a mais, para uma
 * resposta que a sonda descarta.
 */
const PEDIDO = JSON.stringify({ type: 'control_request', request_id: ID,
  request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n';

const ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  // Sem isto cada leitura vira uma conversa na sua lista de sessões.
  '--no-session-persistence',
  // Nem servidor MCP nem hook: mais rápido e sem recursão.
  '--strict-mcp-config',
  '--settings', '{"disableAllHooks":true}',
  // Só as SUAS configurações, nunca as de projeto: o claude lê o
  // .claude/settings.json do diretório onde roda, e ali há chaves que
  // executam comando (apiKeyHelper, proxyAuthHelper...). Provado (D45).
  '--setting-sources', 'user',
];

function executar(exe, timeoutMs) {
  if (core.CODEX) return require('./codex/sonda').executar(exe, timeoutMs);
  // Um `.js` aqui é o claude falso do teste: roda pelo próprio node.
  const [cmd, args] = /\.js$/i.test(exe)
    ? [process.execPath, [exe].concat(ARGS)] : [exe, ARGS];
  // Pasta só sua, não a temporária do sistema: no Linux ela é o /tmp,
  // onde qualquer usuário da máquina cria arquivo (D45).
  core.garantirDir();
  return execFileSync(cmd, args, {
    input: PEDIDO, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    cwd: core.DIR,
    env: Object.assign({}, process.env, { [MARCA]: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
}

// A resposta não traz a versão; a pasta da extensão traz (D43).
const versaoDe = exe => (String(exe || '').match(/(?:claude-code-|openai\.chatgpt-)(\d+(?:\.\d+)*)/) || [])[1] || null;

/*
 * Lê agora. Grava no mural se der certo, e SEMPRE grava o resultado em
 * sonda.json — é o batimento da sonda: o audit lê dele em que elo a corrente
 * quebrou, e o garantirFresco lê dele quando foi a última falha (D40).
 */
function sondar(opts) {
  opts = opts || {};
  const nowS = core.agora();
  const reg = { t: nowS, ok: false, erro: null, exe: null, ms: null, versao: null };

  if (process.env[MARCA]) {
    return Object.assign(reg, { erro: 'chamada de dentro da própria sonda (recursão evitada)' });
  }
  const anterior = core.lerJson(core.F.sonda, null);

  const candidatos = core.CODEX ? require('./codex/sonda').candidatos() : candidatosClaude();
  if (!candidatos.length) {
    reg.erro = 'não achei o executável do claude (PATH, ~/.local/bin, extensão do VS Code). ' +
               'Defina COTA_CLAUDE com o caminho dele.';
    if (core.CODEX) reg.erro = 'Não achei o Codex no PATH nem na extensão. Defina COTA_CODEX com o caminho absoluto do executável.';
    core.gravarJson(core.F.sonda, reg);
    return reg;
  }

  const primeiraLinha = e => String((e && (e.stderr || e.message)) || e).trim()
    .split(/\r?\n/)[0].slice(0, 200);
  let saida = null, tPedidoMs = null;
  const pulados = [];
  for (const c of candidatos) {
    const t0 = tPedidoMs = Date.now();
    try {
      saida = executar(c, opts.timeoutMs || TIMEOUT_MS);
      reg.exe = c; reg.ms = Date.now() - t0;
      break;
    } catch (e) {
      /*
       * Não chegou a executar (sem código de saída, sem sinal): o arquivo
       * sumiu ou está pela metade — a limpeza ou a atualização do VS Code no
       * meio do caminho. Tenta o próximo. Se EXECUTOU e falhou, aquilo é a
       * resposta do claude, e tentar outro só esconderia o problema.
       */
      const naoRodou = e && e.status == null && e.signal == null &&
                       typeof e.code === 'string' && e.code !== 'ETIMEDOUT';
      if (naoRodou) { pulados.push(rotuloExe(c) + ' (' + e.code + ')'); continue; }
      reg.exe = c; reg.ms = Date.now() - t0;
      reg.erro = (core.CODEX ? 'o Codex' : 'o claude') + ' falhou ao responder: ' + primeiraLinha(e);
      break;
    }
  }
  if (pulados.length) reg.pulados = pulados;
  if (!reg.exe) {
    reg.erro = 'nenhum claude encontrado chegou a executar: ' + pulados.join(', ');
  }
  reg.versao = versaoDe(reg.exe);

  /*
   * D43 — detectar a troca, não só sobreviver a ela. Não há caminho a
   * corrigir (nada é gravado), mas "o claude mudou de 2.1.299 para 2.1.300"
   * é o que explica uma quebra que aparecer depois de uma atualização. A
   * última troca fica registrada até a próxima.
   */
  // No Windows "c:\Users" e "C:\Users" são o mesmo arquivo — o editor às vezes
  // passa a letra do drive minúscula, e isso não é troca nenhuma.
  const mesmoExe = (a, b) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (anterior && anterior.exe && reg.exe && !mesmoExe(anterior.exe, reg.exe)) {
    reg.exe_anterior = anterior.exe; reg.exe_mudou_em = nowS;
  } else if (anterior && anterior.exe_anterior) {
    reg.exe_anterior = anterior.exe_anterior; reg.exe_mudou_em = anterior.exe_mudou_em;
  }

  if (saida === null) {
    core.gravarJson(core.F.sonda, reg);
    return reg;
  }

  /*
   * O carimbo é a hora em que a leitura foi PEDIDA, não a em que voltou. O
   * uso que acontecer depois do pedido não está no número — e quem fecha uma
   * onda precisa de uma leitura pedida depois do fim dela (D41).
   */
  const r = interpretar(saida, Math.floor(tPedidoMs / 1000));
  reg.plano = r.plano;
  if (!r.ok) {
    reg.erro = r.erro;
    core.gravarJson(core.F.sonda, reg);
    return reg;
  }

  reg.ok = true;
  if (core.CODEX) require('./codex/sonda').separarConta(r.snap);
  reg.pct5 = r.snap.pct5; reg.pct7 = r.snap.pct7;
  core.gravarJson(core.F.sonda, reg);
  r.snap.t_ms = tPedidoMs;   // o fechamento de onda compara abaixo do segundo (D41)
  r.snap.versao = reg.versao;
  core.gravarEstado(r.snap);
  core.registrarHistorico(r.snap);
  return Object.assign(reg, { snap: r.snap });
}

/* -------------------------------- trava -------------------------------- */

/*
 * D40 — uma sonda de cada vez. A trava carrega o PRAZO de quem a pegou (o
 * timeout dele, e um pouco mais): passado o prazo, ela é de um processo que
 * morreu — hook morto pelo Claude Code, Ctrl+C no meio do `cota` — e qualquer
 * um assume. Antes era um limite fixo de 60s, e quem esperava ficava preso o
 * próprio timeout inteiro (35s no `cota`) para depois decidir com número velho.
 */
function pegarTrava(timeoutMs) {
  core.garantirDir();
  const conteudo = JSON.stringify({ pid: process.pid, prazo: Date.now() + timeoutMs + 5000 });
  try { fs.writeFileSync(core.F.sondaTrava, conteudo, { flag: 'wx' }); return true; }
  catch (e) { if (core.CODEX && e.code !== 'EEXIST') throw e; }
  // Existe: só assume se o prazo passou. Relê logo antes de apagar e só apaga
  // se ainda é a MESMA trava vencida — senão dois que a viram vencida
  // apagariam um a trava nova do outro.
  const vista = travaVencida();
  if (vista === null) return false;
  try {
    if (fs.readFileSync(core.F.sondaTrava, 'utf8') !== vista) return false;
    fs.unlinkSync(core.F.sondaTrava);
    fs.writeFileSync(core.F.sondaTrava, conteudo, { flag: 'wx' });
    return true;
  } catch (_) { return false; }
}

// O conteúdo da trava, se ela existe e está vencida; senão null.
function travaVencida() {
  let txt;
  try { txt = fs.readFileSync(core.F.sondaTrava, 'utf8'); } catch (_) { return null; }
  let prazo = null;
  try { prazo = core.num(JSON.parse(txt).prazo); } catch (_) {}
  // Trava ilegível (formato antigo, escrita pela metade): vale a idade do arquivo.
  if (prazo === null) {
    try { prazo = fs.statSync(core.F.sondaTrava).mtimeMs + TIMEOUT_MS + 5000; } catch (_) { return null; }
  }
  return Date.now() > prazo ? txt : null;
}

function soltarTrava() {
  try {
    const t = JSON.parse(fs.readFileSync(core.F.sondaTrava, 'utf8'));
    if (t.pid === process.pid) fs.unlinkSync(core.F.sondaTrava);
  } catch (_) {}
}

// Ctrl+C no meio de uma sonda: sem isto o processo morre sem passar pelo
// `finally`, e a trava fica para trás até vencer.
let soltarNoCtrlC = false;
function protegerDoCtrlC() {
  if (soltarNoCtrlC) return;
  soltarNoCtrlC = true;
  process.once('SIGINT', () => { soltarTrava(); process.exit(130); });
}

/* ---------------------------- garantirFresco ---------------------------- */

// D40 — depois de uma falha, não tenta de novo antes disto. Sem a pausa, uma
// sonda que falha sempre (conta sem plano, sem rede, claude deslogado) seria
// repetida em cada mensagem e em cada subagente, 3 a 10s cada vez.
const PAUSA_FALHA_S = 300;

/*
 * D40 — sonda só se a leitura passou da idade, e uma de cada vez.
 *
 * N hooks disparam juntos (16 SubagentStart no mesmo segundo é normal). Com a
 * trava, o primeiro sonda e os outros ESPERAM o resultado dele — esperar 3s é
 * melhor que sair com o número velho, porque é justamente o número que vai ser
 * usado. Quem não pode esperar passa `esperar: false`.
 *
 * `depoisDeMs` (epoch em ms) exige uma leitura PEDIDA a partir daquele instante: é
 * como o fechamento de onda garante que o número inclui a onda inteira (D41).
 */
function garantirFresco(maxIdadeS, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const fresco = () => {
    const est = core.lerEstado();
    if (!est || core.num(est.t) === null) return false;
    const idade = core.agora() - est.t;
    // Idade negativa: o relógio voltou (NTP, VM que acordou). A leitura é
    // "do futuro", e tratá-la como fresca a congelaria até o relógio alcançar.
    if (idade < 0) return false;
    if (opts.depoisDeMs != null) return core.tMs(est) >= opts.depoisDeMs;
    return idade <= maxIdadeS;
  };
  const falhouHaPouco = () => {
    const s = core.lerJson(core.F.sonda, null);
    if (!s || s.ok || core.num(s.t) === null) return false;
    const desde = core.agora() - s.t;
    return desde >= 0 && desde < PAUSA_FALHA_S;
  };

  if (fresco()) return { sondou: false, motivo: 'fresco' };
  if (falhouHaPouco()) return { sondou: false, motivo: 'falhou há pouco' };

  // Duas voltas: se a sonda pela qual esperamos não serviu (falhou, ou foi
  // pedida antes do `depoisDe`), tentamos a nossa.
  for (let volta = 0; volta < 2; volta++) {
    if (pegarTrava(timeoutMs)) {
      protegerDoCtrlC();
      try {
        const r = sondar(Object.assign({}, opts, { timeoutMs }));
        return { sondou: true, ok: r.ok, erro: r.erro };
      } finally { soltarTrava(); }
    }
    if (opts.esperar === false) return { sondou: false, motivo: 'outra sonda em curso' };
    // Espera a outra terminar — ou vencer, se o dono morreu.
    const limite = Date.now() + timeoutMs + 5000;
    while (Date.now() < limite && fs.existsSync(core.F.sondaTrava) && !travaVencida()) core.dormir(200);
    if (fresco()) return { sondou: false, motivo: 'esperou outra sonda' };
    if (falhouHaPouco()) return { sondou: false, motivo: 'a outra sonda falhou' };
  }
  return { sondou: false, motivo: 'não conseguiu a vez' };
}

/*
 * A política dos hooks num lugar só: um hook segura alguém (a sua mensagem, o
 * subagente), então espera no máximo 10s, e nunca deixa uma falha da sonda
 * atrapalhar o trabalho — decide com o que o mural tiver (D45).
 */
function garantirFrescoHook(maxIdadeS, opts) {
  try { return garantirFresco(maxIdadeS, Object.assign({ timeoutMs: TIMEOUT_HOOK_MS }, opts)); }
  catch (_) { return null; }
}

module.exports = { acharClaude, candidatosClaude, candidatosDaExtensao,
                   compararVersao, rotuloExe, interpretar, sondar,
                   garantirFresco, garantirFrescoHook, ARGS, PEDIDO, MARCA, PAUSA_FALHA_S };
