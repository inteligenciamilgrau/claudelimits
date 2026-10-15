#!/usr/bin/env node
'use strict';
/*
 * codex.js — a porta de entrada de todos os hooks no Codex.
 *
 *   node hooks/codex.js aviso | admissao | medidor | conferir
 *
 * Os hooks são os mesmos do Claude (aviso, admissao, medidor); este arquivo
 * só liga o modo Codex antes de carregá-los. A lista é fechada de propósito:
 * nada que venha do evento escolhe qual módulo carregar.
 *
 * Também anota cada evento em hooks-eventos.jsonl, para o `audit` saber se o
 * Codex está mesmo executando os hooks (lib/codex/hooks.js). Só metadados de
 * ciclo de vida: nunca prompt, argumento de ferramenta ou transcrição.
 *
 * `conferir` é para o instalador: prova que o comando instalado chega até
 * aqui, sem ler stdin e sem anotar evento — senão o audit veria um evento que
 * o Codex nunca mandou.
 */
process.env.COTA_PROVIDER = 'codex';
if (process.argv[2] === 'conferir') { process.stdout.write('cota-codex ok\n'); process.exit(0); }
if (process.env.COTA_SONDA_ATIVA) process.exit(0);
const fs = require('fs');
const core = require('../lib/core');
let event;
try { event = JSON.parse(fs.readFileSync(0, 'utf8')); }
catch (_) { event = null; }
// Os hooks de baixo leem daqui em vez de ler o stdin de novo (já foi consumido).
core.eventoHook = event;
if (event && core.lerConfig().ligado) {
  try {
    core.appendJsonl(core.F.hooksEventos, {
      t: core.agora(), evento: event.hook_event_name || null,
      sessao: event.session_id || null, agente: event.agent_id || null,
      perfil: require('../lib/codex/perfil').perfilDoEvento(event),
      origem: 'hook',
    });
  } catch (e) {
    // Sem como gravar o diagnóstico na pasta (sandbox, permissão): avisa no stderr.
    process.stderr.write('[cota-codex] Não foi possível registrar o hook: ' + (e.code || e.message) + '\n');
  }
}
switch (process.argv[2]) {
  case 'aviso': require('./aviso'); break;
  case 'admissao': require('./admissao'); break;
  case 'medidor': require('./medidor'); break;
  default: process.stderr.write('Hook cota desconhecido\n'); process.exit(1);
}
