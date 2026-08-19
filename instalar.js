#!/usr/bin/env node
'use strict';
/*
 * instalar.js — liga o cota ao Claude Code desta máquina.
 *
 * Rode com o node que você quer usar:
 *   node instalar.js
 *
 * O repositório não contém caminho absoluto nenhum, de propósito. Este script
 * é quem descobre os caminhos daqui e escreve as três coisas que precisam
 * deles:
 *
 *   1. node-local.txt          — onde está o node (fica fora do git)
 *   2. ~/.claude/skills/cota/  — a skill, com o comando literal montado
 *   3. ~/.claude/settings.json — status line + hooks
 *
 * A skill precisa do caminho literal por decisão de projeto (D27): um agente
 * que nunca viu a ferramenta não deveria ter que substituir placeholder. Por
 * isso o repo guarda um modelo e a instalação gera o literal.
 *
 * É idempotente: rodar de novo não duplica nada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const NODE = process.execPath;
const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const WINDOWS = process.platform === 'win32';

const barras = p => p.replace(/\\/g, '/');
const feito = [];
const pulado = [];

/*
 * O comando que o Claude Code vai executar.
 *
 * No Windows tem que ser `powershell ... -File run.ps1 <script>`: o executável
 * precisa ser um NOME SIMPLES no PATH e o caminho precisa ir como ARGUMENTO.
 * Os dois jeitos óbvios falham, cada um num shell — o cmd.exe lê o "/c" de
 * "/claude-limits" como switch dele, e o bash come as barras invertidas. E os
 * dois falham CALADOS. Fora do Windows não existe esse problema.
 */
function comando(script) {
  if (WINDOWS) {
    return 'powershell -NoProfile -ExecutionPolicy Bypass -File ' +
           barras(path.join(DIR, 'run.ps1')) + ' ' + script;
  }
  return JSON.stringify(NODE) + ' ' + JSON.stringify(path.join(DIR, script));
}

/* ------------------------- 1. caminho do node ------------------------- */

/*
 * O git carrega o bit de execução, mas quem baixa o projeto como .zip perde
 * ele — e aí `./cota` responde "Permission denied", que parece defeito do
 * programa e é só permissão. Barato de garantir, então garante.
 */
function marcarExecutaveis() {
  if (WINDOWS) return;
  for (const nome of ['cota', 'cota.js', 'sensor.js', 'instalar.js', 'teste.js',
                      'hooks/aviso.js', 'hooks/admissao.js', 'hooks/medidor.js']) {
    const p = path.join(DIR, nome);
    if (!fs.existsSync(p)) continue;
    try {
      const modo = fs.statSync(p).mode;
      if (modo & 0o111) continue;              // já executável
      fs.chmodSync(p, modo | 0o755);
      feito.push('chmod +x ' + nome);
    } catch (_) { /* sistema de arquivos sem permissão POSIX: segue */ }
  }
}

function gravarNodeLocal() {
  const alvo = path.join(DIR, 'node-local.txt');
  const atual = fs.existsSync(alvo) ? fs.readFileSync(alvo, 'utf8').trim() : null;
  if (atual === NODE) { pulado.push('node-local.txt (já aponta para este node)'); return; }
  fs.writeFileSync(alvo, NODE + '\n');
  feito.push('node-local.txt → ' + NODE);
}

/* ----------------------------- 2. a skill ----------------------------- */

function instalarSkill() {
  const modelo = path.join(DIR, 'skill', 'SKILL.modelo.md');
  if (!fs.existsSync(modelo)) { pulado.push('skill (modelo não encontrado)'); return; }

  /*
   * O comando que o agente vai copiar e rodar pelo Bash, inteiro e literal.
   *
   * Barra NORMAL nos dois caminhos, sempre. O agente executa isto pelo Bash, e
   * ali a barra invertida é escape: `C:\proj\x` viraria `C:projx`.
   * A primeira versão deste script usou `JSON.stringify` para "escapar" o
   * caminho e gerou `C:\\proj\\...` dentro de um arquivo Markdown —
   * um comando que falha para quem copiar. Barra normal funciona no Windows
   * para o node.exe e não precisa de escape em shell nenhum.
   */
  const cota = barras(NODE) + ' ' + barras(path.join(DIR, 'cota.js'));
  const texto = fs.readFileSync(modelo, 'utf8').split('{{COTA}}').join(cota);

  const destinoDir = path.join(CLAUDE, 'skills', 'cota');
  const destino = path.join(destinoDir, 'SKILL.md');
  if (fs.existsSync(destino) && fs.readFileSync(destino, 'utf8') === texto) {
    pulado.push('skill (já está igual)'); return;
  }
  fs.mkdirSync(destinoDir, { recursive: true });
  fs.writeFileSync(destino, texto);
  feito.push('skill → ' + destino);
}

/* --------------------------- 3. settings.json --------------------------- */

// Um hook do cota é reconhecível pelo caminho: assim dá para religar sem
// duplicar, e para detectar instalação anterior de outro diretório.
const ehDoCota = h => String((h && h.command) || '').includes(barras(DIR));

function instalarSettings() {
  let s = {};
  if (fs.existsSync(SETTINGS)) {
    try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
    catch (e) {
      console.error('\n  settings.json existe mas não é JSON válido. Nada foi tocado.');
      console.error('  Conserte o arquivo e rode de novo: ' + SETTINGS + '\n');
      process.exit(1);
    }
    // Backup só quando há o que preservar.
    const bak = SETTINGS + '.bak-cota';
    fs.copyFileSync(SETTINGS, bak);
    feito.push('backup → ' + bak);
  } else {
    fs.mkdirSync(CLAUDE, { recursive: true });
  }

  const cmdSensor = comando('sensor.js');
  if (s.statusLine && s.statusLine.command === cmdSensor) {
    pulado.push('statusLine (já configurada)');
  } else {
    if (s.statusLine && !ehDoCota(s.statusLine)) {
      feito.push('ATENÇÃO: substituí uma status line que não era do cota ' +
                 '(a antiga está no backup)');
    }
    s.statusLine = { type: 'command', command: cmdSensor, refreshInterval: 20 };
    feito.push('statusLine');
  }

  const hooks = {
    UserPromptSubmit: { script: 'hooks/aviso.js' },
    PreToolUse:       { script: 'hooks/admissao.js', matcher: 'Agent|Task|Workflow' },
    SubagentStart:    { script: 'hooks/medidor.js' },
    SubagentStop:     { script: 'hooks/medidor.js' },
  };

  s.hooks = s.hooks || {};
  for (const [evento, def] of Object.entries(hooks)) {
    s.hooks[evento] = s.hooks[evento] || [];
    const jaTem = s.hooks[evento].some(g => (g.hooks || []).some(ehDoCota));
    if (jaTem) { pulado.push('hook ' + evento); continue; }
    const grupo = { hooks: [{ type: 'command', command: comando(def.script) }] };
    if (def.matcher) grupo.matcher = def.matcher;
    s.hooks[evento].push(grupo);
    feito.push('hook ' + evento);
  }

  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

/* --------------------------- 4. conferir --------------------------- */

/*
 * Instalar e conferir são coisas diferentes, e este projeto já apanhou dessa
 * confusão mais de uma vez: no Windows um comando errado não dá erro, ele
 * simplesmente não roda. Escrever o arquivo não prova nada — então aqui o
 * comando gerado é EXECUTADO, e o instalador só declara sucesso se ele
 * responder de verdade.
 *
 * Foi assim que se pegou a versão que gravava `C:\\proj\\...` na skill:
 * o arquivo ficava lindo e o comando não existia.
 */
function conferir() {
  const { execFileSync } = require('child_process');
  const problemas = [];

  // (a) o cota.js roda por este node?
  try {
    const out = execFileSync(NODE, [path.join(DIR, 'cota.js'), '--json'],
      { encoding: 'utf8', timeout: 20000 });
    JSON.parse(out);
  } catch (e) {
    problemas.push('cota.js não respondeu JSON válido: ' + (e && e.message));
  }

  // (b) o comando literal da skill é executável do jeito que está escrito?
  const destino = path.join(CLAUDE, 'skills', 'cota', 'SKILL.md');
  if (fs.existsSync(destino)) {
    const txt = fs.readFileSync(destino, 'utf8');
    if (/\\\\/.test(txt)) {
      problemas.push('a skill contém barras duplicadas — o comando falharia no Bash');
    }
    const linha = (txt.match(/^\S+node(\.exe)?\s+\S+cota\.js\s*$/mi) || [])[0];
    if (!linha) {
      problemas.push('não achei o comando literal dentro da skill');
    } else {
      const [exe, ...resto] = linha.trim().split(/\s+/);
      try { execFileSync(exe, resto.concat(['--json']), { encoding: 'utf8', timeout: 20000 }); }
      catch (e) { problemas.push('o comando da skill não executa: ' + linha); }
    }
  }

  // (c) no Windows, o wrapper que os hooks usam realmente devolve algo?
  if (WINDOWS) {
    try {
      const out = execFileSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
         path.join(DIR, 'run.ps1'), 'cota.js'],
        { input: '', encoding: 'utf8', timeout: 30000 });
      if (!out || !out.trim()) problemas.push('run.ps1 executou mas não devolveu nada');
    } catch (e) {
      problemas.push('run.ps1 falhou: ' + (e && e.message));
    }
  }

  return problemas;
}

/* -------------------------------- main -------------------------------- */

console.log('');
console.log('  cota — instalação');
console.log('  node:    ' + NODE);
console.log('  projeto: ' + DIR);
console.log('  destino: ' + CLAUDE);
console.log('');

marcarExecutaveis();
gravarNodeLocal();
instalarSkill();
instalarSettings();

for (const f of feito)  console.log('  [ok]    ' + f);
for (const p of pulado) console.log('  [pulei] ' + p);

console.log('');
console.log('  conferindo...');
const problemas = conferir();
if (problemas.length) {
  console.log('');
  for (const p of problemas) console.log('  [FALHA] ' + p);
  console.log('');
  console.log('  A instalação escreveu os arquivos, mas a conferência falhou.');
  console.log('  NÃO conte com a ferramenta até resolver o acima.');
  console.log('');
  process.exit(1);
}
console.log('  [ok]    o comando da skill executa de verdade');
if (WINDOWS) console.log('  [ok]    o run.ps1 dos hooks responde');

console.log('');
console.log('  Falta um passo, e ele é obrigatório:');
console.log('');
console.log('    ABRA UMA SESSÃO NOVA do Claude Code.');
console.log('');
console.log('  Hooks e skills são lidos na inicialização — a sessão atual, se');
console.log('  houver, continua sem eles.');
console.log('');
console.log('  E um aviso que decide se a ferramenta funciona ou não:');
console.log('');
console.log('    A EXTENSÃO DO VS CODE NÃO EXECUTA STATUS LINE.');
console.log('');
console.log('  Só sessão de terminal chama o sensor. Se você trabalha na');
console.log('  extensão ou na web, deixe uma janela de terminal aberta com');
console.log('  um loop barato, senão a leitura congela:');
console.log('');
console.log('    /loop 3m diga apenas: estou vivo');
console.log('');
console.log('  Use Haiku e esforço baixo nessa janela. Detalhes e o preço');
console.log('  disso (medições marcadas como contaminadas) no README,');
console.log('  seção "Quem alimenta o mural".');
console.log('');
console.log('  Para conferir depois, na sessão nova:');
console.log('    ' + (WINDOWS ? 'cota.cmd' : './cota') + ' audit');
console.log('');
