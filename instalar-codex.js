#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const hooksFile = path.join(root, 'hooks.json');
const skillFile = path.join(root, 'skills', 'cota-codex', 'SKILL.md');
const remove = process.argv.includes('--remover');
const checkOnly = process.argv.includes('--conferir');
const windows = process.platform === 'win32';
const definitions = {
  UserPromptSubmit: ['aviso', undefined, 30],
  PreToolUse: ['admissao', '^(Agent|spawn_agent)$', 30],
  SubagentStart: ['medidor', undefined, 30],
  SubagentStop: ['medidor', undefined, 60],
  SessionEnd: ['medidor', undefined, 3],
};
// Shell quoting is explicit; JSON quoting is not shell quoting.
const posix = s => "'" + s.replace(/'/g, "'\\''") + "'";
const ps = s => "'" + s.replace(/'/g, "''") + "'";
function command(mode) {
  if (windows) {
    const script = '$input | & ' + ps(process.execPath) + ' ' + ps(path.join(__dirname, 'hooks', 'codex.js')) + ' ' + mode;
    return 'powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  }
  return posix(process.execPath) + ' ' + posix(path.join(__dirname, 'hooks', 'codex.js')) + ' ' + mode;
}
const marker = 'cota-codex:';
const ours = h => typeof h?.statusMessage === 'string' && h.statusMessage.startsWith(marker);
function readHooks() {
  if (!fs.existsSync(hooksFile)) return {};
  const value = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('hooks.json inválido');
  if (value.hooks && (typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw Error('hooks inválido');
  for (const groups of Object.values(value.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) throw Error('Grupo de hooks inválido');
  }
  return value;
}
function install() {
  const value = readHooks(); // Parse before any writes.
  value.hooks ||= {};
  for (const [event, groups] of Object.entries(value.hooks)) {
    value.hooks[event] = groups.map(g => ({ ...g, hooks: g.hooks.filter(h => !ours(h)) }))
      .filter(g => g.hooks.length);
    if (!value.hooks[event].length) delete value.hooks[event];
  }
  if (!remove) for (const [event, [mode, matcher, timeout]] of Object.entries(definitions)) {
    (value.hooks[event] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{
      type: 'command', command: command(mode), timeout, statusMessage: marker + event,
    }] });
  }
  const invocation = windows
    ? '& ' + ps(process.execPath) + ' ' + ps(path.join(__dirname, 'cota-codex.js'))
    : posix(process.execPath) + ' ' + posix(path.join(__dirname, 'cota-codex.js'));
  const template = fs.readFileSync(path.join(__dirname, 'skill', 'SKILL.codex.modelo.md'), 'utf8');
  if (!remove && fs.existsSync(skillFile) && !fs.readFileSync(skillFile, 'utf8').includes('<!-- instalado por cota-codex -->'))
    throw Error('Já existe uma skill cota-codex não gerenciada por este instalador');
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(hooksFile)) {
    const backup = hooksFile + (remove ? '.bak-cota-codex-remover' : '.bak-cota-codex');
    if (!fs.existsSync(backup)) fs.copyFileSync(hooksFile, backup);
  }
  fs.writeFileSync(hooksFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  if (remove) {
    if (fs.existsSync(skillFile) && fs.readFileSync(skillFile, 'utf8').includes('<!-- instalado por cota-codex -->')) fs.unlinkSync(skillFile);
    console.log('Hooks e skill do cota-codex removidos. Histórico preservado.');
  } else {
    fs.writeFileSync(path.join(__dirname, 'node-local.txt'), process.execPath + '\n');
    if (!windows) fs.chmodSync(path.join(__dirname, 'cota-codex'), 0o755);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, template.replaceAll('{{COTA}}', invocation) + '\n<!-- instalado por cota-codex -->\n');
    console.log('Hooks e skill gravados. Conferindo a consulta...');
    check();
    console.log('Abra uma sessão local nova e use /hooks para revisar e confiar nas definições.');
    console.log('A consulta foi validada; a ativação dos hooks depende dessa revisão no Codex.');
  }
}
function check() {
  const output = execFileSync(process.execPath, [path.join(__dirname, 'cota-codex.js'), 'sondar', '--json'], {
    encoding: 'utf8', timeout: 45000, windowsHide: true,
  });
  const result = JSON.parse(output);
  if (!result.ok) throw Error(result.erro?.mensagem || result.erro || 'Consulta falhou');
  console.log(`Consulta OK (${result.ms}ms): 5h=${result.pct5}% consumidos, 7d=${result.pct7}% consumidos.`);
}
try { if (checkOnly) check(); else install(); }
catch (e) { console.error('cota-codex: ' + e.message); process.exitCode = 1; }
