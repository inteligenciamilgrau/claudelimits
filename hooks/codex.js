#!/usr/bin/env node
'use strict';
// Entry point with an allowlist: no dynamic module path from hook input.
process.env.COTA_PROVIDER = 'codex';
if (process.env.COTA_SONDA_ATIVA) process.exit(0);
// Record only lifecycle metadata, never prompt/tool arguments or transcripts.
// Downstream hooks read the already-parsed object instead of consuming stdin twice.
const fs = require('fs');
const core = require('../lib/core');
let event;
try { event = JSON.parse(fs.readFileSync(0, 'utf8')); }
catch (_) { event = null; }
core.eventoHook = event;
if (event && core.lerConfig().ligado) {
  try {
    core.appendJsonl(core.F.hooksEventos, {
      t: core.agora(), evento: event.hook_event_name || null,
      sessao: event.session_id || null, agente: event.agent_id || null,
      perfil: require('../lib/perfil-codex').perfilDoEvento(event),
      origem: 'hook',
    });
  } catch (e) {
    // Cannot write diagnostics in the blocked directory: stderr still reports it.
    process.stderr.write('[cota-codex] Não foi possível registrar o hook: ' + (e.code || e.message) + '\n');
  }
}
switch (process.argv[2]) {
  case 'aviso': require('./aviso'); break;
  case 'admissao': require('./admissao'); break;
  case 'medidor': require('./medidor'); break;
  default: process.stderr.write('Hook cota desconhecido\n'); process.exit(1);
}
