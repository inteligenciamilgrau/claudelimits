'use strict';
// Small asynchronous worker, called synchronously by the shared cache layer.
// Never starts a thread or turn. Only initialize and account/rateLimits/read.
const { spawn } = require('child_process');
const readline = require('readline');
const [exe, budget] = process.argv.slice(2);
const args = ['app-server', '--stdio'];
const child = spawn(/\.js$/i.test(exe) ? process.execPath : exe,
  /\.js$/i.test(exe) ? [exe, ...args] : args,
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let done = false, initialized = false, size = 0;
const timer = setTimeout(() => finish('Timeout consultando o app-server'), Number(budget) || 25000);
function finish(error, result) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.stdin.destroy();
  child.kill();
  process.stdout.write(JSON.stringify(error ? { error } : { result }) + '\n');
}
function send(value) { child.stdin.write(JSON.stringify(value) + '\n'); }
child.on('error', e => finish('Não foi possível executar o Codex: ' + e.code));
child.stdin.on('error', () => finish('O Codex fechou a entrada antes de responder'));
// Drain stderr but do not persist diagnostics that may contain account data.
child.stderr.on('data', () => {});
child.on('exit', () => { if (!done) finish('O app-server encerrou antes de responder; confira codex login status'); });
child.stdout.on('data', data => {
  size += data.length;
  if (size > 8 * 1024 * 1024) finish('Resposta do app-server excedeu 8 MiB');
});
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  if (done) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.id !== 1 && msg.id !== 2) return;
  if (msg.error) return finish('RPC ' + msg.id + ': ' + String(msg.error.message || msg.error.code).slice(0, 300));
  if (msg.id === 1 && !initialized) {
    initialized = true;
    send({ method: 'initialized' });
    send({ id: 2, method: 'account/rateLimits/read' });
  } else if (msg.id === 2 && initialized) finish(null, msg.result);
});
send({ id: 1, method: 'initialize', params: {
  clientInfo: { name: 'cota', version: '1.0.0' }
} });
