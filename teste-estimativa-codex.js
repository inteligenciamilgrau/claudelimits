'use strict';
const assert = require('node:assert/strict');
const { baseCodex } = require('./lib/estimativa-codex');
const an = require('./lib/analise');
const nowS = 20_000_000;
const perfil = { modelo: 'modelo-a', esforco: 'alto', velocidade: 'normal' };
const trecho = (extra = {}) => ({ t: nowS, perfil, seg: 3600, por_tipo: { worker: 3600 },
  d5: 10, d7: 2, valido5: true, valido7: true, ...extra });
const agente = (extra = {}) => ({ t: nowS, perfil, dur_s: 3600, tipo: 'worker', ...extra });
const base = (ts, as, opts = {}) => baseCodex(ts, as, { nowS, perfil, ...opts });
let checks = 0;
function check(nome, fn) { fn(); checks++; console.log('OK ' + nome); }
check('perfil exato, misto excluído e compatibilidade com medioPara', () => {
  const b = base([trecho(), trecho({ perfil: null }), trecho({ perfil: { ...perfil, esforco: 'baixo' } }),
    trecho({ misto: true })], [agente(), agente({ perfil: null })]);
  assert.equal(b.ritmo.__geral.r5, 10);
  assert.equal(an.medioPara(b, 'worker').dur_s, 3600);
  assert.equal(b.metadados.descartes.perfil, 3);
  assert.equal(b.metadados.descartes.mistos, 1);
  assert.equal(b.metadados.amostras.agentes, 1);
  assert.deepEqual(base([trecho()], [agente()], { perfil: null }).ritmo, {});
  const desconhecido = base([trecho({ perfil: null })], [agente({ perfil: null })], { perfil: null });
  assert.equal(desconhecido.ritmo.__geral.r5, 10);
});
check('meia-vida pondera delta, horas e duração conjuntamente', () => {
  const antigo = nowS - 7 * 86400;
  const b = base([trecho(), trecho({ t: antigo, seg: 7200, por_tipo: { worker: 7200 }, d5: 80 })],
    [agente(), agente({ t: antigo, dur_s: 7200 })]);
  assert.equal(b.ritmo.__geral.r5, 25); // (10 + 80/2) / (1 + 2/2)
  assert.equal(b.duracao.__geral.media_s, 4800);
  assert.equal(b.metadados.amostras.trechosPonderados, 1.5);
  assert.equal(b.metadados.idade.maisAntigaS, 7 * 86400);
});
check('datas inválidas, futuras, antigas e dados corrompidos não entram', () => {
  const b = base([trecho({ t: nowS + 1 }), trecho({ t: nowS - 31 * 86400 }), trecho({ t: null }),
    trecho({ seg: NaN }), trecho({ por_tipo: { worker: -1 } }),
    trecho({ d5: -2, d7: Infinity }), trecho({ por_tipo: { worker: 1800 } })], []);
  assert.deepEqual(b.ritmo, {});
  assert.deepEqual(b.metadados.descartes, { invalidos: 5, futuros: 1, antigos: 1, perfil: 0, mistos: 0 });
  assert.throws(() => base([], [], { meiaVidaDias: 0 }), TypeError);
});
check('reset invalida só uma janela e zero não promete gratuidade', () => {
  const b = base([trecho({ valido5: false }), trecho({ d5: 0, d7: 0 })], [agente()]);
  assert.equal(b.ritmo.__geral.r5, 0);
  assert.equal(b.ritmo.__geral.r7, 1);
  assert.equal(b.metadados.amostras.zeros, 1);
  assert.equal(b.metadados.confianca.nivel, 'baixa');
  assert.match(b.metadados.aviso, /não mede custo individual/);
});
check('agregação dos tipos preserva o delta e contabiliza trecho uma vez', () => {
  const b = base([trecho({ seg: 7200, por_tipo: { worker: 3600, explorer: 3600 } })], [agente()]);
  assert.equal(b.ritmo.__geral.r5, 5);
  assert.equal(b.ritmo.worker.r5, 5);
  assert.equal(b.ritmo.__geral.trechos, 1);
});
check('variabilidade e entradas vazias', () => {
  const b = base([trecho(), trecho({ d5: 30 })], [agente()]);
  assert.equal(b.metadados.variabilidade.ritmo5Desvio, 10);
  assert.equal(b.metadados.variabilidade.ritmo5CV, 0.5);
  assert.equal(base([], []).metadados.idade.maisRecenteS, null);
  assert.equal(base([], []).metadados.variabilidade.ritmo5Desvio, null);
});
check('confiança distingue base insuficiente, baixa e moderada sem precisão individual', () => {
  assert.equal(base([], []).metadados.confianca.nivel, 'insuficiente');
  const ts = Array.from({ length: 5 }, () => trecho());
  const as = Array.from({ length: 5 }, () => agente());
  assert.equal(base(ts, as).metadados.confianca.nivel, 'moderada');
  assert.equal(base(ts.map(t => ({ ...t, d5: 0 })), as).metadados.confianca.nivel, 'baixa');
  const b = base([...ts, trecho({ perfil: null })], [...as, agente({ perfil: null })]);
  assert.equal(b.metadados.perfisDisponiveis.length, 2);
  assert.equal(b.metadados.perfisDisponiveis[0].trechos, 5);
  assert.equal(b.metadados.amostras.trechos, 5);
});
console.log(checks + ' testes passaram');
