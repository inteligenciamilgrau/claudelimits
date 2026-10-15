#!/usr/bin/env node
'use strict';
/*
 * instalar.js — liga o cota ao Claude Code e/ou ao Codex desta máquina.
 *
 * Rode com o node que você quer usar:
 *   node instalar.js            instala para o que encontrar (Claude, Codex ou os dois)
 *   node instalar.js --claude   só o Claude Code      (--codex: só o Codex)
 *   node instalar.js --remover  desfaz: tira os hooks e as skills
 *
 * Sem terminal: INSTALAR.cmd (Windows, dois cliques) ou `sh instalar.sh`
 * (Linux e macOS) acham o node — ou ajudam a instalar — e chamam este arquivo.
 *
 * O repositório não contém caminho absoluto nenhum, de propósito. Este script
 * descobre os caminhos daqui e escreve as coisas que precisam deles:
 *
 *   1. node-local.txt          — onde está o node (fica fora do git)
 *   2. ~/.claude/skills/cota/  — a skill, com o comando literal montado
 *   3. ~/.claude/settings.json — os cinco hooks
 *   4. ~/.codex/...            — o equivalente no Codex (lib/codex/instalar.js)
 *
 * A skill precisa do caminho literal (D27): um agente que nunca viu a
 * ferramenta não deveria ter que substituir placeholder. Por isso o repo
 * guarda um modelo e a instalação gera o literal.
 *
 * É idempotente: rodar de novo não duplica nada, e corrige o que mudou.
 */

// Antes de qualquer require do projeto: com node velho, o erro de sintaxe
// de um módulo seria a primeira coisa que um leigo veria.
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('\n  O cota precisa do Node.js 18 ou mais novo, e este é o ' + process.version + '.');
  console.error('  Instale a versão LTS em https://nodejs.org e rode de novo.\n');
  process.exit(1);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { comandoHook, barras } = require('./lib/comando');

const DIR = __dirname;
const NODE = process.execPath;
const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const SKILL_DIR = path.join(CLAUDE, 'skills', 'cota');
const ESTADO = require('./lib/core').DIR;
const WINDOWS = process.platform === 'win32';

const HOOKS = {
  UserPromptSubmit: { script: 'hooks/aviso.js' },
  PreToolUse:       { script: 'hooks/admissao.js', matcher: 'Agent|Task|Workflow' },
  SubagentStart:    { script: 'hooks/medidor.js' },
  SubagentStop:     { script: 'hooks/medidor.js' },
  // D25 — subagente de sessão que fechou não vai dar Stop: sai daqui.
  SessionEnd:       { script: 'hooks/medidor.js' },
};

const feito = [];
const pulado = [];

// O comando que o Claude Code vai executar — o porquê do formato está em lib/comando.js.
const comando = script => comandoHook({ windows: WINDOWS, dir: DIR, node: NODE, pathMod: path }, script);

/*
 * Um hook é do cota pelo SCRIPT que ele chama, não pela pasta do projeto: a
 * pasta pode ter mudado de lugar, ou de caixa (c:\users vs C:\Users), desde a
 * última instalação. Reconhecendo pela pasta, os hooks velhos — apontando para
 * uma pasta que não existe mais — ficavam falhando em todo evento, ao lado de
 * um conjunto novo. `sensor.js` é a status line da versão antiga (D44).
 */
const SCRIPT_DO_COTA = /(?:run\.ps1"?\s+|[\\/])(?:hooks[\\/](?:aviso|admissao|medidor)|sensor)\.js"?\s*$/i;
const ehDoCota = h => SCRIPT_DO_COTA.test(String((h && h.command) || ''));

function lerSettings() {
  if (!fs.existsSync(SETTINGS)) return null;
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) {
    throw new Error('settings.json existe mas não é JSON válido. Nada foi tocado. ' +
                    'Conserte o arquivo e rode de novo: ' + SETTINGS);
  }
}

const gravarSettings = s => fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');

/* ------------------------------ instalar ------------------------------ */

/*
 * O git carrega o bit de execução, mas quem baixa o projeto como .zip perde
 * ele — e aí `./cota` responde "Permission denied", que parece defeito do
 * programa e é só permissão. Barato de garantir, então garante.
 */
function marcarExecutaveis() {
  if (WINDOWS) return;
  for (const nome of ['cota', 'cota.js', 'instalar.js', 'instalar.sh',
                      'hooks/aviso.js', 'hooks/admissao.js', 'hooks/medidor.js', 'hooks/codex.js']) {
    const p = path.join(DIR, nome);
    if (!fs.existsSync(p)) continue;
    try {
      const modo = fs.statSync(p).mode;
      if (modo & 0o111) continue;
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

function instalarSkill() {
  const modelo = path.join(DIR, 'skill', 'SKILL.modelo.md');
  if (!fs.existsSync(modelo)) { pulado.push('skill (modelo não encontrado)'); return; }

  /*
   * O comando que o agente vai copiar e rodar pelo Bash, inteiro e literal.
   *
   * Barra NORMAL nos dois caminhos: no Bash a barra invertida é escape, e
   * `C:\proj\x` viraria `C:projx`. E entre aspas quando houver espaço — sem
   * elas o Bash parte "C:/Users/Ana Maria/..." em dois argumentos.
   */
  const q = p => (/\s/.test(p) ? '"' + p + '"' : p);
  const cota = q(barras(NODE)) + ' ' + q(barras(path.join(DIR, 'cota.js')));
  const texto = fs.readFileSync(modelo, 'utf8').split('{{COTA}}').join(cota);

  const destino = path.join(SKILL_DIR, 'SKILL.md');
  if (fs.existsSync(destino) && fs.readFileSync(destino, 'utf8') === texto) {
    pulado.push('skill (já está igual)'); return;
  }
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.writeFileSync(destino, texto);
  feito.push('skill → ' + destino);
}

/*
 * Guarda o PRIMEIRO backup e nunca o sobrescreve: da segunda vez em diante o
 * settings.json já tem o cota, e um backup dele não devolve o original.
 */
function backup() {
  const bak = SETTINGS + '.bak-cota';
  if (fs.existsSync(bak)) { pulado.push('backup (o original continua em ' + path.basename(bak) + ')'); return; }
  fs.copyFileSync(SETTINGS, bak);
  feito.push('backup → ' + bak);
}

function instalarSettings() {
  let s = lerSettings();
  if (s) backup();
  else { fs.mkdirSync(CLAUDE, { recursive: true }); s = {}; }

  // D44 — a status line saiu do projeto. Remove a nossa, se houver; a de
  // outra ferramenta fica como está.
  if (s.statusLine && ehDoCota(s.statusLine)) {
    delete s.statusLine;
    feito.push('status line antiga do cota removida (a sonda substituiu)');
  }

  s.hooks = s.hooks || {};
  for (const [evento, def] of Object.entries(HOOKS)) {
    const cmd = comando(def.script);
    // O primeiro do cota fica, com o comando corrigido no lugar (pasta nova,
    // aspas que faltavam); os demais são duplicados e saem.
    let achou = false, mudou = false, duplicados = 0;
    for (const g of s.hooks[evento] || []) {
      g.hooks = (g.hooks || []).filter(h => {
        if (!ehDoCota(h)) return true;
        if (achou) { duplicados++; return false; }
        achou = true;
        if (h.command !== cmd) { h.command = cmd; mudou = true; }
        return true;
      });
    }
    s.hooks[evento] = (s.hooks[evento] || []).filter(g => g.hooks.length > 0);
    if (!achou) {
      const grupo = { hooks: [{ type: 'command', command: cmd }] };
      if (def.matcher) grupo.matcher = def.matcher;
      s.hooks[evento].push(grupo);
      feito.push('hook ' + evento);
    } else if (mudou || duplicados) {
      feito.push('hook ' + evento + ' (atualizado' +
                 (duplicados ? `, ${duplicados} duplicado(s) removido(s)` : '') + ')');
    } else {
      pulado.push('hook ' + evento);
    }
  }
  gravarSettings(s);
}

function limparEstadoLegado() {
  for (const n of require('./lib/core').removerLegado()) {
    feito.push('removido resto de versão anterior: ' + n);
  }
}

/*
 * Instalar e conferir são coisas diferentes: no Windows um comando errado não
 * dá erro, ele simplesmente não roda. Escrever o arquivo não prova nada —
 * então aqui o que foi gerado é EXECUTADO (D36).
 */
/*
 * Roda e devolve o JSON da saída — mesmo com código de saída diferente de 0:
 * `cota --json` sai com 1 quando ainda não há leitura, e isso é a sonda
 * falhando, não o node nem a skill. Culpar os dois escondia a causa real.
 */
function rodarJson(exe, args) {
  let out;
  try { out = execFileSync(exe, args, { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = e && e.stdout; if (!out) throw e; }
  return JSON.parse(out);
}

function conferir() {
  const problemas = [];
  let sondagem = null;

  // (a) o cota.js roda por este node?
  try { rodarJson(NODE, [path.join(DIR, 'cota.js'), '--json']); }
  catch (e) { problemas.push('cota.js não respondeu JSON válido: ' + (e && e.message)); }

  // (b) o comando literal da skill executa do jeito que está escrito?
  const destino = path.join(SKILL_DIR, 'SKILL.md');
  if (fs.existsSync(destino)) {
    const txt = fs.readFileSync(destino, 'utf8');
    if (/\\\\/.test(txt)) problemas.push('a skill contém barras duplicadas — o comando falharia no Bash');
    // Cada caminho pode vir entre aspas (quando tem espaço) ou não.
    const m = txt.match(/^("[^"\n]*node(?:\.exe)?"|\S+node(?:\.exe)?)\s+("[^"\n]*cota\.js"|\S+cota\.js)\s*$/mi);
    if (!m) {
      problemas.push('não achei o comando literal dentro da skill');
    } else {
      const tira = s => s.replace(/^"|"$/g, '');
      try { rodarJson(tira(m[1]), [tira(m[2]), '--json']); }
      catch (e) { problemas.push('o comando da skill não executa: ' + m[0]); }
    }
  }

  // (c) a leitura da cota responde? É ela que alimenta tudo (D39).
  try {
    const r = rodarJson(NODE, [path.join(DIR, 'cota.js'), 'sondar', '--json']);
    if (!r.ok) problemas.push('a leitura da cota falhou: ' + r.erro);
    else sondagem = r;
  } catch (e) {
    problemas.push('a leitura da cota não respondeu: ' + (e && e.message));
  }

  // (d) no Windows, o wrapper que os hooks usam realmente devolve algo?
  if (WINDOWS) {
    try {
      const out = execFileSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'run.ps1'), 'cota.js'],
        { input: '', encoding: 'utf8', timeout: 60000 });
      if (!out || !out.trim()) problemas.push('run.ps1 executou mas não devolveu nada');
    } catch (e) {
      problemas.push('run.ps1 falhou: ' + (e && e.message));
    }
  }
  return { problemas, sondagem };
}

// Claude Code. Devolve se a conferência passou; quem fala do próximo passo é o main.
function instalarClaude() {
  feito.length = 0; pulado.length = 0;
  instalarSkill();
  instalarSettings();
  limparEstadoLegado();

  for (const f of feito)  console.log('  [ok]    ' + f);
  for (const p of pulado) console.log('  [pulei] ' + p);

  console.log('  conferindo...');
  const { problemas, sondagem } = conferir();
  if (problemas.length) {
    for (const p of problemas) console.log('  [FALHA] ' + p);
    return false;
  }
  console.log('  [ok]    o comando da skill executa de verdade');
  console.log('  [ok]    a leitura da cota responde (' + sondagem.ms + 'ms, 5h=' +
              sondagem.pct5 + '% 7d=' + sondagem.pct7 + '%)');
  console.log('          ' + sondagem.exe);
  if (WINDOWS) console.log('  [ok]    o run.ps1 dos hooks responde');
  return true;
}

function instalarCodex() {
  const codex = require('./lib/codex/instalar');
  codex.instalar({ dir: DIR, node: NODE, log: l => console.log('  ' + l) });
  console.log('  conferindo...');
  const { problemas, sondagem } = codex.conferir({ dir: DIR, node: NODE });
  if (problemas.length) {
    for (const p of problemas) console.log('  [FALHA] ' + p);
    return false;
  }
  console.log('  [ok]    o comando dos hooks executa de verdade');
  console.log('  [ok]    a leitura do saldo responde (' + sondagem.ms + 'ms, 5h=' +
              sondagem.pct5 + '% 7d=' + sondagem.pct7 + '%)');
  console.log('          ' + sondagem.exe);
  return true;
}

/* ------------------------------- remover ------------------------------- */

/*
 * Desfaz a instalação tirando SÓ o que é do cota: um hook é nosso quando o
 * comando aponta para esta pasta. Hooks e status line de outras ferramentas
 * ficam intactos. O estado (~/.claude/cota) fica — é seu histórico, e apagar
 * é uma decisão sua.
 */
function removerClaude() {
  feito.length = 0; pulado.length = 0;
  const s = lerSettings();
  if (s) {
    fs.copyFileSync(SETTINGS, SETTINGS + '.bak-cota-remover');
    feito.push('cópia antes de remover → ' + SETTINGS + '.bak-cota-remover');
    if (s.statusLine && ehDoCota(s.statusLine)) { delete s.statusLine; feito.push('status line'); }
    for (const evento of Object.keys(s.hooks || {})) {
      const antes = JSON.stringify(s.hooks[evento]);
      s.hooks[evento] = (s.hooks[evento] || [])
        .map(g => Object.assign({}, g, { hooks: (g.hooks || []).filter(h => !ehDoCota(h)) }))
        .filter(g => g.hooks.length > 0);
      if (JSON.stringify(s.hooks[evento]) !== antes) feito.push('hook ' + evento);
      if (s.hooks[evento].length === 0) delete s.hooks[evento];
    }
    if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
    gravarSettings(s);
  } else {
    pulado.push('settings.json (não existe)');
  }

  const skill = path.join(SKILL_DIR, 'SKILL.md');
  if (fs.existsSync(skill) && /^name:\s*cota\s*$/m.test(fs.readFileSync(skill, 'utf8'))) {
    fs.rmSync(SKILL_DIR, { recursive: true, force: true });
    feito.push('skill → ' + SKILL_DIR);
  } else {
    pulado.push('skill (não instalada)');
  }

  for (const f of feito)  console.log('  [removido] ' + f);
  for (const p of pulado) console.log('  [pulei]    ' + p);
  console.log('  O histórico continua em ' + ESTADO + ' — apague a pasta se quiser.');
  return true;
}

function removerCodex() {
  const codex = require('./lib/codex/instalar');
  codex.remover({ log: l => console.log('  ' + l) });
  console.log('  O histórico continua em ' + path.join(codex.caminhos().raiz, 'cota') +
              ' — apague a pasta se quiser.');
  return true;
}

/* -------------------------------- main -------------------------------- */

const argv = process.argv.slice(2);
const removendo = argv.includes('--remover');
const pedido = { claude: argv.includes('--claude'), codex: argv.includes('--codex') };
const explicito = pedido.claude || pedido.codex;
const ALVOS = {
  claude: { nome: 'Claude Code', instalar: instalarClaude, remover: removerClaude,
            achar: () => require('./lib/sonda').acharClaude() },
  codex:  { nome: 'Codex', instalar: instalarCodex, remover: removerCodex,
            achar: () => require('./lib/codex/sonda').candidatos()[0] || null },
};

const secao = t => console.log('\n  ── ' + t + ' ' + '─'.repeat(Math.max(3, 44 - t.length)));

console.log('');
console.log('  cota — ' + (removendo ? 'remoção' : 'instalação'));

/*
 * Aberto de dentro do .zip, o Windows extrai para uma pasta temporária e os
 * hooks ficariam apontando para algo que some sozinho. Melhor parar aqui.
 */
if (/[\\/]Temp\d*_[^\\/]*\.zip[\\/]/i.test(DIR)) {
  console.log('');
  console.log('  Parece que o instalador foi aberto de dentro do arquivo .zip.');
  console.log('  Extraia o .zip primeiro (botão direito → "Extrair tudo") numa pasta');
  console.log('  que vai ficar — por exemplo Documentos\\cota — e rode de lá.');
  console.log('');
  process.exit(1);
}

// Sem flag, instala para o que existir na máquina; removendo, tira de todos.
const alvos = Object.keys(ALVOS).filter(k => explicito ? pedido[k] : (removendo || !!ALVOS[k].achar()));
if (!alvos.length) {
  console.log('');
  console.log('  Não encontrei o Claude Code nem o Codex nesta máquina.');
  console.log('  Instale um deles (a extensão do VS Code serve), faça login uma vez,');
  console.log('  e rode o instalador de novo.');
  console.log('');
  process.exit(1);
}

console.log('  para:    ' + alvos.map(k => ALVOS[k].nome).join(' e '));
console.log('  node:    ' + NODE + ' (' + process.version + ')');
console.log('  pasta:   ' + DIR);
if (!removendo) {
  feito.length = 0; pulado.length = 0;
  marcarExecutaveis();
  gravarNodeLocal();
  for (const f of feito) console.log('  [ok]    ' + f);
}

const resultado = {};
for (const k of alvos) {
  secao(ALVOS[k].nome);
  try { resultado[k] = removendo ? ALVOS[k].remover() : ALVOS[k].instalar(); }
  catch (e) { console.log('  [FALHA] ' + ((e && e.message) || e)); resultado[k] = false; }
}

const falhou = alvos.filter(k => !resultado[k]);
secao(falhou.length ? 'Atenção' : 'Pronto');
if (removendo) {
  console.log('  Abra uma conversa nova para os hooks pararem de rodar.');
} else {
  for (const k of falhou) {
    console.log('  ' + ALVOS[k].nome + ': os arquivos foram gravados, mas a conferência falhou.');
    console.log('  NÃO conte com a ferramenta nele até resolver o [FALHA] acima.');
    console.log('');
  }
  if (falhou.length < alvos.length) {
    console.log('  Falta só:');
    if (resultado.claude) {
      console.log('');
      console.log('  • Claude Code: abra uma conversa nova (ou recarregue o VS Code).');
      console.log('    Hooks e skills só são lidos quando a conversa começa.');
    }
    if (resultado.codex) {
      // Quem usa só a extensão não tem `codex` no PATH: dá o caminho inteiro.
      const exe = ALVOS.codex.achar();
      const noPath = !exe || (process.env.PATH || process.env.Path || '').split(path.delimiter)
        .some(d => path.isAbsolute(d) && path.dirname(exe) === path.resolve(d));
      // Pronto para colar: no PowerShell um caminho entre aspas precisa do `&`.
      const rodar = noPath ? 'codex' : (WINDOWS ? '& ' : '') + '"' + exe + '"';
      console.log('');
      console.log('  • Codex: aprovar os hooks. O Codex não roda hook que você não aprovou,');
      console.log('    e a aprovação é feita no Codex do terminal:');
      console.log('      1. abra um terminal e rode:  ' + rodar);
      console.log('      2. digite /hooks e aprove os 5 hooks "cota-codex"');
      console.log('    Depois abra uma conversa nova. Sem aprovar, a consulta da cota');
      console.log('    funciona, mas a medição dos subagentes não.');
    }
    console.log('');
    console.log('  Não apague nem mova esta pasta — a ferramenta roda daqui:');
    console.log('    ' + DIR);
    console.log('  (se mover, é só rodar o instalador de novo)');
    console.log('');
    console.log('  Para testar, pergunte ao agente: "quanto da minha cota eu já usei?"');
    console.log('  Para desfazer: node instalar.js --remover');
  }
}
console.log('');
process.exit(falhou.length ? 1 : 0);
