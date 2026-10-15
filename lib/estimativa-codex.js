'use strict';

// Pure analytics: percentages describe account usage, never an individual bill.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const { normalizarPerfil, chavePerfil } = require('./perfil-codex');

function baseCodex(trechos, agentes, { nowS = Date.now() / 1000, perfil = null,
  meiaVidaDias = 7, maxDias = 30 } = {}) {
  if (!finite(nowS) || nowS < 0 || !finite(meiaVidaDias) || meiaVidaDias <= 0 ||
      !finite(maxDias) || maxDias <= 0) throw new TypeError('Parâmetros de idade inválidos');
  const selecionado = normalizarPerfil(perfil), chave = chavePerfil(selecionado);
  const descartes = { invalidos: 0, futuros: 0, antigos: 0, perfil: 0, mistos: 0 };
  const rs = new Map(), ds = new Map(), tempos = [], taxas = [];
  let nTrechos = 0, nAgentes = 0, horas = 0, zeros = 0, pesoTrechos = 0;
  function peso(a) {
    if (!a || !finite(a.t) || a.t < 0) { descartes.invalidos++; return null; }
    if (a.t > nowS) { descartes.futuros++; return null; }
    const idade = (nowS - a.t) / 86400;
    if (idade > maxDias) { descartes.antigos++; return null; }
    if (a.misto === true) { descartes.mistos++; return null; }
    if (chavePerfil(a.perfil) !== chave) { descartes.perfil++; return null; }
    return Math.pow(2, -idade / meiaVidaDias);
  }
  for (const t of trechos || []) {
    const w = peso(t);
    if (w === null) continue;
    const partes = t.por_tipo && typeof t.por_tipo === 'object' && !Array.isArray(t.por_tipo)
      ? Object.entries(t.por_tipo) : [];
    const soma = partes.reduce((s, [, v]) => s + (finite(v) ? v : NaN), 0);
    const v5 = t.valido5 === true && finite(t.d5) && t.d5 >= 0 && t.d5 <= 100;
    const v7 = t.valido7 === true && finite(t.d7) && t.d7 >= 0 && t.d7 <= 100;
    // seg is rounded by the collector; preserve fractions using the precise sum.
    if (!finite(t.seg) || t.seg <= 0 || !partes.length || partes.some(([, v]) => !finite(v) || v < 0) ||
        !(soma > 0) || Math.abs(soma - t.seg) > 1 || (!v5 && !v7) || partes.some(([k]) => k === '__geral')) {
      descartes.invalidos++; continue;
    }
    nTrechos++; pesoTrechos += w; horas += soma / 3600; tempos.push(t.t);
    if ((v5 && t.d5 === 0) || (v7 && t.d7 === 0)) zeros++;
    if (v5) taxas.push({ valor: t.d5 / (soma / 3600), peso: w * soma / 3600 });
    const adicionar = (k, seg, fracao) => {
      if (!rs.has(k)) rs.set(k, { s5: 0, h5: 0, s7: 0, h7: 0, trechos: 0 });
      const b = rs.get(k); b.trechos++;
      if (v5) { b.s5 += t.d5 * fracao * w; b.h5 += seg / 3600 * w; }
      if (v7) { b.s7 += t.d7 * fracao * w; b.h7 += seg / 3600 * w; }
    };
    adicionar('__geral', soma, 1);
    for (const [k, seg] of partes) if (seg > 0) adicionar(k, seg, seg / soma);
  }
  for (const a of agentes || []) {
    const w = peso(a);
    if (w === null) continue;
    if (!finite(a.dur_s) || a.dur_s < 0 || a.tipo === '__geral') { descartes.invalidos++; continue; }
    nAgentes++; tempos.push(a.t);
    for (const k of [typeof a.tipo === 'string' && a.tipo ? a.tipo : 'desconhecido', '__geral']) {
      if (!ds.has(k)) ds.set(k, { n: 0, soma: 0, peso: 0 });
      const b = ds.get(k); b.n++; b.soma += a.dur_s * w; b.peso += w;
    }
  }
  const ritmo = Object.fromEntries([...rs].map(([k, b]) => [k, {
    r5: b.h5 > 0 ? b.s5 / b.h5 : null, h5: b.h5,
    r7: b.h7 > 0 ? b.s7 / b.h7 : null, h7: b.h7, trechos: b.trechos,
  }]));
  const duracao = Object.fromEntries([...ds].map(([k, b]) => [k, { n: b.n, media_s: b.soma / b.peso }]));
  const somaPeso = taxas.reduce((s, t) => s + t.peso, 0);
  const media = somaPeso ? taxas.reduce((s, t) => s + t.valor * t.peso, 0) / somaPeso : null;
  const desvio = taxas.length > 1 ? Math.sqrt(taxas.reduce((s, t) => s + t.peso * (t.valor - media) ** 2, 0) / somaPeso) : null;
  const cv = desvio !== null && media > 0 ? desvio / media : null;
  const motivos = [];
  if (nTrechos < 5 || nAgentes < 5) motivos.push('Poucas amostras');
  if (horas < 1) motivos.push('Menos de uma hora de subagente observada');
  if (zeros) motivos.push('Deltas zero podem estar abaixo da resolução do percentual');
  if (Object.values(selecionado).some(v => v === null)) motivos.push('Perfil incompleto ou desconhecido');
  if (taxas.length < 5) motivos.push('Poucos trechos válidos na janela de 5 horas');
  if (cv !== null && cv > 0.5) motivos.push('Ritmo variável entre trechos');
  const maisRecenteS = tempos.length ? nowS - tempos.reduce((a, b) => Math.max(a, b)) : null;
  if (maisRecenteS !== null && maisRecenteS > meiaVidaDias * 86400) motivos.push('Amostras recentes ausentes');
  const nivel = !nTrechos || !nAgentes ? 'insuficiente' : motivos.length ? 'baixa' : 'moderada';
  motivos.push('Consumo coletivo da conta; atribuição individual não observável');
  const inventario = new Map();
  for (const [lista, campo] of [[trechos, 'trechos'], [agentes, 'agentes']]) {
    for (const a of lista || []) {
      if (!a || !finite(a.t) || a.t < 0 || a.t > nowS || nowS - a.t > maxDias * 86400 || a.misto) continue;
      if (campo === 'agentes' && (!finite(a.dur_s) || a.dur_s < 0)) continue;
      if (campo === 'trechos' && (!finite(a.seg) || a.seg <= 0 ||
        !((a.valido5 === true && finite(a.d5) && a.d5 >= 0 && a.d5 <= 100) ||
          (a.valido7 === true && finite(a.d7) && a.d7 >= 0 && a.d7 <= 100)))) continue;
      if (campo === 'trechos') {
        const partes = a.por_tipo && typeof a.por_tipo === 'object' && !Array.isArray(a.por_tipo)
          ? Object.entries(a.por_tipo) : [];
        const soma = partes.reduce((s, [, v]) => s + (finite(v) ? v : NaN), 0);
        if (!partes.length || partes.some(([k, v]) => k === '__geral' || !finite(v) || v < 0) ||
            !(soma > 0) || Math.abs(soma - a.seg) > 1) continue;
      }
      if (campo === 'agentes' && a.tipo === '__geral') continue;
      const k = chavePerfil(a.perfil);
      if (!inventario.has(k)) inventario.set(k, { perfil: normalizarPerfil(a.perfil), trechos: 0, agentes: 0 });
      inventario.get(k)[campo]++;
    }
  }
  return { ritmo, duracao, metadados: {
    perfil: selecionado,
    perfisDisponiveis: [...inventario.values()],
    confianca: { nivel, heuristica: true, motivos },
    amostras: { trechos: nTrechos, agentes: nAgentes, trechosPonderados: pesoTrechos, horas, zeros },
    idade: { maisRecenteS,
      maisAntigaS: tempos.length ? nowS - tempos.reduce((a, b) => Math.min(a, b)) : null, meiaVidaDias, maxDias },
    variabilidade: { ritmo5Desvio: desvio, ritmo5CV: cv }, descartes,
    consumo: 'conta', aviso: 'Estimativa heurística do consumo da conta por hora de subagente. Inclui a conversa principal e qualquer outra atividade simultânea; não mede custo individual.',
  } };
}

module.exports = { baseCodex, normalizarPerfil, chavePerfil };
