#!/usr/bin/env node
'use strict';
/*
 * teste/index.js — roda todas as suítes, uma depois da outra.
 *
 *   node teste
 *
 * Nenhuma encosta no seu estado real, usa rede ou gasta cota: o Claude e o
 * Codex são falsos, e tudo é gravado em pastas temporárias.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = ['claude.js', 'codex.js', 'codex-erros.js', 'codex-estimativa.js'];
const falharam = [];
for (const s of SUITES) {
  console.log('\n=== ' + s);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) falharam.push(s);
}
console.log('');
console.log(falharam.length ? '  FALHOU: ' + falharam.join(', ') : '  todas as suítes passaram');
console.log('');
process.exit(falharam.length ? 1 : 0);
