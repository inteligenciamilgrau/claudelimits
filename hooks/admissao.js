#!/usr/bin/env node
'use strict';
/*
 * admissao.js — hook PreToolUse nas tools de agente/workflow (D19).
 *
 * Não bloqueia: devolve permissionDecision "ask" com o número na tela, para
 * você confirmar antes de lançar os 10 agentes. Quem decide continua sendo
 * você — D1 segue valendo, isto não é freio cego.
 *
 * Falha SEMPRE aberto: sem dado, dado velho demais ou qualquer erro, sai
 * calado e o fluxo normal de permissão segue.
 */

const fs = require('fs');
const core = require('../lib/core');

function perguntar(motivo) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: motivo,
    },
  }));
  process.exit(0);
}

try {
  let ev = null;
  try { ev = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) {}

  const cfg = core.lerConfig();
  if (!cfg.ligado || !cfg.admissao.ligado) process.exit(0);   // D2

  // D40 — operação pesada vale o segundo e pouco de uma leitura fresca.
  require('../lib/sonda').garantirFrescoHook(cfg.sonda.idade_s);

  const est = core.lerEstado();
  if (!est) process.exit(0);

  const nowS = core.agora();
  const j = core.lerJanelas(est, cfg, nowS, core.lerHistorico());

  const acima = [];
  const ver = (jan, rotulo, semanal) => {
    if (jan.pctParaDecidir === null) return;
    if (jan.pctParaDecidir < cfg.admissao.perguntar_acima_de) return;
    const quando = jan.resetsAt === null ? '' :
      (semanal && jan.segAteReset > 86400
        ? ' · reseta ' + core.fmtDiaHora(jan.resetsAt)
        : ' · reseta em ' + core.fmtDuracao(jan.segAteReset));
    acima.push(`${rotulo} em ${jan.pctParaDecidir.toFixed(1)}%` +
               (jan.estado === 'piso' ? ' (pelo menos)' : '') + quando);
  };
  ver(j.cinco, '5h', false);
  ver(j.sete, 'semanal', true);

  if (!acima.length) process.exit(0);

  const nome = (ev && ev.tool_name) || 'operação';
  perguntar(`[cota] ${nome} é operação pesada e a cota está alta: ` +
            acima.join('  |  ') + '. Confirma?');
} catch (_) {
  process.exit(0);
}
process.exit(0);
