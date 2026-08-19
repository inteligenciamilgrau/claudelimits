#!/usr/bin/env node
'use strict';
/*
 * teste.js — exercita o pipeline inteiro com payload sintético, em diretório
 * temporário. Não encosta no seu estado real.
 *
 *   node teste.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', cy: '\x1b[36m',
            g: '\x1b[32m', v: '\x1b[31m' };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-teste-'));
const ENV = Object.assign({}, process.env, { CLAUDE_COTA_DIR: TMP });
const NOW = Math.floor(Date.now() / 1000);

let falhas = 0;
function ok(cond, label) {
  console.log((cond ? C.g + '  PASS  ' : C.v + '  FALHA ') + C.r + label);
  if (!cond) falhas++;
}
const secao = t => console.log('\n' + C.cy + C.b + t + C.r);

const rodar = (script, entrada, envExtra) => execFileSync(
  process.execPath, [path.join(__dirname, script)],
  { input: entrada, encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) });

const payload = (p5, p7, r5, r7, sessao) => JSON.stringify({
  session_id: sessao || 'sessao-A',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  version: '2.1.90',
  context_window: { used_percentage: 42, total_input_tokens: 15500 },
  rate_limits: {
    five_hour: { used_percentage: p5, resets_at: r5 !== undefined ? r5 : NOW + 3 * 3600 },
    seven_day: { used_percentage: p7, resets_at: r7 !== undefined ? r7 : NOW + 4 * 86400 },
  },
});

const ler = f => { try { return JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8')); } catch (_) { return null; } };
const lerL = f => { try { return fs.readFileSync(path.join(TMP, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

console.log('\n' + C.cy + C.b + 'cota — teste de ponta a ponta' + C.r + C.d + '  (' + TMP + ')' + C.r);

/* ------------------------------- sensor ------------------------------- */
secao('sensor (status line)');

const linha = rodar('sensor.js', payload(20, 35));
console.log(C.d + '  render: ' + C.r + linha);
ok(/5h 20%/.test(linha), 'mostra a janela de 5h');
ok(/7d 35%/.test(linha), 'mostra a janela semanal');
ok(/↻/.test(linha), 'mostra o countdown do reset');
ok(/sáb|dom|seg|ter|qua|qui|sex/.test(linha), 'semanal usa dia da semana (D11)');

const est = ler('estado.json');
ok(est && est.pct5 === 20 && est.pct7 === 35, 'gravou os percentuais');
ok(est && est.reset5 === NOW + 3 * 3600, 'gravou o resets_at absoluto (D10)');
ok(est && est.custo === undefined && est.cost_usd === undefined, 'não grava dólar (D13)');

ok(ler('batimento.json') && ler('batimento.json').tinha_rate_limits === true,
   'batimento registra que o sensor rodou com rate_limits');

const semRL = rodar('sensor.js', JSON.stringify({ session_id: 'sessao-A', model: { display_name: 'Opus' } }));
ok(ler('estado.json').pct5 === 20, 'payload sem rate_limits não apaga o estado');
ok(/aguardando/.test(semRL), 'status line avisa que está aguardando a 1ª resposta da API');
// Sem isto, "nunca foi chamado" e "chamado sem rate_limits" seriam
// indistinguíveis pelo audit — e são problemas diferentes.
ok(ler('batimento.json').tinha_rate_limits === false,
   'batimento é gravado MESMO sem rate_limits, marcando a ausência');

/* D6 — não sobrescreve cego com dado mais velho */
const antes = ler('estado.json').t;
fs.writeFileSync(path.join(TMP, 'estado.json'),
  JSON.stringify(Object.assign({}, ler('estado.json'), { t: NOW + 9999, pct5: 77 })));
rodar('sensor.js', payload(21, 36));
ok(ler('estado.json').pct5 === 77, 'não sobrescreve leitura mais nova (D6)');
fs.writeFileSync(path.join(TMP, 'estado.json'),
  JSON.stringify(Object.assign({}, ler('estado.json'), { t: antes, pct5: 20 })));

/* ------------------------------ janelas ------------------------------ */
secao('estados do dado velho (D4/D5)');

const core = require('./lib/core');
process.env.CLAUDE_COTA_DIR = TMP;
const cfg = core.CONFIG_PADRAO;

const j = (pct, reset, idade, mono) =>
  core.avaliarJanela(pct, reset, NOW - idade, cfg, NOW, mono !== false);

ok(j(50, NOW + 3600, 10).estado === 'fresco', 'leitura recente = fresco');
ok(j(50, NOW + 3600, 5000).estado === 'piso', 'leitura velha, janela viva = piso');
ok(j(50, NOW + 3600, 5000).pctParaDecidir === 50, 'piso serve para decidir (limite inferior)');
ok(j(99, NOW - 3600, 90000).estado === 'expirado', 'janela virou = expirado');
ok(j(99, NOW - 3600, 90000).pctParaDecidir === null, 'expirado NÃO vale 99% nem 0%');
ok(j(50, NOW + 3600, 5000, false).estado === 'desconhecido', 'monotonia violada mata o piso (D5)');

const histQuebrado = [
  { t: NOW - 200, pct5: 60, reset5: NOW + 3600 },
  { t: NOW - 100, pct5: 40, reset5: NOW + 3600 },
];
ok(core.monotoniaOk(histQuebrado, 'pct5', 'reset5', NOW + 3600) === false,
   'detecta queda de percentual dentro da janela');

/* ------------------------------- ritmo ------------------------------- */
secao('ritmo e projeção (D13)');

const an = require('./lib/analise');
const hist = [
  { t: NOW - 3600, pct5: 20, reset5: NOW + 3 * 3600, pct7: 35, reset7: NOW + 4 * 86400 },
  { t: NOW,        pct5: 60, reset5: NOW + 3 * 3600, pct7: 35.2, reset7: NOW + 4 * 86400 },
];
const r5 = an.ritmo(hist, 'pct5', 'reset5', NOW + 3 * 3600);
ok(Math.abs(r5.pctPorHora - 40) < 0.01, 'ritmo = 40%/h');
ok(Math.abs(r5.deltaHoras - 1) < 0.01, 'e diz sobre quanto tempo mediu');
ok(an.ritmo(hist, 'pct5', 'reset5', NOW + 99999).amostras === 0,
   'janela nova ignora histórico da janela anterior');

// Regressão do mundo real: duas leituras a 27s de distância com 1 ponto de
// diferença extrapolavam para 133%/h.
const curto = [
  { t: NOW - 27, pct5: 10, reset5: NOW + 3 * 3600 },
  { t: NOW,      pct5: 11, reset5: NOW + 3 * 3600 },
];
const rCurto = an.ritmo(curto, 'pct5', 'reset5', NOW + 3 * 3600);
ok(rCurto.pctPorHora === null, 'intervalo curto não vira ritmo');
ok(/27s/.test(rCurto.motivo || ''), 'e explica por quê');

// D28 — não existe projeção, e a ausência é o teste.
//
// Havia uma: extrapolava o ritmo até 100% e avisava se caía antes do reset.
// Emitia "acaba ANTES do reset" com 1% consumido, porque media 55min de
// trabalho ativo e projetava 167h de relógio. O defeito não era base curta,
// era supor uso estacionário — que este uso não é (rajada, silêncio de dias,
// perguntas lentas). Medir mais só daria uma média mais confiante e igualmente
// errada, então a função saiu inteira em vez de ser calibrada.
ok(typeof an.projecao === 'undefined', 'analise.js não exporta projecao');
const fonte = fs.readFileSync(path.join(__dirname, 'lib', 'analise.js'), 'utf8');
ok(!/function projecao/.test(fonte), 'e a função não existe mais no código');
ok(!/estouraAntesDoReset/.test(fs.readFileSync(path.join(__dirname, 'cota.js'), 'utf8')),
   'cota.js não fala mais em estouro previsto');
ok(!/estouraAntesDoReset/.test(fs.readFileSync(path.join(__dirname, 'hooks', 'aviso.js'), 'utf8')),
   'nem o hook de aviso');

/* ------------------------------ admissão ------------------------------ */
secao('admissão — a conta da missão');

const janelas = {
  cinco: j(60, NOW + 3 * 3600, 10),
  sete:  j(35, NOW + 4 * 86400, 10),
};
const custos = an.custoPorTipo([
  { tipo: 'Explore', custo5: 2, custo7: 0.2, limpa: true },
  { tipo: 'Explore', custo5: 2, custo7: 0.2, limpa: true },
  { tipo: 'Explore', custo5: 50, custo7: 5, limpa: false },   // suja: deve ser ignorada
]);
ok(custos.Explore.n === 2 && Math.abs(custos.Explore.media5 - 2) < 0.001,
   'amostra suja é descartada, não corrigida (D14)');

// restante 5h = 40%, orçamento = 40 × 0.7 = 28%. Cada agente custa 2%.
const a5 = an.admissao({ janelas, custos, cfg, n: 5, tipo: 'Explore', nowS: NOW });
ok(a5.veredito === 'vai', '5 agentes × 2% = 10% de 28% de orçamento → vai');
ok(a5.quantosCabem === 14, 'calcula que cabem 14');

const a20 = an.admissao({ janelas, custos, cfg, n: 20, tipo: 'Explore', nowS: NOW });
ok(a20.veredito === 'nao_cabe', '20 agentes = 40% → não cabe');
ok(a20.esperarAte === NOW + 3 * 3600, 'sugere esperar o reset da 5h (D16)');

// janela semanal apertada tem que mandar, mesmo com a de 5h folgada
// 5h folgada (10%: orçamento 63%, 20 agentes custam 40% → caberia)
// semanal apertada (95%: orçamento 3,5%, 20 agentes custam 4% → não cabe)
const janelasSemanalRuim = { cinco: j(10, NOW + 3 * 3600, 10), sete: j(95, NOW + 4 * 86400, 10) };
const aSem = an.admissao({ janelas: janelasSemanalRuim, custos, cfg, n: 20, tipo: 'Explore', nowS: NOW });
ok(aSem.janelaCritica === '7d', 'obedece a janela mais apertada (D15)');
ok(aSem.veredito === 'nao_cabe', 'semanal barra mesmo com a de 5h folgada');
ok(aSem.janelas.cinco.cabe === true, 'e a de 5h, sozinha, teria deixado passar');
ok(aSem.esperarAte === null, 'não sugere esperar o reset da 5h quando quem barra é a semanal');

const semBase = an.admissao({ janelas, custos: {}, cfg, n: 5, nowS: NOW });
ok(semBase.veredito === 'sem_base', 'sem amostra limpa → sem_base, não recusa (Q5)');

const expirada = { cinco: j(99, NOW - 10, 90000), sete: j(99, NOW - 10, 90000) };
const aExp = an.admissao({ janelas: expirada, custos, cfg, n: 5, tipo: 'Explore', nowS: NOW });
ok(aExp.veredito === 'sem_dado', 'janela expirada não vira decisão baseada em 99% velho');

/* ------------------------------- medidor ------------------------------- */
secao('medidor (SubagentStart / SubagentStop)');

const hook = (arquivo, ev, envExtra) => execFileSync(
  process.execPath, [path.join(__dirname, 'hooks', arquivo)],
  { input: JSON.stringify(ev), encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) });

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW - 100, sessao: 'sessao-A', pct5: 20, reset5: NOW + 3 * 3600, pct7: 35, reset7: NOW + 4 * 86400 }));

hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore', session_id: 'sessao-A' });
ok(fs.existsSync(path.join(TMP, 'em-voo')), 'SubagentStart registra o agente em voo');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 23, reset5: NOW + 3 * 3600, pct7: 35.3, reset7: NOW + 4 * 86400 }));
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'Explore', session_id: 'sessao-A' });

const am = lerL('agentes.jsonl');
ok(am.length === 1 && Math.abs(am[0].custo5 - 3) < 0.001, 'mede custo do subagente em % (3%)');
ok(am[0].limpa === true, 'amostra sem concorrência é marcada limpa');

// D31 — a onda é a unidade de medida, e paralelismo deixou de ser sujeira.
//
// Regressão real: com o critério antigo ("um subagente sozinho em voo"), uma
// onda de 2 gerava 0 amostras limpas de 2 — a base nunca se formava justamente
// no cenário para o qual a ferramenta existe. Medido antes do conserto.
hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'agA', agent_type: 'Explore', session_id: 'sessao-A' });
hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'agB', agent_type: 'Explore', session_id: 'sessao-A' });
fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW + 1, sessao: 'sessao-A', pct5: 27, reset5: NOW + 3 * 3600, pct7: 36, reset7: NOW + 4 * 86400 }));
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'agB', agent_type: 'Explore', session_id: 'sessao-A' });
ok(lerL('agentes.jsonl').length === 1,
   'com um ainda em voo, a onda não fecha e nada é gravado');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW + 2, sessao: 'sessao-A', pct5: 31, reset5: NOW + 3 * 3600, pct7: 36, reset7: NOW + 4 * 86400 }));
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'agA', agent_type: 'Explore', session_id: 'sessao-A' });

// O teste do agente solitário, acima, também formou uma onda (de 1).
const ondas = lerL('ondas.jsonl');
ok(ondas.length === 2, 'o último a sair fecha a onda');
const ult = ondas[ondas.length - 1];
ok(ondas[0].n === 1, 'um subagente sozinho é uma onda de 1');
ok(ult.n === 2, 'e a onda paralela sabe quantos participaram');
ok(Math.abs(ult.custo5 - 8) < 0.001, 'mede o Δ do período inteiro (23%→31% = 8%)');
ok(ult.limpa === true, 'paralelismo dentro da onda não é mais sujeira');

const am2 = lerL('agentes.jsonl');
const daOnda = am2.slice(-2);
ok(daOnda.length === 2, 'uma linha por participante');
ok(daOnda.every(a => a.limpa === true), 'todas limpas');
ok(daOnda.every(a => Math.abs(a.custo5 - 4) < 0.001), 'cada uma com o custo médio (8% / 2)');
ok(daOnda.every(a => a.atribuicao === 'onda'),
   'marcadas como medição coletiva — não se sabe quem gastou o quê');

// Outra sessão escrevendo no período ainda contamina: isso não mudou.

// D25 — órfão: subagente registrado que nunca teve Stop (a sessão morreu).
// Sem varrer, ele sujaria toda amostra futura e o `cabe N` travaria em
// SEM BASE para sempre. Aconteceu de verdade durante o desenvolvimento.
const voo = path.join(TMP, 'em-voo');
fs.mkdirSync(voo, { recursive: true });
// Zera o cenário: o bloco anterior deixou o agA legitimamente em voo, e ele
// sujaria a amostra por motivo certo, mascarando o que este teste mede.
for (const n of fs.readdirSync(voo)) fs.rmSync(path.join(voo, n), { force: true });
fs.writeFileSync(path.join(voo, 'orfao.json'), JSON.stringify(
  { tipo: 'Explore', sessao: 'morta', t0: NOW - 99999, estado_t0: 0,
    pct5_0: 0, pct7_0: 0, reset5_0: 0, reset7_0: 0, outros_antes: 0 }));

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW + 10, sessao: 'sessao-A', pct5: 40, reset5: NOW + 3 * 3600, pct7: 37, reset7: NOW + 4 * 86400 }));
hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'novo', agent_type: 'Explore', session_id: 'sessao-A' });
ok(!fs.existsSync(path.join(voo, 'orfao.json')), 'órfão antigo é varrido (D25)');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW + 11, sessao: 'sessao-A', pct5: 42, reset5: NOW + 3 * 3600, pct7: 37, reset7: NOW + 4 * 86400 }));
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'novo', agent_type: 'Explore', session_id: 'sessao-A' });
const am3 = lerL('agentes.jsonl');
ok(am3[am3.length - 1].limpa === true,
   'e a amostra seguinte volta a ser limpa, em vez de suja para sempre');

/* ------------------------------- aviso ------------------------------- */
secao('aviso (UserPromptSubmit) e admissão (PreToolUse)');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 30, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }));
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '',
   'abaixo do limiar não injeta nada (custo zero)');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 88, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }));
const av = hook('aviso.js', { hook_event_name: 'UserPromptSubmit' });
ok(/additionalContext/.test(av), 'acima do limiar injeta contexto');
ok(/88\.0%/.test(av) && /reseta em/.test(av), 'aviso traz percentual E reset');
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '',
   'não repete o mesmo aviso dentro do intervalo');
// Regressão: a assinatura já foi montada com o texto formatado, que carrega o
// countdown. Virava o minuto, mudava a assinatura, e o aviso repetia sempre.
ok(/^5h:\d+:\d+$/.test((ler('aviso-ultimo.json') || {}).assinatura || ''),
   'assinatura é feita de fatos estáveis, não do texto com countdown');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 95, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }));
ok(/additionalContext/.test(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' })),
   'subir de faixa (88% → 95%) volta a avisar antes do intervalo');

const adm = hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' });
ok(/"permissionDecision":\s*"ask"/.test(adm), 'PreToolUse pergunta acima do limiar (D19)');
ok(!/deny/.test(adm), 'nunca usa deny — não é freio cego (D1)');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 10, reset5: NOW + 3 * 3600, pct7: 10, reset7: NOW + 4 * 86400 }));
ok(hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).trim() === '',
   'cota baixa não pergunta nada');

/* ------------------------------ liga/desliga ------------------------------ */
secao('chave liga/desliga (D2) e falha aberta');

const cli = (args, envExtra) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, 'cota.js')].concat(args),
      { encoding: 'utf8', env: Object.assign({}, ENV, envExtra || {}) });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

cli(['off']);
ok(/desativada/i.test(cli([])), 'desligada, o status diz que está desativada');
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }).trim() === '',
   'desligada, o aviso some');
fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 88, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }));
ok(hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' }).trim() === '',
   'desligada, o PreToolUse não pergunta');
ok(/cota off/.test(rodar('sensor.js', payload(88, 20))), 'desligada, a status line mostra "cota off"');
ok(ler('estado.json').pct5 === 88, 'desligada, o sensor CONTINUA gravando (religar volta na hora)');
cli(['on']);
ok(/5h/.test(cli([])), 'religada, volta a funcionar calada');

const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-vazio-'));
ok(hook('aviso.js', { hook_event_name: 'UserPromptSubmit' }, { CLAUDE_COTA_DIR: vazio }).trim() === '',
   'sem estado nenhum, o aviso falha aberto');
ok(hook('admissao.js', { hook_event_name: 'PreToolUse' }, { CLAUDE_COTA_DIR: vazio }).trim() === '',
   'sem estado nenhum, o PreToolUse falha aberto');

/* ------------------------------- aferição ------------------------------- */
secao('aferição e modo desconfiado (D21/D22)');

fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, sessao: 'sessao-A', pct5: 50, reset5: NOW + 3 * 3600, pct7: 20, reset7: NOW + 4 * 86400 }));

cli(['audit', '80']);
ok(ler('config.json').modo_desconfiado === true, 'divergência grande liga o modo desconfiado');
const admDesc = hook('admissao.js', { hook_event_name: 'PreToolUse', tool_name: 'Agent' });
ok(/desconfiado/.test(admDesc), 'modo desconfiado faz o PreToolUse perguntar mesmo com cota baixa');

cli(['audit', 'ok']);
ok(ler('config.json').modo_desconfiado === false, 'aferição ok desliga o modo desconfiado');
ok(lerL('afericoes.jsonl').length === 2, 'as duas aferições ficaram gravadas');

/* -------------------------------- CLI -------------------------------- */
secao('CLI');

ok(/5h/.test(cli([])), 'cota status renderiza');
ok(JSON.parse(cli(['--json'])).cinco_horas !== undefined, 'cota --json é JSON válido');
ok(/cabem|VAI|NÃO CABE|SEM BASE/.test(cli(['cabe', '10'])), 'cota cabe 10 responde');
ok(/ok |FALHA/.test(cli(['audit'])), 'cota audit roda as checagens');
cli(['config', 'aviso.limiar_5h', '65']);
ok(ler('config.json').aviso.limiar_5h === 65, 'cota config muda valor sem reiniciar (D8)');

/* --------------------- observação ≠ confirmação (D24) --------------------- */
secao('sessão ociosa não vira dado fresco (D24)');

const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-ocioso-'));
const ENV2 = Object.assign({}, process.env, { CLAUDE_COTA_DIR: TMP2 });
const rodar2 = (entrada) => execFileSync(process.execPath, [path.join(__dirname, 'sensor.js')],
  { input: entrada, encoding: 'utf8', env: ENV2 });
const ler2 = () => JSON.parse(fs.readFileSync(path.join(TMP2, 'estado.json'), 'utf8'));

const pay = (p5, tk) => JSON.stringify({
  session_id: 'ociosa', model: { id: 'm', display_name: 'M' },
  context_window: { used_percentage: 10, total_input_tokens: tk },
  rate_limits: { five_hour: { used_percentage: p5, resets_at: NOW + 3 * 3600 },
                 seven_day: { used_percentage: 40, resets_at: NOW + 4 * 86400 } },
});

rodar2(pay(13, 1000));
const e1 = ler2();
ok(e1.t_confirmado === e1.t, 'primeira leitura é confirmada por definição');

// Sessão ociosa: o sensor roda de novo (t novo) mas os tokens não mudaram,
// logo nenhuma resposta nova de API chegou e o rate_limits é repetição.
fs.writeFileSync(path.join(TMP2, 'estado.json'),
  JSON.stringify(Object.assign({}, e1, { t: e1.t - 600, t_confirmado: e1.t - 600 })));
rodar2(pay(13, 1000));
const e2 = ler2();
ok(e2.t > e2.t_confirmado, 'observação repetida avança t mas NÃO t_confirmado');
ok(e2.t_confirmado === e1.t - 600, 'confirmação continua sendo a antiga');

// Resposta nova de API (tokens mudaram) confirma de novo.
rodar2(pay(13, 2500));
const e3 = ler2();
ok(e3.t_confirmado === e3.t, 'tokens diferentes = resposta nova = confirmação');

// Percentual novo com tokens iguais também confirma: é dado novo por definição.
// Cobre renovação sem turno de modelo (um /usage, por exemplo).
fs.writeFileSync(path.join(TMP2, 'estado.json'),
  JSON.stringify(Object.assign({}, ler2(), { t: e3.t - 600, t_confirmado: e3.t - 600 })));
rodar2(pay(14, 2500));
const e4 = ler2();
ok(e4.t_confirmado === e4.t,
   'percentual novo com tokens iguais também confirma (renovação sem turno)');

// E é a idade CONFIRMADA que decide o estado da janela, não a observada.
const cfgD24 = Object.assign({}, core.CONFIG_PADRAO, { idade_max_s: 300 });
const jan = core.lerJanelas(
  { pct5: 13, reset5: NOW + 3 * 3600, pct7: 40, reset7: NOW + 4 * 86400,
    t: NOW, t_confirmado: NOW - 3600 }, cfgD24, NOW, []);
ok(jan.cinco.estado === 'piso',
   'observado agora mas confirmado há 1h → piso, não fresco');
ok(core.tConfirmado({ t: 50 }) === 50, 'estado antigo sem t_confirmado usa t (compatível)');

// A status line precisa DIZER que o número é piso. O countdown (↻) desce pelo
// relógio a cada refresh e dá aparência de vida a dado congelado.
fs.writeFileSync(path.join(TMP2, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW - 7200, sessao: 'ociosa', pct5: 13, tokens: 1000,
    reset5: NOW + 3 * 3600, pct7: 40, reset7: NOW + 4 * 86400 }));
const linhaVelha = rodar2(pay(13, 1000));
ok(/5h ≥13%/.test(linhaVelha), 'status line marca "≥" quando a confirmação está velha');
ok(/↻/.test(linhaVelha), 'e o countdown continua aparecendo (ele é do relógio)');

fs.writeFileSync(path.join(TMP2, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW, sessao: 'ociosa', pct5: 13, tokens: 1000,
    reset5: NOW + 3 * 3600, pct7: 40, reset7: NOW + 4 * 86400 }));
ok(/5h 13%/.test(rodar2(pay(13, 1000))), 'confirmação fresca não leva "≥"');

/* ---------------------------- sensor manual ---------------------------- */
secao('sensor manual (D23)');

fs.rmSync(path.join(TMP, 'estado.json'), { force: true });
cli(['leitura', '12', '62', '3h44', '54min']);
const man = ler('estado.json');
ok(man && man.pct5 === 12 && man.pct7 === 62, 'leitura manual grava os percentuais');
ok(man.origem === 'manual', 'marca a origem como manual');
ok(Math.abs((man.reset5 - man.t) - 13440) <= 2, 'prazo "3h44" vira resets_at absoluto (D10)');
ok(Math.abs((man.reset7 - man.t) - 3240) <= 2, 'prazo "54min" idem');

ok(/fora de 0/.test(cli(['leitura', '150', '62', '1h', '1h'])), 'recusa percentual fora de 0–100');
ok(/uso:/.test(cli(['leitura', 'abc'])), 'sem argumentos válidos mostra o uso');

// Sem prazo, reaproveita o reset anterior se ele ainda valer.
cli(['leitura', '20', '63']);
const man2 = ler('estado.json');
ok(man2.pct5 === 20 && man2.reset5 === man.reset5,
   'sem prazo, reaproveita o reset ainda válido da leitura anterior');

// Se o reset anterior já passou, tem que exigir o novo em vez de inventar.
fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  Object.assign({}, man2, { reset5: NOW - 10, reset7: NOW - 10 })));
ok(/sem prazo/.test(cli(['leitura', '5', '5'])),
   'reset vencido exige prazo novo, não reaproveita nem chuta');

// O audit não pode cobrar batimento de sensor que, por definição, não roda.
cli(['leitura', '12', '62', '3h44', '54min']);
const auditManual = cli(['audit']);
ok(/modo manual/.test(auditManual), 'audit reconhece o modo manual');
ok(!/chamou o sensor/.test(auditManual), 'e não cobra batimento do sensor automático');
ok(/MANUAL/.test(auditManual), 'e avisa que a leitura não se atualiza sozinha');

/* --------------------------- à prova de idiota --------------------------- */
secao('CLI tolerante: digitação errada nunca vira "ferramenta quebrada"');

// Precisa do código de saída, que o `cli` acima descarta.
function cliCod(args) {
  try {
    const out = execFileSync(process.execPath,
      [path.join(__dirname, 'cota.js')].concat(args),
      { encoding: 'utf8', env: ENV });
    return { out, cod: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), cod: e.status };
  }
}

// A regra é: DIGITAÇÃO nunca vira código de erro. Achado, sim — `audit` sair
// 1 quando encontra problema é o que auditoria faz, e script pode depender.
const entradas = [
  ['10'],            // número solto = "cabe 10"
  ['cabe'],          // faltou o número
  ['ver'],           // sinônimo de status
  ['aguenta', '5'],  // sinônimo de cabe
  ['xpto'],          // não existe
  ['--help'],
];
for (const e of entradas) {
  const r = cliCod(e);
  ok(r.cod === 0, '`cota ' + e.join(' ') + '` sai com 0');
  ok(r.out.trim().length > 0, '`cota ' + e.join(' ') + '` responde alguma coisa');
}

// Os sinônimos de audit resolvem certo; o código de saída aqui reflete o
// resultado da auditoria, não a digitação.
for (const e of [['DEBUG'], ['diagnóstico']]) {
  const r = cliCod(e);
  ok(/audit/i.test(r.out), '`cota ' + e[0] + '` resolve para audit');
  ok(!/SyntaxError|at Object\.|Cannot read/.test(r.out),
     '`cota ' + e[0] + '` não devolve stack trace');
}

ok(/cabem 10/.test(cliCod(['10']).out), 'número solto é entendido como `cabe 10`');
ok(/cabem 5/.test(cliCod(['aguenta', '5']).out), 'sinônimo `aguenta 5` vira `cabe 5`');
ok(/faltou o n/i.test(cliCod(['cabe']).out), '`cabe` sem número diz o que faltou');
ok(/5h/.test(cliCod(['cabe']).out), '...e mostra a situação assim mesmo, em vez de só reclamar');
ok(/não conheço/i.test(cliCod(['xpto']).out), 'comando inexistente é explícito sobre isso');
ok(/5h/.test(cliCod(['xpto']).out), '...e ainda assim entrega a situação');


/* -------------------------------- ondas -------------------------------- */
secao('onda em vez de salva (D29)');

const custosOnda = { __geral: { n: 5, media5: 1.2, media7: 0.1, fonte: 'geral' } };
const admOnda = (pct, n) => an.admissao({
  janelas: { cinco: j(pct, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: custosOnda, cfg: { admissao: { margem: 0.7 } }, n, nowS: NOW });

// Folga: não inventar cerimônia. 10 cabem com sobra, então vão de uma vez.
const folga = admOnda(20, 10);
ok(folga.onda.tamanho === 10, 'com folga, a onda é o pedido inteiro');
ok(folga.onda.restantes === 0, 'e não sobra nada para uma segunda onda');

// Apertando: divide, para medir entre as ondas.
const meio = admOnda(60, 10);
ok(meio.onda.tamanho < 10, 'cota mais alta parte o pedido em ondas');
ok(meio.onda.tamanho >= 1, 'mas a onda nunca é zero — isso travaria o trabalho');
ok(meio.onda.restantes === 10 - meio.onda.tamanho, 'o restante fecha a conta');
ok(/errar sai barato|medindo/.test(meio.onda.porque || ''), 'e explica por que dividir');

// Uma onda nunca compromete mais que a fração do orçamento.
const jj = meio.janelas.cinco;
ok(meio.onda.tamanho * jj.custoUnit <= jj.orcamento * 0.25 + 0.01,
   'uma onda custa no máximo 1/4 do orçamento da janela crítica');

// Não cabe: não existe onda. Oferecer uma seria contrabandear o "não".
ok(admOnda(85, 10).veredito === 'nao_cabe', 'cota alta reprova 10 agentes');
ok(admOnda(85, 10).onda === null, 'e reprovado não ganha onda de consolação');

// Bootstrap do SEM BASE: sem amostra, a onda existe e serve para medir.
const ondaCega = an.admissao({
  janelas: { cinco: j(20, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: {}, cfg: { admissao: { margem: 0.7 } }, n: 10, nowS: NOW });
ok(ondaCega.veredito === 'sem_base', 'sem amostra o veredito é SEM BASE');
ok(ondaCega.onda && ondaCega.onda.tamanho === 2, 'e mesmo assim há uma onda pequena');
ok(ondaCega.onda.restantes === 8, 'com o resto explicitamente pendente');
ok(/medir/.test(ondaCega.onda.porque || ''), 'cujo propósito declarado é medir');
ok(!/base se forma sozinha/.test(ondaCega.motivo),
   'o motivo não convida mais a disparar tudo de uma vez');

/* -------------------------------- vigia -------------------------------- */
secao('vigia do workflow (D30) — fala no SubagentStop, sem ser chamado');

const estVigia = pct => fs.writeFileSync(path.join(TMP, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW, sessao: 'sV', pct5: pct, reset5: NOW + 3600,
    pct7: 10, reset7: NOW + 400000 }));
const vig = (ev, id) => hook('medidor.js',
  { hook_event_name: ev, agent_id: id || 'aV', agent_type: 'Explore', session_id: 'sV' });

fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ ligado: true }));

estVigia(40);
ok(vig('SubagentStop').trim() === '', 'abaixo do limiar, o vigia cala');

estVigia(82);
const falou = vig('SubagentStop');
ok(/systemMessage/.test(falou), 'acima do limiar, fala por systemMessage');
ok(/82%/.test(falou), 'e diz o percentual atual');
ok(/cabe/.test(falou), 'e manda consultar antes da próxima onda');
ok(!/"decision"|"continue"/.test(falou), 'mas nunca bloqueia — parar é decisão do agente (D17)');
ok(JSON.parse(falou.trim()) && true, 'a saída é JSON válido, senão o hook seria ignorado');

ok(vig('SubagentStop').trim() === '', 'não repete dentro do intervalo');
ok(vig('SubagentStart').trim() === '', 'e SubagentStart nunca fala');

// Faixa de 5%: durante workflow a cota anda rápido e cada faixa merece um aviso.
estVigia(91);
ok(/91%/.test(vig('SubagentStop')), 'nova faixa de 5% volta a falar');

// A chave geral desliga o vigia junto com o resto (D2).
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ ligado: false }));
estVigia(95);
ok(vig('SubagentStop').trim() === '', 'ferramenta desligada, o vigia some');
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(
  { ligado: true, vigia: { ligado: false } }));
ok(vig('SubagentStop').trim() === '', 'e dá para desligar só o vigia');
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ ligado: true }));

/* ------------------------- base de custo (D32) ------------------------- */
secao('base de custo — agrupada, e suja é melhor que nenhuma (D32)');

// Regressão do primeiro workflow real: 9 ondas medidas, 65% gastos em 63
// agentes, e o `cabe` respondia SEM BASE. Duas causas somadas.

// (1) Zero não é "de graça", é "abaixo da resolução". As únicas amostras
//     limpas eram as ondas mais CURTAS, que mediram 0% porque o percentual
//     vem em inteiro. Média das limpas = 0 → custo zero → SEM BASE.
const soZero = an.custoPorTipo([
  { tipo: 'Explore', custo5: 0, custo7: 0, dur_s: 94, limpa: true },
  { tipo: 'Explore', custo5: 0, custo7: 0, dur_s: 167, limpa: true },
  { tipo: 'Explore', custo5: 3, custo7: 0.2, dur_s: 900, limpa: false },
  { tipo: 'Explore', custo5: 3, custo7: 0.2, dur_s: 900, limpa: false },
]);
ok(soZero.__geral.media5 > 0, 'base limpa que soma zero não é aceita como custo');
ok(soZero.__geral.base === 'completa', 'e o cálculo cai para a base completa');
ok(soZero.__geral.nLimpa === 2, 'sem esquecer quantas eram limpas');
ok(soZero.__geral.n === 4, 'a base usada conta todas');

// (2) A base limpa continua preferida quando ela de fato mede alguma coisa.
const temLimpa = an.custoPorTipo([
  { tipo: 'Explore', custo5: 2, custo7: 0.1, dur_s: 600, limpa: true },
  { tipo: 'Explore', custo5: 99, custo7: 9, dur_s: 600, limpa: false },
]);
ok(temLimpa.__geral.base === 'limpa', 'havendo base limpa com custo, ela ganha');
ok(Math.abs(temLimpa.__geral.media5 - 2) < 0.001, 'e a suja não contamina o número');

// (3) Média AGRUPADA: soma dos custos ÷ soma dos agentes, não média de médias.
//     Cada participante carrega Δ_onda/n, então somar tudo dá ΣΔ/Σn — o
//     estimador que respeita o peso de cada onda.
//     Onda A: n=2, Δ=10 → 5 cada.  Onda B: n=8, Δ=8 → 1 cada.
//     Média de médias daria 3; agrupada dá 18/10 = 1.8.
const agrupada = an.custoPorTipo([].concat(
  Array.from({ length: 2 }, () => ({ tipo: 'X', custo5: 5, custo7: 0, dur_s: 100, limpa: true })),
  Array.from({ length: 8 }, () => ({ tipo: 'X', custo5: 1, custo7: 0, dur_s: 100, limpa: true }))));
ok(Math.abs(agrupada.__geral.media5 - 1.8) < 0.001,
   'a média é agrupada (18%/10 agentes = 1.8), não média de médias (3)');

// (4) O rótulo tem que dizer a verdade sobre a qualidade da base.
const admBase = an.admissao({
  janelas: { cinco: j(50, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: soZero, cfg: { admissao: { margem: 0.7 } }, n: 5, nowS: NOW });
ok(admBase.baseQualidade === 'completa', 'o resultado carrega a qualidade da base');
ok(admBase.baseLimpas === 2, 'e quantas amostras estavam sem contaminação');
ok(admBase.veredito !== 'sem_base', 'e com base contaminada ainda dá para decidir');

// (5) Quando tudo soma zero mesmo, o motivo tem que dizer a causa certa —
//     antes ele culpava a janela, que não tinha nada a ver.
const tudoZero = an.admissao({
  janelas: { cinco: j(50, NOW + 3 * 3600, 10), sete: j(5, NOW + 5 * 86400, 10) },
  custos: an.custoPorTipo([{ tipo: 'X', custo5: 0, custo7: 0, dur_s: 90, limpa: true }]),
  cfg: { admissao: { margem: 0.7 } }, n: 5, nowS: NOW });
ok(/curtas demais|inteiro/.test(tudoZero.motivo || ''),
   'custo zero é explicado pela resolução do percentual, não pela janela');
ok(!/nenhuma janela utilizável para comparar/.test(tudoZero.motivo || ''),
   'e não culpa mais a janela por um problema de medição');

/* ----------------------------- plataformas ----------------------------- */
secao('comando gerado por plataforma (o instalador nunca roda no CI dos outros)');

/*
 * Este projeto nasceu no Windows e o suporte a Linux/macOS foi escrito sem
 * nunca ter sido executado lá. O mínimo honesto é provar que o COMANDO gerado
 * está certo nas três plataformas, o que dá para fazer daqui: extrai-se a
 * função do instalador e roda-se com o módulo `path` de cada sistema.
 *
 * Usar o `path` da máquina atual faria o teste mentir — com o path do Windows,
 * um caminho POSIX volta cheio de barra invertida.
 */
const fonteInstalador = fs.readFileSync(path.join(__dirname, 'instalar.js'), 'utf8');
const fnComando = (fonteInstalador.match(/function comando\(script\)[\s\S]*?\n\}/) || [])[0];
ok(!!fnComando, 'a função comando() existe no instalar.js');

const montar = (plat, dir, node) => new Function(
  'WINDOWS', 'DIR', 'NODE', 'path', 'barras', fnComando + '; return comando;'
)(plat === 'win32', dir, node,
  plat === 'win32' ? path.win32 : path.posix, p => p.replace(/\\/g, '/'));

const cLinux = montar('linux', '/home/ana/cota', '/usr/bin/node')('sensor.js');
const cMac   = montar('darwin', '/Users/ana/cota', '/opt/homebrew/bin/node')('sensor.js');
const cWin   = montar('win32', 'C:\\Users\\Ana\\cota', 'C:\\node\\node.exe')('sensor.js');

ok(!/\\/.test(cLinux), 'no Linux o comando não leva barra invertida');
ok(!/\\/.test(cMac), 'no macOS idem');
ok(/^"\/usr\/bin\/node" "\/home\/ana\/cota\/sensor\.js"$/.test(cLinux),
   'no Linux é o node e o script, cada um entre aspas');
ok(/^"\/opt\/homebrew\/bin\/node" "\/Users\/ana\/cota\/sensor\.js"$/.test(cMac),
   'no macOS idem, com o caminho do Homebrew');
ok(!/powershell/.test(cLinux) && !/powershell/.test(cMac),
   'e nenhum dos dois invoca powershell');

ok(/^powershell -NoProfile -ExecutionPolicy Bypass -File /.test(cWin),
   'no Windows usa o formato documentado da Anthropic');
ok(/run\.ps1 sensor\.js$/.test(cWin), 'com o script como argumento do run.ps1');
ok(!/\\/.test(cWin), 'e o caminho do run.ps1 vai com barra normal (o cmd.exe exige)');

// O comando é guardado dentro do settings.json: tem que sobreviver ao JSON.
for (const [rot, c] of [['linux', cLinux], ['macOS', cMac], ['Windows', cWin]]) {
  ok(JSON.parse(JSON.stringify({ command: c })).command === c,
     'o comando de ' + rot + ' sobrevive à ida e volta pelo settings.json');
}

// O atalho POSIX precisa existir e ser shell de verdade, senão Linux e macOS
// ficam sem equivalente do cota.cmd.
const atalho = path.join(__dirname, 'cota');
ok(fs.existsSync(atalho), 'existe o atalho POSIX `cota`');
const shAtalho = fs.existsSync(atalho) ? fs.readFileSync(atalho, 'utf8') : '';
ok(/^#!\/bin\/sh/.test(shAtalho), 'e ele começa com shebang de sh');
ok(!/\r/.test(shAtalho), 'sem CR: com CRLF o Linux responde "bad interpreter"');
ok(/node-local\.txt/.test(shAtalho) && /COTA_NODE/.test(shAtalho),
   'e procura o node na mesma ordem dos outros invólucros');

/* --------------------- README x instalador --------------------- */
secao('a instalação manual do README bate com a que o instalador faz');

/*
 * O README ensina a instalar na mão, para ninguém depender do instalador.
 * Documentação e código divergem em SILÊNCIO: alguém muda o instalador, a
 * receita manual continua parecendo certa e produz uma instalação diferente.
 * Aqui os dois são comparados de verdade.
 */
const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const blocoJson = (readme.match(/```json\n([\s\S]*?)```/) || [])[1];
ok(!!blocoJson, 'o README tem o bloco de settings.json da instalação manual');

const PASTA = 'C:/proj/cota';
let cfgManual = null;
try { cfgManual = JSON.parse(blocoJson.split('<PASTA>').join(PASTA)); } catch (_) {}
ok(!!cfgManual, 'e esse bloco é JSON válido depois de trocar <PASTA>');

if (cfgManual) {
  // O mesmo gerador que o instalador usa, com a plataforma forçada.
  const cmdWin = new Function('WINDOWS', 'DIR', 'NODE', 'path', 'barras',
    fnComando + '; return comando;')(true, PASTA, 'C:\\node\\node.exe',
    path.posix, p => p.replace(/\\/g, '/'));

  ok(cfgManual.statusLine.command === cmdWin('sensor.js'),
     'a status line do README é a mesma que o instalador escreve');
  ok(cfgManual.statusLine.refreshInterval === 20,
     'com o mesmo refreshInterval');

  const esperado = {
    UserPromptSubmit: 'hooks/aviso.js',
    PreToolUse:       'hooks/admissao.js',
    SubagentStart:    'hooks/medidor.js',
    SubagentStop:     'hooks/medidor.js',
  };
  for (const [evento, script] of Object.entries(esperado)) {
    const g = (cfgManual.hooks || {})[evento];
    ok(!!g && g[0] && g[0].hooks[0].command === cmdWin(script),
       'o hook ' + evento + ' do README bate com o do instalador');
  }
  ok(cfgManual.hooks.PreToolUse[0].matcher === 'Agent|Task|Workflow',
     'e o matcher do PreToolUse é o mesmo');

  // O instalador registra exatamente estes quatro eventos: nem a mais, nem a
  // menos. Se alguém acrescentar um hook e esquecer o README, cai aqui.
  const noInstalador = (fonteInstalador.match(/^\s{4}(\w+):\s*\{ script:/gm) || [])
    .map(l => l.trim().split(':')[0]);
  ok(noInstalador.length === 4, 'o instalador registra quatro hooks');
  ok(noInstalador.every(e => e in cfgManual.hooks),
     'e todos eles estão documentados no README');
  ok(Object.keys(cfgManual.hooks).every(e => noInstalador.includes(e)),
     'sem o README documentar nenhum que o instalador não põe');
}

/* --------------------- concorrência e versão --------------------- */
secao('N hooks ao mesmo tempo (D33) e mudança de versão (D34)');

/*
 * Regressão medida no diretório real: havia 6 `onda-atual.json.<pid>.tmp`
 * órfãos, cada um com uma lista de participantes dentro. A versão antiga
 * guardava essa lista num arquivo único que todo subagente lia, alterava e
 * regravava — com N hooks simultâneos isso perde dado de duas formas: o rename
 * do Windows falha com EPERM quando outro processo tem o destino aberto, e os
 * que passam se sobrescrevem (atualização perdida).
 *
 *     8 simultâneos  ->  3 de 8 perdidos
 *    16 simultâneos  ->  9 de 16 perdidos
 *
 * `n` subcontado infla `custo/n`. Erra para o lado seguro, mas erra — e piora
 * justo quando a onda é grande, que é o caso para o qual isto existe.
 */
const TMPC = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-corrida-'));
fs.mkdirSync(path.join(TMPC, 'sessoes'), { recursive: true });
const ENVC = { CLAUDE_COTA_DIR: TMPC };
const lerLC = f => { try {
  return fs.readFileSync(path.join(TMPC, f), 'utf8').trim().split('\n')
    .filter(Boolean).map(JSON.parse);
} catch (_) { return []; } };
const estadoC = (t, pct) => fs.writeFileSync(path.join(TMPC, 'estado.json'),
  JSON.stringify({ t, t_confirmado: t, sessao: 's', pct5: pct, reset5: NOW + 9999,
                   pct7: 1, reset7: NOW + 400000 }));

const N_CONC = 12;
estadoC(NOW, 10);
const idsC = Array.from({ length: N_CONC }, (_, i) => 'c' + i);

// Todos os SubagentStart de uma vez, sem esperar um pelo outro — é isso que
// acontece num fan-out e é isso que quebrava.
const CONDUTOR = path.join(TMPC, '_condutor.js');
fs.writeFileSync(CONDUTOR, [
  "// Dispara N hooks de uma vez e espera todos. Precisa rodar num processo",
  "// próprio: o teste é síncrono, e bloquear a thread aqui impediria o stdin dos",
  "// filhos de ser escrito — foi assim que a primeira versão deste teste falhou,",
  "// acusando o código por um defeito do teste.",
  "const { spawn } = require('child_process');",
  "const ids = JSON.parse(process.argv[2]);",
  "const alvo = process.argv[3];",
  "const evento = process.argv[4];",
  "Promise.all(ids.map(id => new Promise(res => {",
  "  const c = spawn(process.execPath, [alvo], { stdio: ['pipe', 'ignore', 'ignore'] });",
  "  c.stdin.end(JSON.stringify({ hook_event_name: evento, agent_id: id,",
  "                               agent_type: 'Explore', session_id: 's' }));",
  "  c.on('close', () => res());",
  "}))).then(() => process.exit(0));"
].join(String.fromCharCode(10)));

const disparar = (evento, lista) => execFileSync(process.execPath,
  [CONDUTOR, JSON.stringify(lista), path.join(__dirname, 'hooks', 'medidor.js'), evento],
  { env: Object.assign({}, ENV, ENVC), encoding: 'utf8', timeout: 60000 });

disparar('SubagentStart', idsC);

const pastaParts = path.join(TMPC, 'onda-participantes');
const contarParts = () => { try {
  return fs.readdirSync(pastaParts).filter(n => n.endsWith('.json')).length;
} catch (_) { return 0; } };

ok(contarParts() === N_CONC,
   'os ' + N_CONC + ' participantes simultâneos foram todos registrados');
ok(fs.readdirSync(TMPC).filter(n => n.endsWith('.tmp')).length === 0,
   'e nenhum .tmp órfão ficou para trás');

estadoC(NOW + 2, 22);
for (const id of idsC) {
  hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: id,
                       agent_type: 'Explore', session_id: 's' }, ENVC);
}
const ondaC = lerLC('ondas.jsonl').pop();
ok(!!ondaC, 'a onda concorrente fechou');
ok(ondaC && ondaC.n === N_CONC, 'e contou os ' + N_CONC + ' participantes');
ok(ondaC && Math.abs(ondaC.custo5 - 12) < 0.001, 'com o Δ do período (10% → 22%)');
ok(lerLC('agentes.jsonl').slice(-N_CONC).every(a => Math.abs(a.custo5 - 1) < 0.001),
   'e 1% por agente (12% / 12)');

// A varredura de .tmp só mexe no que está velho, para nunca competir com uma
// gravação em curso de outro processo.
const tmpVelho = path.join(TMPC, 'estado.json.9999.tmp');
const tmpNovo = path.join(TMPC, 'estado.json.8888.tmp');
fs.writeFileSync(tmpVelho, '{}');
fs.writeFileSync(tmpNovo, '{}');
const antigo = new Date(Date.now() - 3600e3);
fs.utimesSync(tmpVelho, antigo, antigo);
execFileSync(process.execPath, ['-e',
  "const c=require(process.argv[1]);c.limparTmp(300);",
  path.join(__dirname, 'lib', 'core.js')], { env: Object.assign({}, ENV, ENVC) });
ok(!fs.existsSync(tmpVelho), 'limparTmp remove .tmp velho');
ok(fs.existsSync(tmpNovo), 'e preserva .tmp recente — pode ser gravação em curso');
fs.unlinkSync(tmpNovo);

/*
 * D34 — atualização do Claude Code invalida a conferência.
 *
 * A ferramenta lê contratos oficiais (JSON da status line, eventos de hook), e
 * versão nova pode mexer neles. O modo de falha é silencioso: o sensor continua
 * rodando e só não acha mais o que procurava. Comparar a versão de agora com a
 * da última aferição custa nada.
 */
fs.writeFileSync(path.join(TMPC, 'batimento.json'), JSON.stringify(
  { t: NOW, tinha_rate_limits: true, sessao: 's', versao: '9.9.9' }));
fs.writeFileSync(path.join(TMPC, 'afericoes.jsonl'), JSON.stringify(
  { t: NOW - 100, nosso5: 10, nosso7: 1, bateu: true, versao: '1.1.1' }) + '\n');
const auditVelho = cli(['audit'], ENVC);
ok(/1\.1\.1/.test(auditVelho) && /9\.9\.9/.test(auditVelho),
   'audit mostra a versão da aferição e a de agora');
ok(/revalide/.test(auditVelho), 'e manda revalidar com o /usage');

fs.writeFileSync(path.join(TMPC, 'afericoes.jsonl'), JSON.stringify(
  { t: NOW - 100, nosso5: 10, nosso7: 1, bateu: true, versao: '9.9.9' }) + '\n');
ok(!/revalide/.test(cli(['audit'], ENVC)), 'mesma versão não pede revalidação');

/* ------------------ mural congelado (D24 no medidor) ------------------ */
secao('sessão de terminal ociosa não vira onda de custo zero');

/*
 * Cenário real de quem trabalha na extensão do VS Code: ela não executa status
 * line, então quem alimenta o mural é uma janela de terminal — que pode ficar
 * ociosa. Ociosa, ela roda o sensor a cada 20s e regrava o MESMO número: `t`
 * avança, o percentual não.
 *
 * A guarda de frescor comparava `est.t`, então passava, e a onda era gravada
 * custando 0%. Medição falsa com cara de verdadeira — e ela puxa a média para
 * baixo, o lado PERIGOSO de errar (dizer que cabem mais agentes do que cabem).
 */
const TMPO = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-ociosa-'));
fs.mkdirSync(path.join(TMPO, 'sessoes'), { recursive: true });
const ENVO = { CLAUDE_COTA_DIR: TMPO };
const lerLO = f => { try {
  return fs.readFileSync(path.join(TMPO, f), 'utf8').trim().split('\n')
    .filter(Boolean).map(JSON.parse);
} catch (_) { return []; } };
// t avança (o sensor rodou), t_confirmado não (nada novo chegou da API).
const congelado = t => fs.writeFileSync(path.join(TMPO, 'estado.json'), JSON.stringify(
  { t, t_confirmado: NOW, sessao: 's', pct5: 30, reset5: NOW + 9999,
    pct7: 5, reset7: NOW + 400000 }));

congelado(NOW + 10);
hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'o1',
                     agent_type: 'Explore', session_id: 's' }, ENVO);
congelado(NOW + 300);   // 5 minutos de status line rodando, valor parado
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'o1',
                     agent_type: 'Explore', session_id: 's' }, ENVO);

ok(lerLO('ondas.jsonl').length === 0,
   'mural sem confirmação nova não gera onda, mesmo com `t` avançando');
ok(lerLO('agentes.jsonl').length === 0, 'e nenhuma amostra de custo zero é criada');

// Com confirmação nova, a mesma onda é medida normalmente.
fs.writeFileSync(path.join(TMPO, 'estado.json'), JSON.stringify(
  { t: NOW + 400, t_confirmado: NOW + 400, sessao: 's', pct5: 30, reset5: NOW + 9999,
    pct7: 5, reset7: NOW + 400000 }));
hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: 'o2',
                     agent_type: 'Explore', session_id: 's' }, ENVO);
fs.writeFileSync(path.join(TMPO, 'estado.json'), JSON.stringify(
  { t: NOW + 500, t_confirmado: NOW + 500, sessao: 's', pct5: 34, reset5: NOW + 9999,
    pct7: 5, reset7: NOW + 400000 }));
hook('medidor.js', { hook_event_name: 'SubagentStop', agent_id: 'o2',
                     agent_type: 'Explore', session_id: 's' }, ENVO);

const oo = lerLO('ondas.jsonl');
ok(oo.length === 1, 'confirmação nova volta a produzir onda');
ok(oo[0] && oo[0].custo5 === 4, 'com o Δ real (30% → 34%)');

/* -------------------- diagnóstico e endurecimento -------------------- */
secao('diagnóstico do mural (D36) e validação de entrada (D37)');

const TMPD = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-diag-'));
fs.mkdirSync(path.join(TMPD, 'sessoes'), { recursive: true });
const ENVD = { CLAUDE_COTA_DIR: TMPD };
const cliD = args => cli(args, ENVD);

/*
 * Três situações levam a "não funciona", com consertos diferentes. Documentar
 * não resolve: quem instala não lê e reclama. A mensagem na hora do problema
 * é a documentação.
 */
// (a) sensor nunca rodou — o caso de quem instalou e só usa a extensão
const semNada = cliD([]);
ok(/nunca foi executado/i.test(semNada), 'sem batimento: diz que o sensor nunca rodou');
ok(/EXTENS(Ã|A)O DO VS CODE/i.test(semNada),
   'e aponta a extensão do VS Code como causa mais comum');
ok(/\/loop 3m/.test(semNada), 'e entrega o comando do loop, não só a explicação');
ok(/TERMINAL/i.test(semNada), 'mandando abrir uma janela de terminal');

// (b) sensor rodou mas parou — a janela foi fechada
fs.writeFileSync(path.join(TMPD, 'batimento.json'), JSON.stringify(
  { t: NOW - 3600, tinha_rate_limits: true, sessao: 'x', versao: '2.1.235' }));
const parou = cliD([]);
ok(/última vez há 1h00/.test(parou), 'batimento velho: diz há quanto tempo parou');
ok(/foi fechada/.test(parou), 'e culpa a janela fechada, não a extensão');

// (c) terminal aberto e ocioso — o caso que mais engana, porque o sensor roda
fs.writeFileSync(path.join(TMPD, 'batimento.json'), JSON.stringify(
  { t: NOW, tinha_rate_limits: true, sessao: 'x', versao: '2.1.235' }));
fs.writeFileSync(path.join(TMPD, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW - 5400, sessao: 'x', pct5: 40, reset5: NOW + 7200,
    pct7: 5, reset7: NOW + 400000 }));
const ocioso = cliD([]);
ok(/valor não muda há 1h30/.test(ocioso),
   'sensor rodando mas valor parado: distingue observação de confirmação');
ok(/ociosa/.test(ocioso), 'e explica que a janela está ociosa');
ok(/\/loop 3m/.test(ocioso), 'com a receita');
ok(!/Abra uma janela de TERMINAL/.test(ocioso),
   'sem mandar abrir terminal — já tem um aberto');

// (d) tudo certo: nada de aviso. Alarme que sempre aparece ninguém lê.
fs.writeFileSync(path.join(TMPD, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW, sessao: 'x', pct5: 40, reset5: NOW + 7200,
    pct7: 5, reset7: NOW + 400000 }));
const bom = cliD([]);
ok(!/\/loop 3m/.test(bom), 'mural saudável não mostra receita nenhuma');
ok(!/⚠/.test(bom) || !/sensor/.test(bom), 'nem aviso de sensor');

/*
 * D37 — config valida o tipo contra o padrão.
 *
 * `cota config aviso.limiar_5h abc` gravava a string. Nada explodia: a
 * comparação `pct < "abc"` dá false para sempre e o aviso parava de disparar —
 * para sempre, sem erro e sem sintoma. Numa ferramenta cujo produto é o aviso,
 * é o pior desfecho possível.
 */
ok(/espera um número/.test(cliD(['config', 'aviso.limiar_5h', 'abc'])),
   'config recusa texto onde espera número');
ok(/percentual/.test(cliD(['config', 'aviso.limiar_5h', '150'])),
   'e recusa percentual fora de 0–100');
ok(/espera true ou false/.test(cliD(['config', 'aviso.ligado', 'talvez'])),
   'recusa valor não booleano onde espera booleano');
ok(/fração/.test(cliD(['config', 'admissao.margem', '5'])),
   'e margem fora de 0–1');
cliD(['config', 'aviso.limiar_5h', '70']);
ok(core.lerJson(path.join(TMPD, 'config.json'), {}).aviso.limiar_5h === 70,
   'valor válido é gravado como número, não como texto');

// Higiene de protótipo: quem escreve no config.json já está no home do
// usuário, mas objeto vindo de JSON não deveria trocar protótipo de nada.
fs.writeFileSync(path.join(TMPD, 'config.json'),
  '{"__proto__":{"poluido":"SIM"},"ligado":true}');
const limpo = core.semProto(JSON.parse(
  fs.readFileSync(path.join(TMPD, 'config.json'), 'utf8')));
// `'__proto__' in obj` é sempre true (herdado de Object.prototype), então a
// pergunta certa é sobre as chaves PRÓPRIAS.
ok(!Object.keys(limpo).includes('__proto__'),
   'semProto remove __proto__ das chaves próprias do objeto lido');
ok(Object.keys(limpo).includes('ligado'), 'e preserva as chaves legítimas');
ok(Object.getPrototypeOf(Object.assign({}, limpo)) === Object.prototype,
   'e o objeto resultante mantém o protótipo normal');
ok(({}).poluido === undefined, 'Object.prototype global segue limpo');

/*
 * D38 — poda. `lerHistorico()` lê TODOS os arquivos de sessão a cada hook, e
 * hooks rodam a cada subagente e a cada mensagem. Sem poda, cada subagente
 * passa a pagar uma leitura por sessão que já existiu.
 */
const TMPP = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-poda-'));
fs.mkdirSync(path.join(TMPP, 'sessoes'), { recursive: true });
const velhoMs = Date.now() - 30 * 86400000;
for (const n of ['antiga1', 'antiga2', 'recente']) {
  const p = path.join(TMPP, 'sessoes', n + '.jsonl');
  fs.writeFileSync(p, JSON.stringify({ t: NOW }) + String.fromCharCode(10));
  if (n !== 'recente') fs.utimesSync(p, new Date(velhoMs), new Date(velhoMs));
}
fs.writeFileSync(path.join(TMPP, 'agentes.jsonl'),
  Array.from({ length: 12000 }, (_, i) => JSON.stringify({ i }))
    .join(String.fromCharCode(10)));
const podaSaida = execFileSync(process.execPath, ['-e',
  "const c=require(process.argv[1]);console.log(JSON.stringify(c.podar(14,5000)));",
  path.join(__dirname, 'lib', 'core.js')],
  { encoding: 'utf8', env: Object.assign({}, ENV, { CLAUDE_COTA_DIR: TMPP }) });
const rp = JSON.parse(podaSaida);
ok(rp.removidos === 2, 'poda remove as sessões sem uso há mais de 14 dias');
ok(fs.existsSync(path.join(TMPP, 'sessoes', 'recente.jsonl')),
   'e nunca remove a mais recente — é ela que alimenta o mural');
ok(fs.readFileSync(path.join(TMPP, 'agentes.jsonl'), 'utf8')
     .split(String.fromCharCode(10)).filter(Boolean).length === 5000,
   'e trunca o arquivo de amostras no limite');

// Travessia de caminho: id de agente é usado como nome de arquivo.
const TMPT = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-trav-'));
fs.mkdirSync(path.join(TMPT, 'sessoes'), { recursive: true });
fs.writeFileSync(path.join(TMPT, 'estado.json'), JSON.stringify(
  { t: NOW, t_confirmado: NOW, sessao: 's', pct5: 10, reset5: NOW + 9999,
    pct7: 1, reset7: NOW + 400000 }));
const canario = path.join(path.dirname(TMPT), 'CANARIO-COTA.txt');
try { fs.unlinkSync(canario); } catch (_) {}
for (const mau of ['../../CANARIO-COTA', '..\\..\\CANARIO-COTA', '/etc/passwd']) {
  hook('medidor.js', { hook_event_name: 'SubagentStart', agent_id: mau,
                       agent_type: 'X', session_id: mau },
       { CLAUDE_COTA_DIR: TMPT });
}
ok(!fs.existsSync(canario), 'id de agente com ../ não escreve fora do diretório');
ok(fs.readdirSync(path.dirname(TMPT)).filter(n => /CANARIO/.test(n)).length === 0,
   'e nada vaza para o diretório pai');

/* -------------------------------- fim -------------------------------- */
console.log('');
console.log(falhas === 0
  ? C.g + C.b + '  tudo passou' + C.r
  : C.v + C.b + '  ' + falhas + ' falha(s)' + C.r);
console.log('');
process.exit(falhas === 0 ? 0 : 1);
