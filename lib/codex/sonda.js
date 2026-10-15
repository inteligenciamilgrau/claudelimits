'use strict';
/*
 * codex/sonda.js — a parte da sonda que muda no Codex.
 *
 * O laço da sonda (cache, trava, histórico) é o mesmo do Claude e mora em
 * lib/sonda.js. Daqui saem só as três peças que dependem do Codex:
 *
 *   candidatos()   onde procurar o executável: PATH, ~/.local/bin e o
 *                  binário embutido na extensão openai.chatgpt do editor
 *   executar()     roda o rpc.js, que conversa com `codex app-server`
 *   interpretar()  converte a resposta de account/rateLimits/read no mesmo
 *                  formato de leitura que o Claude grava
 *
 * E uma regra a mais: medição de uma conta (ou plano) nunca vale para outra.
 * Quando a conta muda, a base antiga vai para cota/arquivo/ (separarConta).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const core = require('../core');
const win = process.platform === 'win32';

function candidatos(env = process.env, home = os.homedir()) {
  if (env.COTA_CODEX) return path.isAbsolute(env.COTA_CODEX) && fs.existsSync(env.COTA_CODEX) ? [env.COTA_CODEX] : [];
  const result = [];
  const add = p => { if (path.isAbsolute(p) && fs.existsSync(p) && !result.includes(p)) result.push(p); };
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (path.isAbsolute(dir)) add(path.join(dir, win ? 'codex.exe' : 'codex'));
  }
  add(path.join(home, '.local', 'bin', win ? 'codex.exe' : 'codex'));
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const root = path.join(home, editor, 'extensions');
    let names;
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    const obsolete = core.lerJson(path.join(root, '.obsolete'), {});
    const registry = core.lerJson(path.join(root, 'extensions.json'), []);
    const installed = (Array.isArray(registry) ? registry : [])
      .filter(e => e.identifier && e.identifier.id === 'openai.chatgpt')
      .map(e => e.relativeLocation || path.basename((e.location || {}).path || ''));
    const sorted = names.filter(n => /^openai\.chatgpt-/.test(n)).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }));
    for (const name of [...installed, ...sorted]) {
      if (!/^openai\.chatgpt-/.test(name) || path.basename(name) !== name || obsolete[name]) continue;
      const platform = win ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      add(path.join(root, name, 'bin', platform + '-' + arch, win ? 'codex.exe' : 'codex'));
    }
  }
  return result;
}

function interpretar(saida, nowS) {
  const fail = erro => ({ ok: false, erro, snap: null, plano: null });
  let envelope;
  try { envelope = JSON.parse(saida); } catch (_) { return fail('Resposta JSON inválida do Codex'); }
  if (envelope.error) return fail(envelope.error);
  const r = envelope.result;
  if (!r || typeof r !== 'object') return fail('Codex não retornou limites');
  const bucket = r.rateLimitsByLimitId && r.rateLimitsByLimitId.codex || r.rateLimits;
  if (!bucket || (bucket.limitId && bucket.limitId !== 'codex')) return fail('Não há limite geral codex; confira o login ChatGPT');
  const valid = w => w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) &&
    w.usedPercent >= 0 && w.usedPercent <= 100 && Number.isFinite(w.resetsAt) && w.resetsAt > 0;
  const windows = [bucket.primary, bucket.secondary];
  const five = windows.find(w => valid(w) && w.windowDurationMins === 300);
  const week = windows.find(w => valid(w) && w.windowDurationMins === 10080);
  if (!five && !week) return fail('Sem janelas válidas de 5h/7d; formato ou duração dos limites mudou');
  return { ok: true, erro: null, plano: bucket.planType || null, snap: {
    t: nowS, pct5: five ? five.usedPercent : null, reset5: five ? five.resetsAt : null,
    pct7: week ? week.usedPercent : null, reset7: week ? week.resetsAt : null,
    modelos: [], plano: bucket.planType || null, provider: 'codex',
    accountId: r.accountId || null, limites: r.rateLimitsByLimitId || { codex: bucket },
    creditos: bucket.credits || null, resets_disponiveis: r.rateLimitResetCredits?.availableCount ?? null,
  } };
}

function executar(exe, timeoutMs) {
  core.garantirDir();
  return execFileSync(process.execPath, [path.join(__dirname, 'rpc.js'), exe, String(Math.max(100, timeoutMs - 1500))], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: core.DIR,
    env: { ...process.env, COTA_SONDA_ATIVA: '1' }, maxBuffer: 9 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Preserve old measurements, but never use one account/plan's cost for another.
function separarConta(snap) {
  const old = core.lerEstado();
  if (!old || (old.accountId === snap.accountId && old.plano === snap.plano)) return;
  const archive = path.join(core.DIR, 'arquivo', Date.now() + '-' + process.pid);
  fs.mkdirSync(archive, { recursive: true });
  for (const key of ['estado', 'historico', 'agentes', 'trechos', 'marco', 'avisoUltimo', 'vigiaUltimo']) {
    const file = core.F[key];
    if (fs.existsSync(file)) fs.renameSync(file, path.join(archive, path.basename(file)));
  }
  for (const key of ['emVoo', 'terminados']) {
    const dir = core.F[key];
    if (fs.existsSync(dir)) fs.renameSync(dir, path.join(archive, path.basename(dir)));
  }
}
module.exports = { candidatos, interpretar, executar, separarConta };
