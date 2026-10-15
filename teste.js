#!/usr/bin/env node
'use strict';
/*
 * teste.js — exercita a ferramenta inteira em diretório temporário, com um
 * claude FALSO no lugar do de verdade. Não encosta no seu estado real, não
 * usa rede e não gasta cota.
 *
 *   node teste.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', cy: '\x1b[36m',
            g: '\x1b[32m', v: '\x1b[31m' };

let falhas = 0;
function ok(cond, label) {
  console.log((cond ? C.g + '  PASS  ' : C.v + '  FALHA ') + C.r + label);
  if (!cond) falhas++;
}
const secao = t => console.log('\n' + C.cy + C.b + t + C.r);
const novaPasta = nome => fs.mkdtempSync(path.join(os.tmpdir(), 'cota-' + nome + '-'));
const semCor = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const WIN = process.platform === 'win32';

const NOW = Math.floor(Date.now() / 1000);
// Reset fixo na hora cheia, como o servidor, e igual em todas as chamadas do
// teste: senão uma rodada que cruzasse a hora veria "janela nova" no meio.
const BASE_MS = Math.ceil(Date.now() / 3600000) * 3600000;
const resetFalso = h => BASE_MS / 1000 + h * 3600;

/*
 * Claude falso. Nenhum teste pode chegar no claude de verdade: seria lento,
 * dependeria de rede e de login. Com COTA_CLAUDE definido, a sonda usa só
 * ele. Por padrão ele FALHA; `COTA_FALSO` escolhe outro roteiro.
 */
const FALSO_DIR = novaPasta('claude-falso');
const FALSO = path.join(FALSO_DIR, 'claude-falso.js');
fs.writeFileSync(FALSO, `
const fs = require('fs');
const modo = process.env.COTA_FALSO || 'falha';
const p5 = Number(process.env.COTA_FALSO_P5 || 42), p7 = Number(process.env.COTA_FALSO_P7 || 17);
const r5 = Number(process.env.COTA_FALSO_R5 || 2);
const base = Number(process.env.COTA_FALSO_BASE);
let entrada = ''; try { entrada = fs.readFileSync(0, 'utf8'); } catch (_) {}
if (process.env.COTA_FALSO_ARGS) fs.writeFileSync(process.env.COTA_FALSO_ARGS, JSON.stringify(
  { args: process.argv.slice(2), marca: process.env.COTA_SONDA_ATIVA || null, cwd: process.cwd(), entrada }));
if (process.env.COTA_FALSO_DORME) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.COTA_FALSO_DORME));
if (modo === 'falha') { process.stderr.write('claude falso: sem roteiro'); process.exit(1); }
if (modo === 'mudo') process.exit(0);
let pedido = {}; try { pedido = JSON.parse(entrada.split('\\n')[0]); } catch (_) {}
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
const responde = r => out({ type: 'control_response', response: Object.assign({ request_id: pedido.request_id }, r) });
// Como o CLI de verdade: pedido que ele não conhece volta como erro.
if (modo === 'recusa' || (pedido.request || {}).subtype !== 'get_usage') {
  responde({ subtype: 'error', error: 'Unknown control request subtype: ' + (pedido.request || {}).subtype });
  process.exit(0);
}
const em = h => new Date(base + h * 3600000 + 0.4).toISOString();
if (modo === 'sem-plano') responde({ subtype: 'success', response:
  { subscription_type: null, rate_limits_available: false, rate_limits: null } });
if (modo === 'ok') responde({ subtype: 'success', response: { subscription_type: 'max', rate_limits_available: true,
  rate_limits: { limits: [
    { kind: 'session', percent: p5, resets_at: em(r5) },
    { kind: 'weekly_all', percent: p7, resets_at: em(100) },
    { kind: 'weekly_scoped', percent: 3, resets_at: em(100), scope: { model: { display_name: 'Fable' } } },
  ] } } });
`);

const TMP = novaPasta('teste');
const ENV = Object.assign({}, process.env,
  { CLAUDE_COTA_DIR: TMP, COTA_CLAUDE: FALSO, COTA_FALSO_BASE: String(BASE_MS) });
for (const k of ['COTA_FALSO', 'COTA_FALSO_P5', 'COTA_FALSO_ARGS', 'COTA_SONDA_ATIVA']) delete ENV[k];

// Módulos carregados aqui dentro escrevem numa pasta própria, nunca no real.
process.env.CLAUDE_COTA_DIR = novaPasta('inproc');
process.env.COTA_CLAUDE = FALSO;
const core = require('./lib/core');
const an = require('./lib/analise');
const sonda = require('./lib/sonda');

const cli = (args, envExtra) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, 'cota.js')].concat(args),
      { encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
const cliCod = (args, envExtra) => {
  try {
    return { out: execFileSync(process.execPath, [path.join(__dirname, 'cota.js')].concat(args),
      { encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) }), cod: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), cod: e.status }; }
};
const hook = (arquivo, ev, envExtra) => execFileSync(
  process.execPath, [path.join(__dirname, 'hooks', arquivo)],
  { input: JSON.stringify(ev), encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) });

const lerEm = dir => f => core.lerJson(path.join(dir, f), null);
const lerLEm = dir => f => core.lerJsonl(path.join(dir, f));
const listarEm = (dir, sub) => { try { return fs.readdirSync(path.join(dir, sub)).filter(n => n.endsWith('.json')); } catch (_) { return []; } };
const estadoEm = dir => o => fs.writeFileSync(path.join(dir, 'estado.json'), JSON.stringify(
  Object.assign({ t: NOW, pct5: 30, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }, o)));

console.log('\n' + C.cy + C.b + 'cota — teste de ponta a ponta' + C.r + C.d + '  (' + TMP + ')' + C.r);

/* ------------------------------ janelas ------------------------------ */
secao('estados de uma leitura (D4/D5)');

const cfg = core.CONFIG_PADRAO;
const j = (pct, reset, idade, mono) =>
  core.avaliarJanela(pct, reset, NOW - idade, cfg, NOW, mono !== false);

ok(j(50, NOW + 3600, 10).estado === 'fresco', 'leitura recente = fresco');
ok(j(50, NOW + 3600, 5000).estado === 'piso', 'leitura velha (sonda falhando), janela viva = piso');
ok(j(50, NOW + 3600, 5000).pctParaDecidir === 50, 'piso serve para decidir (limite inferior)');
ok(j(99, NOW - 3600, 90000).estado === 'expirado', 'janela virou = expirado');
ok(j(99, NOW - 3600, 90000).pctParaDecidir === null, 'expirado NÃO vale 99% nem 0%');
ok(j(50, NOW + 3600, 5000, false).estado === 'desconhecido', 'monotonia violada mata o piso (D5)');
ok(core.monotoniaOk([{ t: 1, pct5: 60, reset5: 9 }, { t: 2, pct5: 40, reset5: 9 }], 'pct5', 'reset5', 9) === false,
   'detecta queda de percentual dentro da janela');

/* ------------------------------- ritmo ------------------------------- */
secao('ritmo é medição, não projeção (D13/D28)');

const hist = [
  { t: NOW - 3600, pct5: 20, reset5: NOW + 3 * 3600 },
  { t: NOW,        pct5: 60, reset5: NOW + 3 * 3600 },
];
const r5 = an.ritmo(hist, 'pct5', 'reset5', NOW + 3 * 3600);
ok(Math.abs(r5.pctPorHora - 40) < 0.01, 'ritmo = 40%/h');
ok(Math.abs(r5.deltaHoras - 1) < 0.01, 'e diz sobre quanto tempo mediu');
ok(an.ritmo(hist, 'pct5', 'reset5', NOW + 99999).amostras === 0, 'janela nova ignora a anterior');
// Regressão real: 27s entre leituras com 1 ponto de diferença viravam 133%/h.
const rCurto = an.ritmo([{ t: NOW - 27, pct5: 10, reset5: 1 }, { t: NOW, pct5: 11, reset5: 1 }], 'pct5', 'reset5', 1);
ok(rCurto.pctPorHora === null && /27s/.test(rCurto.motivo || ''), 'intervalo curto não vira ritmo, e diz por quê');
// D28 — a projeção saiu inteira; a ausência é o teste.
ok(typeof an.projecao === 'undefined', 'analise.js não exporta projeção');
ok(!/estouraAntesDoReset/.test(fs.readFileSync(path.join(__dirname, 'cota.js'), 'utf8')),
   'cota.js não fala em estouro previsto');

/* ------------------------------ admissão ------------------------------ */
secao('admissão — a conta da missão (D15/D16)');

const janelas = { cinco: j(60, NOW + 3 * 3600, 10), sete: j(35, NOW + 4 * 86400, 10) };
const custos = an.custoPorTipo([
  { tipo: 'Explore', custo5: 2, custo7: 0.2 },
  { tipo: 'Explore', custo5: 2, custo7: 0.2 },
]);
// restante 5h = 40%, orçamento = 40 × 0.7 = 28%. Cada agente custa 2%.
const a5 = an.admissao({ janelas, custos, cfg, n: 5, tipo: 'Explore', nowS: NOW });
ok(a5.veredito === 'vai' && a5.quantosCabem === 14, '5 × 2% de 28% → vai, e cabem 14');
const a20 = an.admissao({ janelas, custos, cfg, n: 20, tipo: 'Explore', nowS: NOW });
ok(a20.veredito === 'nao_cabe', '20 agentes = 40% → não cabe');
ok(a20.esperarAte === NOW + 3 * 3600, 'sugere esperar o reset da 5h (D16)');

const semanalRuim = { cinco: j(10, NOW + 3 * 3600, 10), sete: j(95, NOW + 4 * 86400, 10) };
const aSem = an.admissao({ janelas: semanalRuim, custos, cfg, n: 20, tipo: 'Explore', nowS: NOW });
ok(aSem.janelaCritica === '7d' && aSem.veredito === 'nao_cabe', 'obedece a janela mais apertada (D15)');
ok(aSem.esperarAte === null, 'e não sugere esperar a 5h quando quem barra é a semanal');
ok(an.admissao({ janelas, custos: {}, cfg, n: 5, nowS: NOW }).veredito === 'sem_base',
   'sem amostra → SEM BASE, não recusa');
const expirada = { cinco: j(99, NOW - 10, 90000), sete: j(99, NOW - 10, 90000) };
ok(an.admissao({ janelas: expirada, custos, cfg, n: 5, nowS: NOW }).veredito === 'sem_dado',
   'janela expirada não vira decisão baseada em 99% velho');

/* -------------------------------- ondas -------------------------------- */
secao('onda em vez de salva (D29)');

const custosOnda = { __geral: { n: 5, media5: 1.2, media7: 0.1 } };
const admOnda = (pct, n) => an.admissao({
  janelas: { cinco: j(pct, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: custosOnda, cfg: { admissao: { margem: 0.7 } }, n, nowS: NOW });

const folga = admOnda(20, 10);
ok(folga.onda.tamanho === 10 && folga.onda.restantes === 0, 'com folga, a onda é o pedido inteiro');
const meio = admOnda(60, 10);
ok(meio.onda.tamanho < 10 && meio.onda.tamanho >= 1, 'apertando, parte em ondas — nunca de zero');
ok(meio.onda.tamanho * meio.janelas.cinco.custoUnit <= meio.janelas.cinco.orcamento * 0.25 + 0.01,
   'uma onda custa no máximo 1/4 do orçamento da janela crítica');
ok(admOnda(85, 10).veredito === 'nao_cabe' && admOnda(85, 10).onda === null,
   'reprovado não ganha onda de consolação');
const cega = an.admissao({
  janelas: { cinco: j(20, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: {}, cfg: { admissao: { margem: 0.7 } }, n: 10, nowS: NOW });
ok(cega.onda && cega.onda.tamanho === 2 && /medir/.test(cega.onda.porque || ''),
   'sem base, uma onda pequena cujo propósito é medir');

/* ------------------------- base de custo (D32) ------------------------- */
secao('base de custo — média agrupada (D32)');

// Onda A: n=2, Δ=10 → 5 cada.  Onda B: n=8, Δ=8 → 1 cada.
// Média de médias daria 3; agrupada dá 18/10 = 1.8.
const agrupada = an.custoPorTipo([].concat(
  Array.from({ length: 2 }, () => ({ tipo: 'X', custo5: 5, custo7: 0 })),
  Array.from({ length: 8 }, () => ({ tipo: 'X', custo5: 1, custo7: 0 }))));
ok(Math.abs(agrupada.__geral.media5 - 1.8) < 0.001, 'média agrupada (1.8), não média de médias (3)');
// Onda curta mede 0% e entra assim mesmo: zero é "abaixo da resolução".
const comZero = an.custoPorTipo([{ custo5: 0 }, { custo5: 0 }, { custo5: 3 }, { custo5: 3 }]);
ok(Math.abs(comZero.__geral.media5 - 1.5) < 0.001, 'onda que mediu 0% entra na média, não some');
const tudoZero = an.admissao({
  janelas: { cinco: j(50, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: an.custoPorTipo([{ tipo: 'X', custo5: 0, custo7: 0 }]),
  cfg: { admissao: { margem: 0.7 } }, n: 5, nowS: NOW });
ok(/curtas demais|inteiro/.test(tudoZero.motivo || ''),
   'tudo zero é explicado pela resolução do percentual, não pela janela');

/* -------------------------- sonda: interpretar -------------------------- */
secao('sonda: a cota lida pelo protocolo de controle (D39)');

const linhaJ = o => JSON.stringify(o);
const daqui = h => new Date((NOW + h * 3600) * 1000).toISOString();
const resposta = (r, id) => linhaJ({ type: 'control_response', response: Object.assign({ request_id: id || 'cota' }, r) });
const comLimites = limits => resposta({ subtype: 'success', response:
  { subscription_type: 'max', rate_limits_available: true, rate_limits: { limits } } });
// Formato real, capturado do get_usage do Claude Code 2.1.300, com os números trocados.
const saidaReal = resposta({ subtype: 'success', response: {
  session: { total_cost_usd: 0 }, subscription_type: 'max', rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 88, resets_at: daqui(1) }, seven_day: { utilization: 25, resets_at: daqui(150) },
    limits: [
      { kind: 'session', group: 'session', percent: 88, resets_at: daqui(1), severity: 'warning', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 25, resets_at: daqui(150), severity: 'normal', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: daqui(150),
        scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
    ] } } });

const ri = sonda.interpretar(saidaReal, NOW);
ok(ri.ok && ri.snap.pct5 === 88 && ri.snap.pct7 === 25, 'session vira a janela de 5h, weekly_all a semanal');
ok(ri.snap.reset5 === Math.round((NOW + 3600) / 60) * 60, 'resets_at ISO vira epoch absoluto (D10)');
ok(ri.snap.modelos.length === 1 && ri.snap.modelos[0].nome === 'Fable', 'e traz o sub-limite por modelo');
ok(ri.plano === 'max' && ri.snap.plano === 'max', 'e o plano da conta');

// Ruído real do servidor: o mesmo reset veio como 10:59:59.506 e 11:00:00.
const resetDe = ms => sonda.interpretar(comLimites(
  [{ kind: 'session', percent: 1, resets_at: new Date(ms).toISOString() }]), NOW).snap.reset5;
ok(resetDe(BASE_MS - 494) === resetDe(BASE_MS), 'reset com ruído de fração de segundo vira o mesmo minuto');

ok(!sonda.interpretar(resposta({ subtype: 'success', response: {} }, 'outro'), NOW).ok,
   'resposta a outro pedido (outro request_id) não vale');
const rv = sonda.interpretar('', NOW);
ok(!rv.ok && /não respondeu ao get_usage/.test(rv.erro), 'sem resposta: diz que o claude não respondeu, não inventa número');
const re = sonda.interpretar(resposta({ subtype: 'error', error: 'Unknown control request subtype: get_usage' }), NOW);
ok(!re.ok && /recusou o get_usage/.test(re.erro) && /protocolo mudou/.test(re.erro),
   'pedido recusado: diz que o protocolo mudou nesta versão');
const rn = sonda.interpretar(resposta({ subtype: 'success', response:
  { subscription_type: null, rate_limits_available: false, rate_limits: null } }), NOW);
ok(!rn.ok && /Pro ou Max/.test(rn.erro), 'sem limite de plano: aponta conta sem Pro ou Max');
const rk = sonda.interpretar(comLimites([{ kind: 'janela_nova', percent: 5 }]), NOW);
ok(!rk.ok && /janela_nova/.test(rk.erro), 'janela de nome desconhecido: lista o que veio');
// Texto de fora vai parar na saída que o agente lê: só o necessário, e curto.
const rs = sonda.interpretar(comLimites([
  { kind: 'session', percent: 1 },
  { kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'Fable\u001b[31m <script>' + 'x'.repeat(80) } } },
]), NOW);
ok(rs.ok && !/[\u001b<>]/.test(rs.snap.modelos[0].nome) && rs.snap.modelos[0].nome.length <= 40,
   'nome vindo do servidor perde caractere de controle e marcação, e é cortado');

/* ------------------------ sonda: achar o claude ------------------------ */
secao('o claude da extensão muda de pasta a cada atualização (D43, D45)');

ok(sonda.compararVersao('2.1.300', '2.1.99') > 0, 'versão comparada como número, não texto');
const HOMEF = novaPasta('home');
const EXT = path.join(HOMEF, '.vscode', 'extensions');
const exeNome = WIN ? 'claude.exe' : 'claude';
const pastaV = v => `anthropic.claude-code-${v}-win32-x64`;
const versao = (v, raiz) => {
  const d = path.join(raiz || EXT, pastaV(v), 'resources', 'native-binary');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, exeNome), '');
};
const acharF = () => sonda.acharClaude({ PATH: '' }, HOMEF) || '';

versao('2.1.99'); versao('2.1.300');
ok(/2\.1\.300/.test(acharF()), 'acha o claude embutido na extensão, na versão mais nova');
versao('2.1.400');
ok(/2\.1\.400/.test(acharF()), 'a extensão atualizou: a próxima sonda já acha a pasta nova');
// A pasta velha FICA no disco, marcada em .obsolete, até o VS Code limpar.
fs.writeFileSync(path.join(EXT, '.obsolete'), JSON.stringify({ [pastaV('2.1.400')]: true }));
ok(/2\.1\.300/.test(acharF()), 'pasta marcada em .obsolete é ignorada, mesmo sendo a mais alta');
fs.writeFileSync(path.join(EXT, 'extensions.json'), JSON.stringify([
  { identifier: { id: 'outro.qualquer' }, version: '9.9.9', relativeLocation: 'outro' },
  { identifier: { id: 'anthropic.claude-code' }, version: '2.1.99', relativeLocation: pastaV('2.1.99') },
]));
const cands = sonda.candidatosClaude({ PATH: '' }, HOMEF);
ok(/2\.1\.99/.test(cands[0] || ''), 'a versão registrada no extensions.json vem primeiro');
ok(cands.length === 2 && /2\.1\.300/.test(cands[1]), 'e as outras pastas válidas ficam de reserva');
fs.writeFileSync(path.join(EXT, 'extensions.json'), JSON.stringify([
  { identifier: { id: 'anthropic.claude-code' }, version: '2.1.500', relativeLocation: pastaV('2.1.500') },
]));
ok(/2\.1\.300/.test(acharF()), 'atualização em curso (registro sem binário) cai na varredura');
const locPath = path.join(EXT, pastaV('2.1.99'));
fs.writeFileSync(path.join(EXT, 'extensions.json'), JSON.stringify([
  { identifier: { id: 'anthropic.claude-code' }, version: '2.1.99',
    location: { scheme: 'file', path: WIN ? '/' + locPath.replace(/\\/g, '/') : locPath } },
]));
ok(/2\.1\.99/.test(acharF()), 'entende o `location` do registro, inclusive "/c:/..." do Windows');
// D45 — o registro não pode apontar para fora da pasta de extensões.
const FORA = novaPasta('fora');
versao('9.9.9', FORA);
fs.writeFileSync(path.join(EXT, 'extensions.json'), JSON.stringify([
  { identifier: { id: 'anthropic.claude-code' }, version: '9.9.9',
    relativeLocation: path.relative(EXT, path.join(FORA, pastaV('9.9.9'))) },
]));
ok(!/9\.9\.9/.test(acharF()), 'registro apontando para fora de extensions/ é ignorado (D45)');
// D45 — entrada relativa no PATH ("."), que resolveria no repositório aberto.
const REPO = novaPasta('repo-hostil');
fs.writeFileSync(path.join(REPO, exeNome), '');
const cwdAntes = process.cwd();
process.chdir(REPO);
const viaPonto = sonda.candidatosClaude({ PATH: '.' }, novaPasta('home-vazio'));
process.chdir(cwdAntes);
ok(viaPonto.length === 0, 'entrada relativa no PATH é ignorada: claude plantado num repo não roda (D45)');
ok(sonda.acharClaude({ PATH: '', COTA_CLAUDE: path.join(HOMEF, 'nao-existe') }, HOMEF) === null,
   'COTA_CLAUDE errado dá "não achei", e não cai calado em outro claude');

/* ------------------------ sonda: ponta a ponta ------------------------ */
secao('sonda ponta a ponta, com o claude falso (D39–D43)');

const TMPS = novaPasta('sonda');
const ARGSF = path.join(TMPS, '_args.json');
const ENVS = { CLAUDE_COTA_DIR: TMPS, COTA_FALSO: 'ok', COTA_FALSO_ARGS: ARGSF };
const lerS = lerEm(TMPS);

const s1 = cli([], ENVS);
ok(/42\.0%/.test(s1) && /plano max/.test(s1), 'sem leitura nenhuma, o `cota` lê sozinho e responde');
ok(/Fable 3%/.test(s1), 'e mostra o sub-limite semanal por modelo');
ok(!/status line|\/loop|terminal/i.test(s1), 'sem falar em status line, terminal ou loop (D44)');
const rec = core.lerJson(ARGSF, { args: [] });
let pedidoRec = {}; try { pedidoRec = JSON.parse(rec.entrada); } catch (_) {}
ok(rec.args.join(' ').includes('-p --input-format stream-json --output-format stream-json'),
   'fala com o claude pelo protocolo de controle, em stream-json');
ok(pedidoRec.type === 'control_request' && pedidoRec.request.subtype === 'get_usage',
   'e pede get_usage — não manda prompt nenhum');
ok(pedidoRec.request.skip_behaviors === true, 'pulando a análise dos logs, que só atrasaria');
ok(!rec.args.some(a => a === '/usage' || a === '--model'), 'sem /usage e sem modelo: não há turno para gastar cota');
ok(rec.args.includes('--no-session-persistence'), 'sem gravar sessão — não suja sua lista de conversas');
ok(rec.args.some(a => /disableAllHooks/.test(a)), 'com os hooks desligados na sessão da sonda');
ok(rec.args.join(' ').includes('--setting-sources user'),
   'só com as SUAS configurações — nunca as de projeto do diretório (D45)');
ok(path.resolve(rec.cwd) === path.resolve(TMPS), 'rodando na pasta de estado, não na temporária do sistema (D45)');
ok(rec.marca === '1', 'e marcando o processo filho contra recursão');

fs.unlinkSync(ARGSF);
cli(['cabe', '3'], ENVS);
ok(!fs.existsSync(ARGSF), 'leitura de menos de 60s não sonda de novo (D40)');

estadoEm(TMPS)({ t: NOW - 999 });
cli([], Object.assign({}, ENVS, { COTA_SONDA_ATIVA: '1' }));
ok(!fs.existsSync(ARGSF), 'de dentro da própria sonda, não sonda de novo (recursão)');

// Os erros do protocolo viram mensagem com o que faltou — nunca número.
const sRec = cli(['sondar'], Object.assign({}, ENVS, { COTA_FALSO: 'recusa' }));
ok(/recusou o get_usage/.test(sRec) && /protocolo mudou/.test(sRec), 'claude que não conhece o get_usage: diz que o protocolo mudou');
ok(/não respondeu ao get_usage/.test(cli(['sondar'], Object.assign({}, ENVS, { COTA_FALSO: 'mudo' }))),
   'claude que sai sem responder: diz isso');
ok(/Pro ou Max/.test(cli(['sondar'], Object.assign({}, ENVS, { COTA_FALSO: 'sem-plano' }))),
   'conta sem plano: diz que precisa de Pro ou Max');
cli(['sondar'], Object.assign({}, ENVS, { COTA_FALSO_P5: '50' }));
ok(lerS('sonda.json').ok === true && lerS('estado.json').pct5 === 50, 'e volta a ler assim que o claude responde');
ok(core.lerJsonl(path.join(TMPS, 'historico.jsonl')).length >= 2, 'e cada número novo entra no histórico');

// A trava: N hooks juntos não viram N processos do claude.
const garantir = esperar => JSON.parse(execFileSync(process.execPath, ['-e',
  `const s=require(process.argv[1]);console.log(JSON.stringify(s.garantirFresco(0,{esperar:${esperar}})))`,
  path.join(__dirname, 'lib', 'sonda.js')],
  { encoding: 'utf8', env: Object.assign({}, ENV, ENVS, { COTA_FALSO_P5: '50' }) }));
estadoEm(TMPS)(Object.assign({}, lerS('estado.json'), { t: NOW - 999 }));
fs.writeFileSync(path.join(TMPS, 'sonda.trava'), '');
ok(garantir(false).motivo === 'outra sonda em curso', 'com outra sonda em curso, não dispara a segunda');
const velha = new Date(Date.now() - 120000);
fs.utimesSync(path.join(TMPS, 'sonda.trava'), velha, velha);
ok(garantir(false).sondou === true, 'trava velha (processo que morreu) é descartada');
ok(!fs.existsSync(path.join(TMPS, 'sonda.trava')), 'e a trava é sempre removida no fim');

// Candidato que nem executa (pasta apagada pela limpeza do VS Code, binário
// pela metade): a sonda passa ao próximo em vez de falhar.
const TMPX = novaPasta('sonda-troca');
const quebrado = path.join(TMPX, 'quebrado.exe');
fs.writeFileSync(quebrado, '');
const viaX = lista => cli(['sondar'], { CLAUDE_COTA_DIR: TMPX, COTA_FALSO: 'ok',
                                        COTA_CLAUDE: lista.join(path.delimiter) });
const sx = viaX([quebrado, FALSO]);
ok(/sonda ok/.test(sx) && /pulados/.test(sx) && /quebrado/.test(sx),
   'o primeiro candidato não executa: tenta o próximo, e diz qual pulou');
// Detectar a troca de pasta, não só sobreviver a ela.
const falsoEm = v => {
  const d = path.join(TMPX, pastaV(v));
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(FALSO, path.join(d, 'claude-falso.js'));
  return path.join(d, 'claude-falso.js');
};
viaX([falsoEm('2.1.299')]);
const trocou = viaX([falsoEm('2.1.300')]);
ok(/2\.1\.299/.test(lerEm(TMPX)('sonda.json').exe_anterior || ''), 'a troca fica registrada');
ok(lerEm(TMPX)('sonda.json').versao === '2.1.300', 'e a versão do Claude Code sai do nome da pasta da extensão');
ok(/mudou de extensão 2\.1\.299/.test(trocou), 'e o `cota sondar` diz em voz alta que o claude mudou');

/* ------------------------------- medidor ------------------------------- */
secao('medidor: o custo medido em trechos, pelo tempo de cada subagente (D47)');

const TMPM = novaPasta('medidor');
const ENVM = { CLAUDE_COTA_DIR: TMPM, COTA_FALSO: 'ok' };
const lerLM = lerLEm(TMPM);
const ev = (tipo, id) => ({ hook_event_name: tipo, agent_id: id, agent_type: 'Explore', session_id: 's' });
const med = (tipo, id, extra) => hook('medidor.js', ev(tipo, id), Object.assign({}, ENVM, extra || {}));
// Reescreve os inícios para o passado, para o tempo de cada um ser conhecido.
const recuar = (dir, ids, s) => {
  for (const id of ids) {
    const p = path.join(dir, 'em-voo', id + '.json');
    fs.writeFileSync(p, JSON.stringify(Object.assign(core.lerJson(p, {}), { t0_ms: Date.now() - s * 1000 })));
  }
  const pm = path.join(dir, 'marco.json');
  fs.writeFileSync(pm, JSON.stringify(Object.assign(core.lerJson(pm, {}),
    { t_ms: Date.now() - s * 1000, cadeia_ms: Date.now() - s * 1000 })));
};
const amostras = () => lerLM('agentes.jsonl');
const perto = (a, b) => Math.abs(a - b) < 0.15;

// Um sozinho: o trecho vai do início ao fim dele.
med('SubagentStart', 'a1', { COTA_FALSO_P5: '20' });
ok(lerEm(TMPM)('marco.json').pct5 === 20, 'o primeiro SubagentStart lê a cota e abre a cadeia com um marco');
med('SubagentStop', 'a1', { COTA_FALSO_P5: '23' });
ok(amostras().length === 1 && amostras()[0].custo5 === 3, 'sozinho, ele custa o que a cota subiu (20% → 23%)');
ok(!fs.existsSync(path.join(TMPM, 'marco.json')), 'e com o céu vazio a cadeia termina');

// Dois juntos, o mesmo tempo: o trecho é dividido pela metade.
med('SubagentStart', 'b1', { COTA_FALSO_P5: '23' }); med('SubagentStart', 'b2');
recuar(TMPM, ['b1', 'b2'], 60);
med('SubagentStop', 'b2', { COTA_FALSO_P5: '27' });
ok(amostras().length === 1, 'trecho curto: quem termina não lê a cota, e a parte dele sai no próximo marco');
med('SubagentStop', 'b1', { COTA_FALSO_P5: '31' });
const ab = amostras().slice(-2);
ok(ab.length === 2 && perto(ab[0].custo5, 4) && perto(ab[1].custo5, 4),
   'o último a sair fecha o trecho, e 8% pelos mesmos 60s dão ~4% a cada um');
ok(ab.every(a => a.atribuicao === 'tempo'), 'marcados como divisão por tempo — não se sabe quem gastou o quê');

// Tempos diferentes no mesmo trecho: a divisão segue o tempo de cada um.
med('SubagentStart', 'c1', { COTA_FALSO_P5: '31' }); med('SubagentStart', 'c2');
recuar(TMPM, ['c1'], 90); recuar(TMPM, ['c2'], 30);
const pm = path.join(TMPM, 'marco.json');
fs.writeFileSync(pm, JSON.stringify(Object.assign(core.lerJson(pm, {}), { t_ms: Date.now() - 90000, cadeia_ms: Date.now() - 90000 })));
med('SubagentStop', 'c2', { COTA_FALSO_P5: '39' });
med('SubagentStop', 'c1', { COTA_FALSO_P5: '39' });
const porDur = amostras().slice(-2).sort((x, y) => x.dur_s - y.dur_s);
ok(perto(porDur[0].custo5, 2) && perto(porDur[1].custo5, 6), '90s contra 30s no mesmo trecho: 8% vira ~6% e ~2%');

// A onda parcial: o curto é medido sem esperar o longo terminar.
med('SubagentStart', 'longo', { COTA_FALSO_P5: '39' }); med('SubagentStart', 'curto');
recuar(TMPM, ['longo', 'curto'], 200);
med('SubagentStop', 'curto', { COTA_FALSO_P5: '43' });
const curto = amostras().pop();
ok(curto.tipo === 'Explore' && perto(curto.custo5, 2) && fs.existsSync(path.join(TMPM, 'em-voo', 'longo.json')),
   'trecho de mais de 2min: quem termina fecha o trecho e é medido na hora (~2%), com o outro ainda rodando');
ok(core.lerJson(path.join(TMPM, 'acumulado', 'longo.json'), {}).s5 > 1.9,
   'e a parte do que continua rodando fica guardada');
med('SubagentStop', 'longo', { COTA_FALSO_P5: '45' });
ok(perto(amostras().pop().custo5, 4), 'quando ele termina, o custo é a soma das partes (2% + 2%)');

// Sem leitura nova no fechamento: nada de custo zero inventado.
med('SubagentStart', 'd1', { COTA_FALSO_P5: '45' });
const antesD = amostras().length;
med('SubagentStop', 'd1', { COTA_FALSO: 'falha' });
ok(amostras().length === antesD, 'a leitura do fechamento falhou: nenhuma amostra é gravada');
ok(!fs.existsSync(path.join(TMPM, 'marco.json')) && listarEm(TMPM, 'terminados').length === 0,
   'e com o céu vazio nada fica para trás (#13)');
cli(['sondar'], Object.assign({}, ENVM, { COTA_FALSO_P5: '45' }));   // tira a pausa de falha (#1)

// A janela virou no meio: o Δ é reset, não custo.
med('SubagentStart', 'e1', { COTA_FALSO_P5: '45' });
med('SubagentStop', 'e1', { COTA_FALSO_P5: '2', COTA_FALSO_R5: '5' });
ok(amostras().length === antesD, 'janela que virou no meio do trecho não vira amostra');

// A cadeia perdida (achado real): alguém já rodava sem marco nenhum.
fs.writeFileSync(path.join(TMPM, 'em-voo', 'antigo.json'),
  JSON.stringify({ tipo: 'Explore', sessao: 'outra', t0_ms: Date.now() - 600000 }));
med('SubagentStart', 'novo', { COTA_FALSO_P5: '5', COTA_FALSO_R5: '5' });
ok(fs.existsSync(path.join(TMPM, 'marco.json')), 'sem marco, mesmo com gente em voo, quem começa abre uma cadeia nova');
recuar(TMPM, ['novo'], 30);
const pmN = core.lerJson(path.join(TMPM, 'marco.json'), {});
fs.writeFileSync(path.join(TMPM, 'marco.json'), JSON.stringify(Object.assign(pmN, { cadeia_ms: Date.now() - 30000 })));
med('SubagentStop', 'novo', { COTA_FALSO_P5: '7', COTA_FALSO_R5: '5' });
med('SubagentStop', 'antigo', { COTA_FALSO_P5: '9', COTA_FALSO_R5: '5' });
const tipos = amostras().slice(antesD).map(a => a.sessao);
ok(tipos.length === 1 && tipos[0] === 's',
   'quem começou antes da cadeia não vira amostra (custo subcontado); quem começou depois, sim');

// D25 — órfão: o SubagentStop nunca veio.
fs.writeFileSync(path.join(TMPM, 'em-voo', 'orfao.json'), JSON.stringify({ tipo: 'X', t0_ms: Date.now() - 99999000 }));
med('SubagentStart', 'f1');
ok(!fs.existsSync(path.join(TMPM, 'em-voo', 'orfao.json')), 'órfão de mais de 2h é varrido (D25)');
med('SubagentStop', 'f1', { COTA_FALSO_P5: '9', COTA_FALSO_R5: '5' });

// Desligada (D2): não mede, não lê, e não deixa nada para trás.
fs.writeFileSync(path.join(TMPM, 'config.json'), JSON.stringify({ ligado: false }));
const nDesl = amostras().length;
med('SubagentStart', 'g1'); med('SubagentStop', 'g1');
ok(amostras().length === nDesl && !fs.existsSync(path.join(TMPM, 'marco.json')) &&
   listarEm(TMPM, 'em-voo').length === 0, 'desligada, não mede e não deixa nada para trás');
fs.writeFileSync(path.join(TMPM, 'config.json'), JSON.stringify({ ligado: true }));

/* --------------------- concorrência (D33) --------------------- */
secao('N hooks ao mesmo tempo (D33)');

/*
 * Medido na primeira versão: com a lista de participantes num arquivo único,
 * 16 hooks simultâneos perdiam 9. Cada um grava só os próprios arquivos.
 */
const TMPC = novaPasta('corrida');
const ENVC = { CLAUDE_COTA_DIR: TMPC, COTA_FALSO: 'ok' };
cli(['sondar'], Object.assign({}, ENVC, { COTA_FALSO_P5: '10' }));
const CONDUTOR = path.join(TMPC, '_condutor.js');
fs.writeFileSync(CONDUTOR, [
  "// Dispara N hooks de uma vez, num processo próprio: o teste é síncrono e",
  "// bloquearia o stdin dos filhos.",
  "const { spawn } = require('child_process');",
  "const ids = JSON.parse(process.argv[2]);",
  "Promise.all(ids.map(id => new Promise(res => {",
  "  const c = spawn(process.execPath, [process.argv[3]], { stdio: ['pipe', 'ignore', 'ignore'] });",
  "  c.stdin.end(JSON.stringify({ hook_event_name: process.argv[4], agent_id: id,",
  "                               agent_type: 'Explore', session_id: 's' }));",
  "  c.on('close', () => res());",
  "}))).then(() => process.exit(0));",
].join('\n'));
const N = 12;
const ids = Array.from({ length: N }, (_, i) => 'c' + i);
execFileSync(process.execPath, [CONDUTOR, JSON.stringify(ids), path.join(__dirname, 'hooks', 'medidor.js'), 'SubagentStart'],
  { env: Object.assign({}, ENV, ENVC), encoding: 'utf8', timeout: 60000 });
ok(listarEm(TMPC, 'em-voo').length === N, `os ${N} subagentes simultâneos foram todos registrados`);
ok(fs.existsSync(path.join(TMPC, 'marco.json')), 'com um marco só para todos');
ok(fs.readdirSync(TMPC).filter(n => n.endsWith('.tmp')).length === 0, 'e nenhum .tmp órfão ficou');
recuar(TMPC, ids, 60);
for (const id of ids) hook('medidor.js', ev('SubagentStop', id), Object.assign({}, ENVC, { COTA_FALSO_P5: '22' }));
const amC = lerLEm(TMPC)('agentes.jsonl');
ok(amC.length === N && Math.abs(amC.reduce((s, a) => s + a.custo5, 0) - 12) < 0.001,
   `os ${N} viraram amostra, e as partes somam o Δ inteiro (10% → 22%)`);
ok(amC.every(a => Math.abs(a.custo5 - 1) < 0.1), 'cerca de 1% por subagente, pelos mesmos 60s');

const tmpVelho = path.join(TMPC, 'estado.json.9999.tmp');
const tmpNovo = path.join(TMPC, 'estado.json.8888.tmp');
fs.writeFileSync(tmpVelho, '{}'); fs.writeFileSync(tmpNovo, '{}');
fs.utimesSync(tmpVelho, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
execFileSync(process.execPath, ['-e', 'require(process.argv[1]).limparTmp(300)',
  path.join(__dirname, 'lib', 'core.js')], { env: Object.assign({}, ENV, ENVC) });
ok(!fs.existsSync(tmpVelho) && fs.existsSync(tmpNovo), 'limparTmp remove .tmp velho e preserva o recente');

/* --------------------------- aviso e admissão --------------------------- */
secao('aviso (UserPromptSubmit) e admissão (PreToolUse)');

const est = estadoEm(TMP);
const lerT = lerEm(TMP);
est({ pct5: 30 });
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '', 'abaixo do limiar não injeta nada (D3)');
est({ pct5: 88 });
const av = hook('aviso.js', { hook_event_name: 'UserPromptSubmit' });
ok(/additionalContext/.test(av) && /88\.0%/.test(av) && /reseta em/.test(av), 'acima do limiar: percentual E reset');
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '', 'não repete dentro do intervalo');
ok(/^5h:\d+:\d+$/.test((lerT('aviso-ultimo.json') || {}).assinatura || ''),
   'assinatura feita de fatos estáveis, não do texto com countdown');
est({ pct5: 95 });
ok(/additionalContext/.test(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' })),
   'subir de faixa (88% → 95%) volta a avisar');
const adm = hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' });
ok(/"permissionDecision":\s*"ask"/.test(adm) && !/deny/.test(adm), 'PreToolUse pergunta, nunca nega (D19/D1)');
est({ pct5: 10, pct7: 10 });
ok(hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).trim() === '', 'cota baixa não pergunta');
const VAZIO = novaPasta('vazio');
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }, { CLAUDE_COTA_DIR: VAZIO }).trim() === '' &&
   hook('admissao.js', { hook_event_name: 'PreToolUse' }, { CLAUDE_COTA_DIR: VAZIO }).trim() === '',
   'sem leitura e com a sonda falhando, os dois falham aberto');

/* -------------------------------- vigia -------------------------------- */
secao('vigia do workflow (D30)');

const vig = (tipo, extra) => hook('medidor.js', ev(tipo, 'v1'), extra);
est({ pct5: 40, reset5: NOW + 3600 });
ok(vig('SubagentStop').trim() === '', 'abaixo do limiar, o vigia cala');
est({ pct5: 82, reset5: NOW + 3600 });
const falou = vig('SubagentStop');
ok(/systemMessage/.test(falou) && /82%/.test(falou) && /cabe/.test(falou), 'acima, fala o percentual e manda consultar');
ok(!/"decision"|"continue"/.test(falou), 'mas nunca bloqueia (D17)');
ok(vig('SubagentStop').trim() === '', 'não repete dentro do intervalo');
est({ pct5: 91, reset5: NOW + 3600 });
ok(/91%/.test(vig('SubagentStop')), 'nova faixa de 5% volta a falar');
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ ligado: true, vigia: { ligado: false } }));
est({ pct5: 97, reset5: NOW + 3600 });
ok(vig('SubagentStop').trim() === '', 'dá para desligar só o vigia');
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ ligado: true }));

/* ------------------------------ liga/desliga ------------------------------ */
secao('chave liga/desliga (D2)');

est({ pct5: 88 });
cli(['off']);
ok(/desativada/i.test(cli([])), 'desligada, o status diz que está desativada');
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '' &&
   hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).trim() === '',
   'desligada, aviso e PreToolUse calam');
const ARGSD = path.join(TMP, '_args.json');
est({ t: NOW - 999 });
cli([], { COTA_FALSO: 'ok', COTA_FALSO_ARGS: ARGSD });
ok(!fs.existsSync(ARGSD), 'desligada, nada sonda');
cli(['on']);
ok(/5h/.test(cli([])), 'religada, volta a funcionar calada');

/* -------------------------------- CLI -------------------------------- */
secao('CLI tolerante: digitação nunca vira "ferramenta quebrada" (D27)');

est({ pct5: 30 });
ok(JSON.parse(cli(['--json'])).cinco_horas !== undefined, 'cota --json é JSON válido');
for (const e of [['10'], ['cabe'], ['ver'], ['aguenta', '5'], ['xpto'], ['--help'], ['sonda'], ['limpar']]) {
  const r = cliCod(e);
  ok(r.cod === 0 && r.out.trim().length > 0, '`cota ' + e.join(' ') + '` sai com 0 e responde');
}
ok(/cabem 10/.test(cli(['10'])), 'número solto é entendido como `cabe 10`');
ok(/faltou o n/i.test(cli(['cabe'])) && /5h/.test(cli(['cabe'])), '`cabe` sem número diz o que faltou e mostra a situação');
ok(/não conheço/i.test(cli(['xpto'])) && /5h/.test(cli(['xpto'])), 'comando inexistente é explícito, e entrega a situação');
for (const e of ['DEBUG', 'diagnóstico']) {
  const r = cli([e]);
  ok(/audit/i.test(r) && !/SyntaxError|at Object\.|Cannot read/.test(r), '`cota ' + e + '` vira audit, sem stack trace');
}
ok(!/leitura|aferi/i.test(cli(['ajuda'])), 'a ajuda não oferece mais comandos aposentados (D44)');

// D37 — config valida o tipo contra o padrão.
ok(/espera um número/.test(cli(['config', 'aviso.limiar_5h', 'abc'])), 'config recusa texto onde espera número');
ok(/percentual/.test(cli(['config', 'aviso.limiar_5h', '150'])), 'e percentual fora de 0–100');
ok(/espera true ou false/.test(cli(['config', 'aviso.ligado', 'talvez'])), 'e não booleano onde espera booleano');
ok(/fração/.test(cli(['config', 'admissao.margem', '5'])), 'e margem fora de 0–1');
cli(['config', 'sonda.idade_s', '90']);
ok(lerT('config.json').sonda.idade_s === 90, 'valor válido é gravado como número (D8)');
ok(/inexistente/.test(cli(['config', 'sonda.ligado', 'false'])), 'chave aposentada não existe mais');
cli(['config', 'sonda.idade_s', '60']);
const limpo = core.semProto(JSON.parse('{"__proto__":{"poluido":"SIM"},"ligado":true}'));
ok(!Object.keys(limpo).includes('__proto__') && Object.keys(limpo).includes('ligado') &&
   ({}).poluido === undefined, 'semProto tira __proto__ e preserva o resto');

/* ------------------------ diagnóstico e audit ------------------------ */
secao('a mensagem de erro é a documentação (D36) e o audit (D20)');

const TMPF = novaPasta('sonda-falha');
const falhou = cli([], { CLAUDE_COTA_DIR: TMPF });
ok(/leitura da cota falhou/.test(falhou) && /claude falso: sem roteiro/.test(falhou),
   'sonda quebrada: diz que falhou, com o erro do próprio claude');
ok(/cota sondar/.test(falhou) && /COTA_CLAUDE/.test(falhou), 'e com o conserto, não só a explicação');
estadoEm(TMPF)({ t: NOW });
ok(!/falhou/.test(cli([], { CLAUDE_COTA_DIR: TMPF })), 'leitura ainda fresca não alarma à toa');

const audOk = semCor(cli(['audit'], Object.assign({}, ENVS, { COTA_FALSO_P5: '50' })));
ok(/ok\s+a leitura da cota \(get_usage\) respondeu/.test(audOk), 'audit sonda de verdade');
ok(/nenhuma falha/.test(audOk), 'e instalação nova sem amostra de custo não é falha');
const audF = semCor(cli(['audit'], { CLAUDE_COTA_DIR: TMPF }));
ok(/FALHA\s+a leitura da cota \(get_usage\) respondeu/.test(audF) && /cota sondar/.test(audF),
   'com a sonda quebrada, diz o elo e o conserto');

/* -------------------------------- poda -------------------------------- */
secao('poda (D38) e restos da versão antiga (D44)');

const TMPP = novaPasta('poda');
fs.writeFileSync(path.join(TMPP, 'historico.jsonl'),
  [NOW - 30 * 86400, NOW - 20 * 86400, NOW].map(t => JSON.stringify({ t, pct5: 1 })).join('\n') + '\n');
fs.writeFileSync(path.join(TMPP, 'agentes.jsonl'),
  Array.from({ length: 6000 }, (_, i) => JSON.stringify({ t: NOW, i })).join('\n') + '\n');
for (const n of ['batimento.json', 'afericoes.jsonl']) fs.writeFileSync(path.join(TMPP, n), '{}');
fs.mkdirSync(path.join(TMPP, 'sessoes'));
const lim = cli(['limpar'], { CLAUDE_COTA_DIR: TMPP });
ok(core.lerJsonl(path.join(TMPP, 'historico.jsonl')).length === 1, 'histórico mais velho que 14 dias sai');
ok(core.lerJsonl(path.join(TMPP, 'agentes.jsonl')).length === 5000, 'amostras truncadas no limite');
ok(!fs.existsSync(path.join(TMPP, 'batimento.json')) && !fs.existsSync(path.join(TMPP, 'sessoes')),
   'restos da versão com status line são removidos');
ok(/batimento/.test(lim), 'e o `limpar` diz o que removeu');

/* ----------------------------- segurança ----------------------------- */
secao('segurança');

// Id de agente vira nome de arquivo: não pode escapar da pasta.
const TMPT = novaPasta('trav');
estadoEm(TMPT)({ t: NOW });
const canario = path.join(path.dirname(TMPT), 'CANARIO-COTA.txt');
try { fs.unlinkSync(canario); } catch (_) {}
for (const mau of ['../../CANARIO-COTA', '..\\..\\CANARIO-COTA', '/etc/passwd']) {
  hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: mau, agent_type: 'X', session_id: mau },
       { CLAUDE_COTA_DIR: TMPT });
}
ok(!fs.existsSync(canario), 'id de agente com ../ não escreve fora da pasta de estado');
if (!WIN) {
  ok((fs.statSync(path.join(TMPS, 'estado.json')).mode & 0o077) === 0, 'estado gravado como 0600');
}
const fontes = ['cota.js', 'instalar.js', 'lib/core.js', 'lib/sonda.js', 'lib/analise.js',
                'hooks/aviso.js', 'hooks/admissao.js', 'hooks/medidor.js']
  .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');   // só código, sem os comentários que explicam o porquê
ok(!/\beval\(|new Function|shell:\s*true/.test(fontes), 'nada de eval, new Function ou shell: true no código');
ok(!/credentials/.test(fontes), 'e nenhum código lê credencial');

/* ----------------------------- plataformas ----------------------------- */
secao('comando gerado por plataforma');

// O suporte a Linux/macOS nunca rodou lá. O mínimo honesto é provar que o
// COMANDO gerado está certo nas três, com o módulo `path` de cada uma.
const fonteInstalador = fs.readFileSync(path.join(__dirname, 'instalar.js'), 'utf8');
const fnComando = (fonteInstalador.match(/function comando\(script\)[\s\S]*?\n\}/) || [])[0];
ok(!!fnComando, 'a função comando() existe no instalar.js');
const montar = (plat, dir, node) => new Function(
  'WINDOWS', 'DIR', 'NODE', 'path', 'barras', fnComando + '; return comando;'
)(plat === 'win32', dir, node, plat === 'win32' ? path.win32 : path.posix, p => p.replace(/\\/g, '/'));

const cLinux = montar('linux', '/home/ana/cota', '/usr/bin/node')('hooks/aviso.js');
const cWin = montar('win32', 'C:\\Users\\Ana\\cota', 'C:\\node\\node.exe')('hooks/aviso.js');
const cWinEsp = montar('win32', 'C:\\Users\\Ana Maria\\cota', 'C:\\node\\node.exe')('hooks/aviso.js');
ok(/^"\/usr\/bin\/node" "\/home\/ana\/cota\/hooks\/aviso\.js"$/.test(cLinux), 'no Linux: node e script, entre aspas');
ok(/^powershell -NoProfile -ExecutionPolicy Bypass -File C:\/Users\/Ana\/cota\/run\.ps1 hooks\/aviso\.js$/.test(cWin),
   'no Windows: o formato documentado, com barra normal');
ok(/-File "C:\/Users\/Ana Maria\/cota\/run\.ps1" hooks\/aviso\.js$/.test(cWinEsp),
   'caminho com espaço vai entre aspas — sem elas o hook falharia calado');
const atalho = fs.readFileSync(path.join(__dirname, 'cota'), 'utf8');
ok(/^#!\/bin\/sh/.test(atalho) && !/\r/.test(atalho), 'o atalho POSIX é sh de verdade, sem CR');

/* --------------------- README x instalador --------------------- */
secao('a instalação manual do README bate com a do instalador');

const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
// O bloco da instalação manual é o que tem os hooks — há outros blocos json no README.
const blocoJson = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]).find(b => /"hooks"/.test(b));
let manual = null;
try { manual = JSON.parse(blocoJson.split('<PASTA>').join('C:/proj/cota')); } catch (_) {}
ok(!!manual, 'o README tem um bloco de settings.json válido');
if (manual) {
  const cmdWin = montar('win32', 'C:/proj/cota', 'C:\\node\\node.exe');
  const HOOKS = { UserPromptSubmit: 'hooks/aviso.js', PreToolUse: 'hooks/admissao.js',
                  SubagentStart: 'hooks/medidor.js', SubagentStop: 'hooks/medidor.js' };
  for (const [evento, script] of Object.entries(HOOKS)) {
    const g = (manual.hooks || {})[evento];
    ok(!!g && g[0].hooks[0].command === cmdWin(script), 'o hook ' + evento + ' do README bate com o do instalador');
  }
  ok(manual.hooks.PreToolUse[0].matcher === 'Agent|Task|Workflow', 'e o matcher do PreToolUse');
  ok(!manual.statusLine, 'e não há status line (D44)');
  const noInstalador = (fonteInstalador.match(/^\s+(\w+):\s*\{ script:/gm) || []).map(l => l.trim().split(':')[0]);
  ok(noInstalador.length === 4 && noInstalador.every(e => e in manual.hooks) &&
     Object.keys(manual.hooks).every(e => noInstalador.includes(e)),
     'o instalador registra exatamente os quatro hooks do README');
}

/* ------------------------------ instalador ------------------------------ */
secao('o instalador de verdade, numa cópia do projeto e numa pasta pessoal falsa');

/*
 * Numa CÓPIA do projeto: o instalador grava o node-local.txt na pasta dele, e
 * é esse arquivo que os hooks instalados de verdade usam. Rodando o daqui, um
 * `node teste.js` com outro node repontaria os seus hooks sem aviso (#6).
 */
const COPIA = novaPasta('projeto');
for (const f of ['cota.js', 'instalar.js', 'run.ps1', 'cota', 'cota.cmd', 'lib/core.js', 'lib/sonda.js',
                 'lib/analise.js', 'hooks/aviso.js', 'hooks/admissao.js', 'hooks/medidor.js',
                 'skill/SKILL.modelo.md']) {
  fs.mkdirSync(path.dirname(path.join(COPIA, f)), { recursive: true });
  fs.copyFileSync(path.join(__dirname, f), path.join(COPIA, f));
}
const COPIA_B = COPIA.replace(/\\/g, '/');
const nodeLocalReal = path.join(__dirname, 'node-local.txt');
const lerNL = () => (fs.existsSync(nodeLocalReal) ? fs.readFileSync(nodeLocalReal, 'utf8') : null);
const nlAntes = lerNL();

const HOMEI = novaPasta('home-instalar');
const CLI_I = path.join(HOMEI, '.claude');
const ESTI = path.join(CLI_I, 'cota');
fs.mkdirSync(path.join(ESTI, 'sessoes'), { recursive: true });
fs.writeFileSync(path.join(ESTI, 'batimento.json'), '{}');
const SET = path.join(CLI_I, 'settings.json');
// Coisa de outra ferramenta, a status line da versão antiga, e hooks do cota
// de quando o projeto morava em outra pasta — um deles duplicado (#7).
const alheio = { type: 'command', command: 'outra-ferramenta --hook' };
const velhoWin = 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/velho/cota/run.ps1 hooks/aviso.js';
const velhoPosix = '"/usr/bin/node" "/velho/cota/hooks/aviso.js"';
fs.writeFileSync(SET, JSON.stringify({
  model: 'opus',
  statusLine: { type: 'command', command: 'powershell -File C:/velho/cota/run.ps1 sensor.js' },
  hooks: { UserPromptSubmit: [{ hooks: [alheio] }, { hooks: [{ type: 'command', command: velhoWin }] },
                              { hooks: [{ type: 'command', command: velhoPosix }] }] },
}));
const ENVI = Object.assign({}, ENV, { HOME: HOMEI, USERPROFILE: HOMEI, CLAUDE_COTA_DIR: ESTI, COTA_FALSO: 'ok' });
const instalar = (args, envExtra) => {
  try { return execFileSync(process.execPath, [path.join(COPIA, 'instalar.js')].concat(args || []),
    { encoding: 'utf8', env: Object.assign({}, ENVI, envExtra || {}), timeout: 120000 }); }
  catch (e) { return 'SAIU ' + e.status + ': ' + (e.stdout || '') + (e.stderr || ''); }
};
const doCota = h => /hooks[\\/](aviso|admissao|medidor)\.js|sensor\.js/.test(h.command);

const original = fs.readFileSync(SET, 'utf8');
const i1 = instalar();
ok(!/SAIU|FALHA/.test(i1), 'instala e a conferência passa');
const s1j = JSON.parse(fs.readFileSync(SET, 'utf8'));
ok(s1j.model === 'opus', 'preserva o que já estava no settings.json');
ok(!s1j.statusLine, 'remove a status line da versão antiga (D44)');
ok(s1j.hooks.UserPromptSubmit.some(g => g.hooks.some(h => h.command === alheio.command)),
   'e não toca no hook de outra ferramenta');
ok(['UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop'].every(e =>
   s1j.hooks[e].some(g => g.hooks.some(h => h.command.includes(COPIA_B)))), 'liga os quatro hooks');
ok(!JSON.stringify(s1j).includes('/velho/'),
   'hooks de quando o projeto morava em outra pasta são atualizados, não deixados falhando (#7)');
ok(s1j.hooks.UserPromptSubmit.reduce((n, g) => n + g.hooks.filter(doCota).length, 0) === 1,
   'e o duplicado sai — sobra um hook do cota por evento');
ok(fs.existsSync(path.join(CLI_I, 'skills', 'cota', 'SKILL.md')), 'gera a skill');
ok(!fs.existsSync(path.join(ESTI, 'batimento.json')) && !fs.existsSync(path.join(ESTI, 'sessoes')),
   'e limpa os restos da versão antiga no estado');
ok(lerNL() === nlAntes, 'o node-local.txt do projeto de verdade não foi tocado (#6)');

instalar();
const s2j = JSON.parse(fs.readFileSync(SET, 'utf8'));
ok(Object.values(s2j.hooks).every(gs => gs.reduce((n, g) => n + g.hooks.filter(doCota).length, 0) <= 1),
   'reinstalar não duplica hook');
ok(fs.readFileSync(SET + '.bak-cota', 'utf8') === original,
   'e o backup continua sendo o ORIGINAL, não o da instalação anterior');

// #11 — com a sonda falhando, a conferência aponta a sonda, e só ela.
const iF = instalar([], { COTA_FALSO: 'falha' });
ok(/a leitura da cota falhou/.test(iF), 'com a sonda quebrada, a conferência diz que a sonda falhou');
ok(!/não respondeu JSON|comando da skill não executa/.test(iF),
   'sem culpar o node nem a skill, que estão certos (#11)');

const rem = instalar(['--remover']);
const s3j = JSON.parse(fs.readFileSync(SET, 'utf8'));
ok(!/SAIU/.test(rem), '--remover roda');
ok(!JSON.stringify(s3j).includes(COPIA_B), 'tira todos os hooks do cota');
ok(s3j.model === 'opus' && s3j.hooks.UserPromptSubmit[0].hooks[0].command === alheio.command,
   'e deixa intacto o que não é dele');
ok(!fs.existsSync(path.join(CLI_I, 'skills', 'cota')), 'e remove a skill');

/* ------------------------- revisão de código ------------------------- */
secao('achados do /code-review, cada um reproduzido');

const viaNode = (codigo, env) => JSON.parse(execFileSync(process.execPath, ['-e', codigo,
  path.join(__dirname, 'lib', 'sonda.js'), path.join(__dirname, 'lib', 'core.js')],
  { encoding: 'utf8', env: Object.assign({}, ENV, env), timeout: 60000 }));

// #1 — depois de uma falha, pausa: nem o `cota` nem os hooks tentam de novo.
const TMPB = novaPasta('pausa');
const ARGSB = path.join(TMPB, '_args.json');
const ENVB = { CLAUDE_COTA_DIR: TMPB, COTA_FALSO_ARGS: ARGSB };      // o falso falha
cli([], ENVB);
ok(fs.existsSync(ARGSB), 'a primeira consulta tenta ler');
fs.unlinkSync(ARGSB);
cli([], ENVB);
hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }, ENVB);
hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' }, ENVB);
ok(!fs.existsSync(ARGSB), 'depois de uma falha, ninguém tenta de novo antes da pausa (#1)');
cli(['sondar'], ENVB);
ok(fs.existsSync(ARGSB), 'menos o `cota sondar`, que é deliberado');
const sjB = lerEm(TMPB)('sonda.json');
fs.writeFileSync(path.join(TMPB, 'sonda.json'), JSON.stringify(Object.assign({}, sjB,
  { t: NOW - sonda.PAUSA_FALHA_S - 1 })));
fs.unlinkSync(ARGSB);
cli([], ENVB);
ok(fs.existsSync(ARGSB), 'passada a pausa, volta a tentar');

// #2 — quem começa enquanto um trecho fecha entra na cadeia seguinte, não no trecho.
const TMPR = novaPasta('corrida-fecha');
const ENVR = { CLAUDE_COTA_DIR: TMPR, COTA_FALSO: 'ok' };
cli(['sondar'], Object.assign({}, ENVR, { COTA_FALSO_P5: '10' }));
hook('medidor.js', ev('SubagentStart', 'r1'), ENVR);
const CORRIDA = path.join(TMPR, '_corrida.js');
fs.writeFileSync(CORRIDA, [
  "// r1 fecha o trecho com uma leitura lenta; no meio dela, r2 começa.",
  "const { spawn } = require('child_process');",
  "const [alvo, env1, env2] = [process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4])];",
  "const roda = (ev, env) => new Promise(res => {",
  "  const c = spawn(process.execPath, [alvo], { env, stdio: ['pipe', 'ignore', 'ignore'] });",
  "  c.stdin.end(JSON.stringify(Object.assign({ agent_type: 'Explore', session_id: 's' }, ev)));",
  "  c.on('close', res);",
  "});",
  "const fecha = roda({ hook_event_name: 'SubagentStop', agent_id: 'r1' }, env1);",
  "setTimeout(() => roda({ hook_event_name: 'SubagentStart', agent_id: 'r2' }, env2)",
  "  .then(() => fecha).then(() => process.exit(0)), 800);",
].join('\n'));
execFileSync(process.execPath, [CORRIDA, path.join(__dirname, 'hooks', 'medidor.js'),
  JSON.stringify(Object.assign({}, ENV, ENVR, { COTA_FALSO_P5: '14', COTA_FALSO_DORME: '2500' })),
  JSON.stringify(Object.assign({}, ENV, ENVR, { COTA_FALSO_P5: '14' }))], { timeout: 60000 });
const aR = lerLEm(TMPR)('agentes.jsonl');
ok(aR.length === 1 && perto(aR[0].custo5, 4),
   'quem começa enquanto o trecho fecha não leva parte dele: r1 fica com os 4% (#2)');
ok(lerEm(TMPR)('marco.json') !== null, 'e quem fechou grava o marco seguinte, para o que acabou de chegar');
hook('medidor.js', ev('SubagentStop', 'r2'), Object.assign({}, ENVR, { COTA_FALSO_P5: '16' }));
const aR2 = lerLEm(TMPR)('agentes.jsonl');
ok(aR2.length === 2 && perto(aR2[1].custo5, 2), 'que depois é medido normalmente (14% → 16%)');

// #13 — fechamento sem estado legível não deixa nada para trás.
const TMPQ = novaPasta('fecha-sem-estado');
cli(['sondar'], { CLAUDE_COTA_DIR: TMPQ, COTA_FALSO: 'ok' });
hook('medidor.js', ev('SubagentStart', 'q1'), { CLAUDE_COTA_DIR: TMPQ, COTA_FALSO: 'ok' });
fs.unlinkSync(path.join(TMPQ, 'estado.json'));
hook('medidor.js', ev('SubagentStop', 'q1'), { CLAUDE_COTA_DIR: TMPQ });
ok(!fs.existsSync(path.join(TMPQ, 'marco.json')) && listarEm(TMPQ, 'terminados').length === 0 &&
   listarEm(TMPQ, 'em-voo').length === 0, 'sem estado no fechamento, nada fica para o próximo herdar (#13)');

// #3 — o ritmo é da última hora, com a leitura de agora fechando a conta.
const h3 = [{ t: NOW - 4 * 3600, pct5: 1, reset5: 9 }, { t: NOW - 3 * 3600 - 1200, pct5: 20, reset5: 9 }];
const r3 = an.ritmo(h3, 'pct5', 'reset5', 9, { t: NOW, pct5: 20, reset5: 9 });
ok(r3.pctPorHora === 0 && Math.abs(r3.deltaHoras - 1) < 0.01,
   'parado depois de uma subida: o ritmo da última hora é zero, não o da subida (#3)');
const r3b = an.ritmo([{ t: NOW - 1800, pct5: 10, reset5: 9 }], 'pct5', 'reset5', 9, { t: NOW, pct5: 13, reset5: 9 });
ok(Math.abs(r3b.pctPorHora - 6) < 0.01, 'com um ponto só no histórico, a leitura de agora completa a conta');

// #4 — trava de processo morto não prende ninguém até o timeout.
const TMPL = novaPasta('trava');
const TRAVA = path.join(TMPL, 'sonda.trava');
const garantirL = esperar => viaNode(
  `const s=require(process.argv[1]);console.log(JSON.stringify(s.garantirFresco(60,{esperar:${esperar}})))`,
  { CLAUDE_COTA_DIR: TMPL, COTA_FALSO: 'ok' });
estadoEm(TMPL)({ t: NOW - 999 });
fs.writeFileSync(TRAVA, JSON.stringify({ pid: 1, prazo: Date.now() - 1000 }));
let t0 = Date.now();
ok(garantirL(true).sondou === true && Date.now() - t0 < 5000, 'trava com prazo vencido é assumida na hora (#4)');
estadoEm(TMPL)({ t: NOW - 999 });
fs.writeFileSync(TRAVA, JSON.stringify({ pid: 1, prazo: Date.now() + 1500 }));
t0 = Date.now();
ok(garantirL(true).sondou === true && Date.now() - t0 < 8000,
   'quem espera percebe quando a trava vence e assume, sem esperar o timeout inteiro');
ok(!fs.existsSync(TRAVA), 'e solta a trava no fim');

// #5 — o audit aponta o elo certo: claude achado, pedido recusado.
const TMPU = novaPasta('recusa');
const audU = semCor(cli(['audit'], { CLAUDE_COTA_DIR: TMPU, COTA_FALSO: 'recusa' }));
ok(/ok\s+executável do claude encontrado/.test(audU) && /FALHA\s+a leitura da cota/.test(audU) &&
   /protocolo mudou/.test(audU), 'com o pedido recusado, o audit acusa a leitura, não o executável (#5)');

// #8 — relógio que voltou não congela o mural.
const TMPK = novaPasta('relogio');
estadoEm(TMPK)({ t: NOW + 3600, pct5: 99 });
const sK = cli([], { CLAUDE_COTA_DIR: TMPK, COTA_FALSO: 'ok', COTA_FALSO_P5: '33' });
ok(/33\.0%/.test(sK) && lerEm(TMPK)('estado.json').pct5 === 33,
   'leitura "do futuro" (o relógio voltou) é lida de novo e substituída (#8)');

// #9 — o fechamento exige leitura pedida depois do fim, abaixo do segundo.
const TMP9 = novaPasta('depois-de');
estadoEm(TMP9)({ t: NOW, t_ms: Date.now() - 1500 });
const r9 = viaNode(
  `const s=require(process.argv[1]);console.log(JSON.stringify(s.garantirFresco(60,{depoisDeMs:${Date.now()}})))`,
  { CLAUDE_COTA_DIR: TMP9, COTA_FALSO: 'ok' });
ok(r9.sondou === true, 'leitura fresca mas pedida antes do fim da onda não serve: lê de novo (#9)');

// #10 — `cota limpar` com número inválido não apaga nada; 0 é zero.
const TMPZ = novaPasta('limpar');
const linhasZ = [NOW - 10, NOW - 5].map(t => JSON.stringify({ t, pct5: 1 })).join('\n') + '\n';
fs.writeFileSync(path.join(TMPZ, 'historico.jsonl'), linhasZ);
fs.writeFileSync(path.join(TMPZ, 'agentes.jsonl'), linhasZ);
const zNeg = cli(['limpar', '-1'], { CLAUDE_COTA_DIR: TMPZ });
ok(/inteiro/.test(zNeg) && fs.readFileSync(path.join(TMPZ, 'agentes.jsonl'), 'utf8') === linhasZ,
   '`cota limpar -1` é recusado e não apaga as amostras (#10)');
cli(['limpar', '0'], { CLAUDE_COTA_DIR: TMPZ });
ok(core.lerJsonl(path.join(TMPZ, 'historico.jsonl')).length === 0, '`cota limpar 0` é zero dias, não 14');

// #12 — a poda automática não reescreve o arquivo a cada onda.
const TMPY = novaPasta('poda-folga');
const podarY = () => viaNode('const c=require(process.argv[2]);console.log(JSON.stringify(c.podar(14,5000)))',
  { CLAUDE_COTA_DIR: TMPY });
fs.writeFileSync(path.join(TMPY, 'historico.jsonl'),
  [NOW - 14.5 * 86400, NOW].map(t => JSON.stringify({ t, pct5: 1 })).join('\n') + '\n');
ok(podarY().truncados === 0, 'linha recém-vencida não faz a poda reescrever o arquivo (#12)');
fs.writeFileSync(path.join(TMPY, 'historico.jsonl'),
  [NOW - 16 * 86400, NOW].map(t => JSON.stringify({ t, pct5: 1 })).join('\n') + '\n');
ok(podarY().truncados === 1 && core.lerJsonl(path.join(TMPY, 'historico.jsonl')).length === 1,
   'passada a folga de um dia, poda — e grava atômico');
ok(!fs.readdirSync(TMPY).some(n => n.endsWith('.tmp')), 'sem deixar .tmp');

// #14 — a política dos hooks mora num lugar só.
const hooksFonte = ['aviso.js', 'admissao.js', 'medidor.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'hooks', f), 'utf8')).join('\n');
ok(!/garantirFresco\(|TIMEOUT_HOOK_MS/.test(hooksFonte) && /garantirFrescoHook/.test(hooksFonte),
   'os hooks usam o ajudante único da sonda, sem copiar timeout nem tratamento (#14)');

// #15 — o histórico compara só com a última linha, lendo o fim do arquivo.
const TMPH = novaPasta('historico-grande');
const ultimoPonto = { t: NOW - 60, pct5: 42, reset5: resetFalso(2), pct7: 17, reset7: resetFalso(100) };
fs.writeFileSync(path.join(TMPH, 'historico.jsonl'),
  Array.from({ length: 5999 }, (_, i) => JSON.stringify({ t: NOW - 7000 + i, pct5: 1, reset5: 1 })).join('\n') +
  '\n' + JSON.stringify(ultimoPonto) + '\n');
cli(['sondar'], { CLAUDE_COTA_DIR: TMPH, COTA_FALSO: 'ok' });
ok(core.lerJsonl(path.join(TMPH, 'historico.jsonl')).length === 6000, 'mesmo número da última linha: não repete o ponto (#15)');
cli(['sondar'], { CLAUDE_COTA_DIR: TMPH, COTA_FALSO: 'ok', COTA_FALSO_P5: '43' });
ok(core.lerJsonl(path.join(TMPH, 'historico.jsonl')).length === 6001, 'número novo: entra');

/* ---------------------------- higiene do repo ---------------------------- */
secao('o que vai para o GitHub');

// Versionados e os novos ainda não commitados — tudo que não está no .gitignore.
const versionados = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: __dirname, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(f => fs.existsSync(path.join(__dirname, f)) && !/\.(jpg|png)$/.test(f));
const pessoais = versionados.filter(f =>
  /[A-Z]:[\\/]Users[\\/](?!Ana|voce|Voce)\w|\/home\/(?!ana|voce)\w+\/|@gmail\.com/.test(
    fs.readFileSync(path.join(__dirname, f), 'utf8')));
ok(pessoais.length === 0, 'nenhum arquivo versionado com caminho de usuário ou e-mail' +
   (pessoais.length ? ': ' + pessoais.join(', ') : ''));
ok(fs.existsSync(path.join(__dirname, 'LICENSE')), 'tem LICENSE');
ok(!fs.existsSync(path.join(__dirname, 'sensor.js')), 'e o sensor da status line saiu (D44)');

/* -------------------------------- fim -------------------------------- */
console.log('');
console.log(falhas === 0
  ? C.g + C.b + '  tudo passou' + C.r
  : C.v + C.b + '  ' + falhas + ' falha(s)' + C.r);
console.log('');
process.exit(falhas === 0 ? 0 : 1);
