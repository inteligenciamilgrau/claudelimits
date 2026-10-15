#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-codex-test-'));
const state = path.join(temp, 'estado');
const fake = path.join(temp, 'codex falso.js');
const calls = path.join(temp, 'calls.jsonl');
const data = path.join(temp, 'data.json');
const reset = Math.floor(Date.now() / 1000) + 10000;
let response = {
  accountId: 'account-test', rateLimits: { limitId: 'codex', planType: 'plus',
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: reset },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: reset + 200000 },
    credits: { balance: '12.5', hasCredits: true },
  }, rateLimitResetCredits: { availableCount: 3 },
};
const save = () => fs.writeFileSync(data, JSON.stringify(response));
save();
fs.writeFileSync(fake, `
const fs = require('fs'), rl = require('readline').createInterface({input:process.stdin});
let init = false, notified = false;
rl.on('line', line => {
 const m = JSON.parse(line);
 fs.appendFileSync(process.env.TEST_CALLS, line + '\\n');
 if(m.method==='initialize') { init=true; console.log(JSON.stringify({id:m.id,result:{}})); }
 else if(m.method==='initialized' && init) notified=true;
 else if(m.method==='account/rateLimits/read' && notified) {
   if(process.env.TEST_MODE==='hang') return;
   if(process.env.TEST_MODE==='error') console.log(JSON.stringify({id:m.id,error:{message:'not authenticated'}}));
   else { console.log(JSON.stringify({method:'notice',params:{}})); console.log(JSON.stringify({id:m.id,result:JSON.parse(fs.readFileSync(process.env.TEST_DATA,'utf8'))})); }
 } else process.exit(4);
});
`);
const env = { ...process.env, COTA_PROVIDER: 'codex', COTA_CODEX: fake, COTA_CODEX_DIR: state,
  TEST_CALLS: calls, TEST_DATA: data };
const run = (file, args = [], input = '', extra = {}) => execFileSync(process.execPath,
  [path.join(__dirname, file), ...args], { env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 45000, windowsHide: true });
const json = (args = []) => JSON.parse(run('cota-codex.js', args));
const read = name => JSON.parse(fs.readFileSync(path.join(state, name), 'utf8'));
const hook = (event, extra = {}) => run('hooks/codex.js', ['medidor'], JSON.stringify({
  hook_event_name: event, session_id: 'thread-test', agent_id: 'agent-test', agent_type: 'worker', ...extra,
}));
let passed = 0;
function test(label, fn) { fn(); passed++; console.log('PASS ' + label); }
test('handshake real em pipes, notificações ignoradas e metadados', () => {
  const r = json(['sondar', '--json']); assert.equal(r.ok, true); assert.equal(r.snap.pct5, 20);
  assert.equal(r.snap.creditos.balance, '12.5'); assert.equal(r.snap.resets_disponiveis, 3);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l).method),
    ['initialize', 'initialized', 'account/rateLimits/read']);
});
test('cache evita outra consulta e cabe começa SEM BASE', () => {
  const before = fs.readFileSync(calls, 'utf8');
  assert.equal(json(['--json']).provider, 'codex');
  assert.equal(json(['cabe', '4', '--json']).veredito, 'sem_base');
  assert.equal(fs.readFileSync(calls, 'utf8'), before);
});
test('início/fim mede delta e duração, Stop retorna JSON', () => {
  hook('SubagentStart');
  for (const name of ['em-voo/agent-test.json', 'marco.json']) {
    const v = read(name); if (v.t0_ms) v.t0_ms -= 180000; if (v.t_ms) v.t_ms -= 180000;
    fs.writeFileSync(path.join(state, name), JSON.stringify(v));
  }
  response.rateLimits.primary.usedPercent = 23; save();
  JSON.parse(hook('SubagentStop'));
  const segment = fs.readFileSync(path.join(state, 'trechos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).pop();
  assert.equal(segment.d5, 3); assert.ok(segment.seg >= 180);
  assert.ok(fs.existsSync(path.join(state, 'agentes.jsonl')));
});
test('perfis mistos e troca de modelo não contaminam estimativas', () => {
  const eventA = { agent_id: 'profile-a', model: 'model-a', reasoning_effort: 'high', speed_mode: 'standard' };
  const eventB = { agent_id: 'profile-b', model: 'model-b', reasoning_effort: 'high', speed_mode: 'standard' };
  hook('SubagentStart', eventA); hook('SubagentStart', eventB);
  hook('SubagentStop', eventA);
  response.rateLimits.primary.usedPercent += 2; save();
  hook('SubagentStop', eventB);
  const segments = () => fs.readFileSync(path.join(state, 'trechos.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(segments().at(-1).misto, true);
  assert.equal(json(['cabe', '2', '--modelo', 'model-a', '--esforco', 'high', '--velocidade', 'standard', '--json']).veredito, 'sem_base');
  hook('SubagentStart', eventA);
  hook('SubagentStop', { ...eventA, model: 'changed-model' });
  assert.equal(segments().at(-1).misto, true);
  const durations = fs.readFileSync(path.join(state, 'agentes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(durations.at(-1).misto, true);
});
test('diagnóstico observa ciclos sem alegar origem automática', () => {
  const h = json(['--json']).hooks;
  assert.equal(h.coleta, 'ciclo_observado'); assert.ok(h.ciclos_observados >= 4);
  assert.match(h.aviso, /não certificam a origem automática/);
  assert.equal(h.revisao_confianca, 'nao_verificada');
});
test('admissão Codex injeta contexto sem ask e aviso entrega contexto', () => {
  response.rateLimits.primary.usedPercent = 85; save(); json(['sondar', '--json']);
  const r = JSON.parse(run('hooks/codex.js', ['admissao'], JSON.stringify({ tool_name: 'spawn_agent' })));
  assert.ok(r.hookSpecificOutput.additionalContext.includes('85'));
  assert.equal(r.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(JSON.parse(run('hooks/codex.js', ['aviso'], '{}')).hookSpecificOutput.additionalContext);
});
test('SessionEnd limpa órfãos sem consultar rede', () => {
  hook('SubagentStart');
  const before = fs.readFileSync(calls, 'utf8'); hook('SessionEnd');
  assert.equal(fs.existsSync(path.join(state, 'em-voo/agent-test.json')), false);
  assert.equal(fs.readFileSync(calls, 'utf8'), before);
});
test('erro RPC preserva último snapshot, não inventa zero', () => {
  const before = read('estado.json');
  let r;
  try { run('cota-codex.js', ['sondar', '--json'], '', { TEST_MODE: 'error' }); assert.fail('esperava exit 1'); }
  catch (e) { assert.equal(e.status, 1); r = JSON.parse(e.stdout); }
  assert.equal(r.ok, false); assert.match(r.erro.mensagem, /authenticated/); assert.deepEqual(read('estado.json'), before);
});
test('timeout encerra worker e retorna erro estruturado', () => {
  const r = JSON.parse(run('lib/codex-rpc.js', [fake, '300'], '', { TEST_MODE: 'hang' }));
  assert.match(r.error, /Timeout/);
});
test('parser valida duração, limites ausentes e percentual inválido', () => {
  const { interpretar } = require('./lib/codex');
  const parse = r => interpretar(JSON.stringify({ result: r }), 1);
  assert.equal(parse({}).ok, false);
  assert.equal(parse({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: reset } } }).ok, false);
  assert.equal(parse({ rateLimits: { primary: { usedPercent: '20', windowDurationMins: 300, resetsAt: reset } } }).ok, false);
  assert.equal(parse({ rateLimits: { secondary: response.rateLimits.secondary } }).snap.pct5, null);
});
test('troca de conta arquiva base; não herda custo', () => {
  response.accountId = 'account-other'; save(); json(['sondar', '--json']);
  assert.equal(json(['cabe', '4', '--json']).veredito, 'sem_base');
  assert.equal(read('estado.json').accountId, 'account-other');
  assert.ok(fs.readdirSync(path.join(state, 'arquivo')).length);
});
test('off impede status de sondar e hooks de medir', () => {
  json(['sondar', '--json']); run('cota-codex.js', ['off']);
  const before = fs.readFileSync(calls, 'utf8');
  try { json(['--json']); assert.fail('esperava exit 2'); }
  catch (e) { assert.equal(e.status, 2); assert.equal(JSON.parse(e.stdout).erro.codigo, 'DESATIVADA'); }
  hook('SubagentStart');
  assert.equal(fs.readFileSync(calls, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(state, 'em-voo/agent-test.json')), false);
  run('cota-codex.js', ['on']);
});
test('instalador idempotente preserva hooks alheios e remove somente os seus', () => {
  const project = path.join(temp, 'projeto com espaço'); fs.mkdirSync(project);
  function copy(src, dest) {
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dest, name));
    } else fs.copyFileSync(src, dest);
  }
  for (const name of ['lib', 'hooks', 'skill', 'instalar-codex.js', 'cota-codex.js', 'cota-codex', 'cota.js'])
    copy(path.join(__dirname, name), path.join(project, name));
  const home = path.join(temp, 'codex home'); fs.mkdirSync(home);
  const file = path.join(home, 'hooks.json');
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } };
  fs.writeFileSync(file, JSON.stringify(original));
  const install = args => execFileSync(process.execPath, [path.join(project, 'instalar-codex.js'), ...args],
    { env: { ...env, CODEX_HOME: home }, encoding: 'utf8', timeout: 45000, windowsHide: true });
  install([]); const first = fs.readFileSync(file, 'utf8'); install([]);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  const config = JSON.parse(first);
  assert.equal(config.hooks.SessionEnd[0].hooks[0].timeout, 3);
  const skill = fs.readFileSync(path.join(home, 'skills/cota-codex/SKILL.md'), 'utf8');
  assert.ok(!skill.includes('{{COTA}}'));
  // Execute the generated command, including Windows quoting and paths with spaces.
  const cmd = config.hooks.SubagentStart[0].hooks[0].command;
  const input = JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'wrapped', agent_id: 'wrapped', agent_type: 'worker' });
  if (process.platform === 'win32') {
    const encoded = cmd.split(' ').pop();
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { env, input, windowsHide: true, timeout: 30000 });
  } else execFileSync('/bin/sh', ['-c', cmd], { env, input, timeout: 30000 });
  assert.equal(read('em-voo/wrapped.json').sessao, 'wrapped');
  install(['--remover']); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.ok(!fs.existsSync(path.join(home, 'skills/cota-codex/SKILL.md')));
});
test('descoberta respeita extensão instalada e ignora obsoletas', () => {
  const { candidatos } = require('./lib/codex');
  const home = path.join(temp, 'discovery');
  const ext = path.join(home, '.vscode', 'extensions');
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const bins = ['openai.chatgpt-1.0.0', 'openai.chatgpt-2.0.0'].map(n => {
    const f = path.join(ext, n, 'bin', platform + '-' + arch, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f;
  });
  fs.writeFileSync(path.join(ext, '.obsolete'), JSON.stringify({ 'openai.chatgpt-2.0.0': true }));
  fs.writeFileSync(path.join(ext, 'extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, relativeLocation: 'openai.chatgpt-1.0.0' }]));
  assert.deepEqual(candidatos({ PATH: '.' }, home), [bins[0]]);
  assert.deepEqual(candidatos({ COTA_CODEX: 'relative.exe' }, home), []);
});
console.log(`${passed} testes Codex passaram. Fixtures: ${temp}`);
