'use strict';
/*
 * codex/perfil.js — modelo, esforço e velocidade de um subagente.
 *
 * O custo de um subagente depende dessas três coisas, então a estimativa só
 * compara amostras do mesmo perfil. O que o hook não informar fica
 * desconhecido: nunca se presume o padrão do Codex.
 */
const texto = v => typeof v === 'string' && v.trim() ? v.trim() : null;
function normalizarPerfil(value = {}) {
  return { modelo: texto(value?.modelo), esforco: texto(value?.esforco), velocidade: texto(value?.velocidade) };
}
function chavePerfil(value) {
  const p = normalizarPerfil(value);
  return JSON.stringify([p.modelo, p.esforco, p.velocidade]);
}
function perfilDoEvento(ev = {}) {
  return normalizarPerfil({
    modelo: ev.agent_model ?? ev.model,
    esforco: ev.reasoning_effort ?? ev.model_reasoning_effort,
    velocidade: ev.speed_mode ?? ev.speed,
  });
}
module.exports = { normalizarPerfil, chavePerfil, perfilDoEvento };
