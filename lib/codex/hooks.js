'use strict';
/*
 * codex/hooks.js — os hooks do Codex estão ligados e rodando?
 *
 * São duas perguntas diferentes, e o `audit` mostra as duas: estar no
 * hooks.json (instalado) não prova que o Codex executa (o usuário precisa
 * aprovar em /hooks). A prova é ter visto um SubagentStart seguido do
 * SubagentStop do mesmo agente.
 */
const path = require('path');
const os = require('os');
const core = require('../core');
function diagnosticoHooks() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
  const config = core.lerJson(file, {});
  const registrados = Object.entries(config.hooks || {}).filter(([, grupos]) => Array.isArray(grupos) &&
    grupos.some(g => Array.isArray(g?.hooks) && g.hooks.some(h => typeof h?.statusMessage === 'string' && h.statusMessage.startsWith('cota-codex:'))))
    .map(([evento]) => evento);
  const events = core.lerJsonl(core.F.hooksEventos);
  const latest = {};
  for (const e of events) if (typeof e.evento === 'string' && Number.isFinite(e.t))
    latest[e.evento] = Math.max(latest[e.evento] || 0, e.t);
  const pending = new Map();
  let cycles = 0;
  for (const e of events) {
    if (!e.agente || !e.sessao || !Number.isFinite(e.t)) continue;
    const key = JSON.stringify([e.sessao, e.agente]);
    if (e.evento === 'SubagentStart') pending.set(key, e.t);
    if (e.evento === 'SubagentStop' && pending.has(key) && e.t >= pending.get(key)) {
      cycles++; pending.delete(key);
    }
  }
  const esperados = ['UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
  return {
    arquivo: file, instalado: esperados.every(e => registrados.includes(e)), eventos_configurados: registrados,
    coleta: cycles ? 'ciclo_observado' : events.length ? 'eventos_parciais' : 'nao_observada',
    revisao_confianca: 'nao_verificada', ciclos_observados: cycles, ultimos_eventos: latest,
    ultimo_erro: core.lerJson(core.F.hookErro, null),
    amostras_gravadas: core.lerJsonl(core.F.trechos).length,
    aviso: 'Configuração não comprova execução. Os registros mostram invocações do wrapper; não certificam a origem automática. ' +
      'Sem eventos, abra o Codex no terminal (comando codex), digite /hooks e aprove os hooks do cota; ' +
      'orquestração na nuvem não executa esses hooks locais.',
  };
}
module.exports = { diagnosticoHooks };
