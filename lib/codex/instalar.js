'use strict';
/*
 * codex/instalar.js — liga o cota ao Codex desta máquina.
 *
 * Chamado pelo instalar.js da raiz (`node instalar.js`, ou `--codex` para só
 * este). Grava, sempre preservando o que for de outras ferramentas:
 *
 *   ~/.codex/hooks.json                 os cinco hooks, marcados pelo
 *                                       statusMessage "cota-codex:<evento>"
 *   ~/.codex/skills/cota-codex/SKILL.md a skill, com o comando literal daqui
 *
 * (CODEX_HOME, se definido, no lugar de ~/.codex). Depois confere: executa o
 * wrapper dos hooks e faz uma leitura de verdade do saldo.
 *
 * O que ele NÃO faz, de propósito: aprovar os hooks. O Codex só executa hook
 * que o usuário revisou e aprovou em /hooks, e qualquer mudança no comando
 * pede aprovação de novo. Contornar isso seria contornar a segurança do Codex.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { comandoHook } = require('../comando');

const WINDOWS = process.platform === 'win32';
const MARCA = 'cota-codex:';
const MARCA_SKILL = '<!-- instalado por cota-codex -->';

// evento: [modo do hooks/codex.js, matcher, timeout em segundos]
const DEFINICOES = {
  UserPromptSubmit: ['aviso', undefined, 30],
  PreToolUse:       ['admissao', '^(Agent|spawn_agent)$', 30],
  SubagentStart:    ['medidor', undefined, 30],
  SubagentStop:     ['medidor', undefined, 60],
  // Só limpeza local: o Codex espera pouco no fim da sessão.
  SessionEnd:       ['medidor', undefined, 3],
};

const ehNosso = h => !!h && typeof h.statusMessage === 'string' && h.statusMessage.startsWith(MARCA);

// Aspas de shell explícitas: aspas de JSON não são aspas de shell.
const aspasPosix = s => "'" + s.replace(/'/g, "'\\''") + "'";
const aspasPs = s => "'" + s.replace(/'/g, "''") + "'";

function caminhos() {
  const raiz = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return { raiz, hooks: path.join(raiz, 'hooks.json'),
           skill: path.join(raiz, 'skills', 'cota-codex', 'SKILL.md') };
}

// Lê e valida ANTES de gravar qualquer coisa: hooks.json quebrado fica como está.
function lerHooks(arquivo) {
  if (!fs.existsSync(arquivo)) return {};
  let v;
  try { v = JSON.parse(fs.readFileSync(arquivo, 'utf8')); }
  catch (_) { throw new Error(arquivo + ' existe mas não é JSON válido. Nada foi tocado.'); }
  const objeto = o => o && typeof o === 'object' && !Array.isArray(o);
  if (!objeto(v) || (v.hooks !== undefined && !objeto(v.hooks)) ||
      Object.values(v.hooks || {}).some(gs => !Array.isArray(gs) || gs.some(g => !g || !Array.isArray(g.hooks)))) {
    throw new Error(arquivo + ' tem um formato que não reconheço. Nada foi tocado.');
  }
  return v;
}

// Tira os hooks do cota (e grupos que ficarem vazios); os de outras ferramentas ficam.
function semOsNossos(v) {
  v.hooks = v.hooks || {};
  for (const [evento, grupos] of Object.entries(v.hooks)) {
    v.hooks[evento] = grupos.map(g => Object.assign({}, g, { hooks: g.hooks.filter(h => !ehNosso(h)) }))
      .filter(g => g.hooks.length);
    if (!v.hooks[evento].length) delete v.hooks[evento];
  }
  return v;
}

/*
 * O comando que o agente do Codex copia da skill. No Windows o Codex roda os
 * comandos no PowerShell, daí o `& '...'`; fora dele, sh.
 */
function invocacao(dir, node) {
  const cota = path.join(dir, 'cota.js');
  return WINDOWS ? '& ' + aspasPs(node) + ' ' + aspasPs(cota) + ' --codex'
                 : aspasPosix(node) + ' ' + aspasPosix(cota) + ' --codex';
}

function instalar({ dir, node, log }) {
  const c = caminhos();
  const v = semOsNossos(lerHooks(c.hooks));
  if (fs.existsSync(c.skill) && !fs.readFileSync(c.skill, 'utf8').includes(MARCA_SKILL)) {
    throw new Error('já existe uma skill cota-codex que não foi este instalador que criou: ' + c.skill);
  }
  for (const [evento, [modo, matcher, timeout]] of Object.entries(DEFINICOES)) {
    const grupo = { hooks: [{
      type: 'command', timeout, statusMessage: MARCA + evento,
      command: comandoHook({ windows: WINDOWS, dir, node, pathMod: path }, 'hooks/codex.js', modo),
    }] };
    if (matcher) grupo.matcher = matcher;
    (v.hooks[evento] = v.hooks[evento] || []).push(grupo);
  }
  fs.mkdirSync(c.raiz, { recursive: true });
  // Guarda o PRIMEIRO backup e nunca o sobrescreve: depois disso o arquivo
  // já tem o cota, e um backup dele não devolve o original.
  if (fs.existsSync(c.hooks) && !fs.existsSync(c.hooks + '.bak-cota-codex')) {
    fs.copyFileSync(c.hooks, c.hooks + '.bak-cota-codex');
    log('[ok]    backup → ' + c.hooks + '.bak-cota-codex');
  }
  const texto = JSON.stringify(v, null, 2) + '\n';
  const antes = fs.existsSync(c.hooks) ? fs.readFileSync(c.hooks, 'utf8') : null;
  if (antes === texto) log('[pulei] hooks (já estão iguais)');
  else {
    fs.writeFileSync(c.hooks, texto, { mode: 0o600 });
    log('[ok]    cinco hooks → ' + c.hooks);
  }

  const modelo = fs.readFileSync(path.join(dir, 'skill', 'SKILL.codex.modelo.md'), 'utf8');
  const skill = modelo.split('{{COTA}}').join(invocacao(dir, node)) + '\n' + MARCA_SKILL + '\n';
  if (fs.existsSync(c.skill) && fs.readFileSync(c.skill, 'utf8') === skill) log('[pulei] skill (já está igual)');
  else {
    fs.mkdirSync(path.dirname(c.skill), { recursive: true });
    fs.writeFileSync(c.skill, skill);
    log('[ok]    skill → ' + c.skill);
  }
  return { mudouHooks: antes !== texto };
}

/*
 * Escrever o arquivo não prova nada — no Windows um comando errado não dá
 * erro, simplesmente não roda. Então aqui o que foi gerado é EXECUTADO.
 */
function conferir({ dir, node }) {
  const problemas = [];
  let sondagem = null;
  // (a) o wrapper dos hooks chega até o hooks/codex.js? `conferir` não anota
  // evento, senão o audit veria um disparo que o Codex nunca fez.
  try {
    const out = WINDOWS
      ? execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(dir, 'run.ps1'), 'hooks/codex.js', 'conferir'],
          { input: '', encoding: 'utf8', timeout: 60000, windowsHide: true })
      : execFileSync(node, [path.join(dir, 'hooks', 'codex.js'), 'conferir'],
          { input: '', encoding: 'utf8', timeout: 60000 });
    if (!/cota-codex ok/.test(out)) problemas.push('o comando dos hooks executou mas não respondeu');
  } catch (e) {
    problemas.push('o comando dos hooks falhou: ' + String((e && e.message) || e).split('\n')[0]);
  }
  // (b) a leitura do saldo responde? É ela que alimenta tudo.
  try {
    let out;
    try { out = execFileSync(node, [path.join(dir, 'cota.js'), '--codex', 'sondar', '--json'],
      { encoding: 'utf8', timeout: 60000, windowsHide: true }); }
    catch (e) { out = e && e.stdout; if (!out) throw e; }
    const r = JSON.parse(out);
    if (!r.ok) {
      const msg = String((r.erro && r.erro.mensagem) || r.erro || 'sem detalhe');
      problemas.push('a leitura do saldo falhou: ' + msg + (/auth|login/i.test(msg)
        ? ' — faça login no Codex com a conta ChatGPT (comando: codex login) e rode o instalador de novo' : ''));
    } else sondagem = r;
  } catch (e) {
    problemas.push('a leitura do saldo não respondeu: ' + String((e && e.message) || e).split('\n')[0]);
  }
  return { problemas, sondagem };
}

function remover({ log }) {
  const c = caminhos();
  if (fs.existsSync(c.hooks)) {
    const v = semOsNossos(lerHooks(c.hooks));
    fs.copyFileSync(c.hooks, c.hooks + '.bak-cota-codex-remover');
    fs.writeFileSync(c.hooks, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
    log('[removido] hooks do cota em ' + c.hooks);
  } else log('[pulei]    hooks.json (não existe)');
  if (fs.existsSync(c.skill) && fs.readFileSync(c.skill, 'utf8').includes(MARCA_SKILL)) {
    fs.rmSync(path.dirname(c.skill), { recursive: true, force: true });
    log('[removido] skill → ' + path.dirname(c.skill));
  } else log('[pulei]    skill (não instalada)');
}

module.exports = { instalar, conferir, remover, caminhos, DEFINICOES, MARCA };
