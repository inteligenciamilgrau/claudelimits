'use strict';
/*
 * analise.js — ritmo, custo por agente e a conta de admissão.
 *
 * Tudo em % da janela. Dólar não entra (D13).
 */

const { num } = require('./core');

/*
 * D13 — ritmo = Δ% ÷ Δtempo, só entre pontos da MESMA janela.
 * resets_at diferente significa que a janela virou e o histórico anterior
 * não vale mais (D4).
 */
/*
 * Intervalo mínimo antes de reportar ritmo. Duas leituras a 27 segundos de
 * distância com 1 ponto de diferença extrapolam para 133%/h — número lixo que
 * dispara alarme falso e faria a admissão recusar trabalho à toa. Melhor dizer
 * "ainda não sei" do que dizer uma bobagem com cara de precisão.
 */
const MIN_HORAS = 0.25;
// O "passado recente" que o ritmo mede.
const JANELA_RITMO_H = 1;

/*
 * Ritmo da última hora (ou do que houver dela, se a janela é mais nova).
 *
 * O histórico só ganha ponto quando o número muda, então ele é uma escada: o
 * valor num instante é o do último ponto até ali. `atual` é a leitura de agora
 * — sem ela, um período parado depois da subida não aparecia, e às 13h a
 * ferramenta dizia "28%/h nos últimos 40min" sobre uma subida das 9h, com o
 * ritmo real em zero.
 */
function ritmo(hist, chavePct, chaveReset, resetsAt, atual) {
  const r = { pctPorHora: null, amostras: 0, deltaPct: null, deltaHoras: null,
              motivo: null };
  if (resetsAt === null || resetsAt === undefined) return r;

  const pts = hist
    .filter(h => h[chaveReset] === resetsAt && num(h[chavePct]) !== null)
    .sort((a, b) => a.t - b.t);
  if (atual && atual[chaveReset] === resetsAt && num(atual[chavePct]) !== null &&
      (!pts.length || atual.t > pts[pts.length - 1].t)) {
    pts.push({ t: atual.t, [chavePct]: atual[chavePct] });
  }
  if (pts.length < 2) { r.amostras = pts.length; r.motivo = 'precisa de 2+ leituras'; return r; }

  const b = pts[pts.length - 1];
  const inicio = b.t - JANELA_RITMO_H * 3600;
  // O valor no começo do período é o do último ponto até lá; se a janela é
  // mais nova que o período, começa no primeiro ponto dela.
  let a = pts[0];
  for (const p of pts) if (p.t <= inicio) a = p;
  const tA = Math.max(a.t, inicio);
  r.amostras = pts.filter(p => p.t >= tA).length + (a.t < tA ? 1 : 0);
  const horas = (b.t - tA) / 3600;
  if (horas <= 0) { r.motivo = 'leituras no mesmo instante'; return r; }

  r.deltaPct = b[chavePct] - a[chavePct];
  r.deltaHoras = horas;
  if (horas < MIN_HORAS) {
    r.motivo = 'leituras cobrem só ' + Math.round(horas * 3600) + 's; ' +
               'precisa de ' + Math.round(MIN_HORAS * 60) + 'min';
    return r;
  }
  r.pctPorHora = r.deltaPct / horas;
  return r;
}

/*
 * NÃO existe projeção aqui, e a ausência é deliberada.
 *
 * Já houve uma: extrapolava `pctPorHora` até 100% e avisava se isso caía antes
 * do reset. Ela emitia "acaba ANTES do reset" com 1% consumido, porque media
 * 55min de trabalho ativo e projetava 167h de relógio.
 *
 * O erro não era base curta — era supor processo estacionário. O uso real é
 * por regimes: workflow violento que queima a cota em minutos, depois dois
 * dias sem acessar, depois sessão interativa lenta de pergunta e resposta.
 * Nenhuma média entre esses três descreve qualquer um deles, então medir mais
 * tempo não conserta: só produz uma média mais confiante e igualmente errada.
 *
 * O que sobrevive é `ritmo()`, que é MEDIÇÃO do passado recente e responde
 * "está indo rápido demais?". A pergunta "quando acaba?" fica sem resposta de
 * propósito — e `admissao()` não precisa dela: decide por custo medido por
 * subagente contra o que resta, que é aritmética, não previsão.
 */

/*
 * D48 — o RITMO de um subagente, não o custo total.
 *
 * As janelas são de 5h, e um subagente pode rodar 12h: ele gasta um pedaço de
 * uma janela, outro da seguinte, outro da terceira. "Custo total em % de uma
 * janela de 5h" não descreve isso — e o trecho que atravessa um reset nem tem
 * Δ (o número de antes é da janela velha, o de depois é da nova). Contando
 * custo total, todo subagente que rodasse num trecho assim ficava sem amostra,
 * e a base ficava só com os curtos: subestimava trabalho longo, o lado
 * perigoso.
 *
 * O que se mede agora é quanto da janela um subagente gasta POR HORA rodando.
 * Cada trecho válido é uma amostra: o que a cota subiu, dividido pelas horas de
 * subagente no trecho (D47). O que atravessa um reset é só pulado — nas duas
 * janelas, cada uma pelo seu reset — e os trechos antes e depois continuam
 * valendo. A duração típica, medida à parte, completa a conta da admissão.
 *
 * D32 — a média é AGRUPADA: soma dos Δ ÷ soma das horas, não média dos ritmos.
 * Trecho curto mede 0% (o percentual é inteiro) e entra assim mesmo — zero ali
 * é "abaixo da resolução", não "de graça", e só a soma com os trechos longos
 * diz o ritmo de verdade.
 */
function ritmoPorTipo(trechos) {
  const acc = {};
  const balde = k => acc[k] || (acc[k] = { s5: 0, h5: 0, s7: 0, h7: 0, trechos: 0 });
  for (const t of trechos) {
    const total = num(t.seg);
    if (!(total > 0) || !t.por_tipo) continue;
    const v5 = t.valido5 && num(t.d5) !== null, v7 = t.valido7 && num(t.d7) !== null;
    if (!v5 && !v7) continue;
    balde('__geral').trechos++;
    for (const [tipo, seg] of Object.entries(t.por_tipo)) {
      if (!(num(seg) > 0)) continue;
      const fracao = seg / total;   // a parte do trecho que foi deste tipo
      for (const k of [tipo, '__geral']) {
        const b = balde(k);
        if (v5) { b.s5 += t.d5 * fracao; b.h5 += seg / 3600; }
        if (v7) { b.s7 += t.d7 * fracao; b.h7 += seg / 3600; }
      }
      balde(tipo).trechos++;
    }
  }
  const out = {};
  for (const [k, b] of Object.entries(acc)) {
    out[k] = { r5: b.h5 > 0 ? b.s5 / b.h5 : null, h5: b.h5,
               r7: b.h7 > 0 ? b.s7 / b.h7 : null, h7: b.h7, trechos: b.trechos };
  }
  return out;
}

// Quanto um subagente costuma rodar, do SubagentStart ao SubagentStop.
function duracaoPorTipo(agentes) {
  const acc = {};
  for (const a of agentes) {
    if (!(num(a.dur_s) >= 0)) continue;
    for (const k of [a.tipo || 'desconhecido', '__geral']) {
      const b = acc[k] || (acc[k] = { n: 0, soma: 0 });
      b.n++; b.soma += a.dur_s;
    }
  }
  const out = {};
  for (const [k, b] of Object.entries(acc)) out[k] = { n: b.n, media_s: b.soma / b.n };
  return out;
}

const base = (trechos, agentes) => ({ ritmo: ritmoPorTipo(trechos), duracao: duracaoPorTipo(agentes) });

// O tipo pedido, se ele já tem ritmo E duração; senão o geral.
function medioPara(b, tipo) {
  const r = (b && b.ritmo) || {}, d = (b && b.duracao) || {};
  const tem = k => r[k] && r[k].r5 !== null && d[k] && d[k].n > 0;
  const k = tipo && tem(tipo) ? tipo : (tem('__geral') ? '__geral' : null);
  if (!k) return null;
  return { fonte: k === '__geral' ? 'geral' : k, r5: r[k].r5, r7: r[k].r7,
           horas: r[k].h5, trechos: r[k].trechos, dur_s: d[k].media_s, agentes: d[k].n };
}

/*
 * A conta da missão:
 *   cabe?  =  n × ritmo × tempo dentro da janela  ≤  restante × margem
 *
 * O tempo dentro da janela é a duração típica, cortada no reset (D48): o que
 * um subagente gastar depois do reset cai na janela seguinte. Por isso um
 * fan-out de agentes longos pode caber nas 5h de agora — e a semanal, que
 * conta a duração inteira, vira o limite de verdade.
 *
 * D15 — avalia as duas janelas e obedece a pior.
 * D16 — quando não cabe, esperar o reset é uma das respostas.
 */
function admissao({ janelas, base: b, cfg, n, tipo, nowS }) {
  const margem = cfg.admissao.margem;
  const medio = medioPara(b, tipo);

  const res = {
    n, tipo: tipo || null, margem,
    base: medio ? { fonte: medio.fonte, ritmo5_h: medio.r5, ritmo7_h: medio.r7, duracao_s: medio.dur_s,
                    horas: medio.horas, trechos: medio.trechos, agentes: medio.agentes } : null,
    janelas: {}, veredito: null, janelaCritica: null,
    quantosCabem: null, esperarAte: null, motivo: null, onda: null,
  };

  const avaliar = (nome, jan, ritmoH) => {
    const o = { nome, disponivel: false, restante: null, orcamento: null,
                custoUnit: null, custoTotal: null, cabe: null, cabemN: null,
                segNaJanela: null, estadoDado: jan.estado };
    if (jan.pctParaDecidir === null) return o;
    o.disponivel = true;
    o.restante = 100 - jan.pctParaDecidir;
    o.orcamento = o.restante * margem;
    if (!medio || !(ritmoH > 0) || !(medio.dur_s > 0)) return o;
    o.segNaJanela = jan.segAteReset !== null && jan.segAteReset > 0
      ? Math.min(medio.dur_s, jan.segAteReset) : medio.dur_s;
    o.custoUnit = ritmoH * o.segNaJanela / 3600;
    o.custoTotal = o.custoUnit * n;
    o.cabe = o.custoTotal <= o.orcamento;
    o.cabemN = Math.floor(o.orcamento / o.custoUnit);
    return o;
  };

  const j5 = avaliar('5h', janelas.cinco, medio ? medio.r5 : null);
  const j7 = avaliar('7d', janelas.sete, medio ? medio.r7 : null);
  res.janelas = { cinco: j5, sete: j7 };

  const comConta = [j5, j7].filter(j => j.cabe !== null);

  if (!j5.disponivel && !j7.disponivel) {
    res.veredito = 'sem_dado';
    res.motivo = 'nenhuma janela com valor utilizável (dado expirado ou ausente)';
    return res;
  }
  if (!medio) {
    // Sem medida, libera avisando. Recusar travaria tudo no início.
    res.veredito = 'sem_base';
    res.motivo = 'ainda não há medida do ritmo e da duração de um subagente; não dá ' +
                 'para estimar. Dispare uma onda pequena: ela é o que forma a base.';
    res.onda = calcularOnda(res, n, null);
    return res;
  }
  if (comConta.length === 0) {
    res.veredito = 'sem_base';
    res.motivo = medio.r5 <= 0
      ? `os ${medio.trechos} trecho(s) medidos somam 0% — curtos demais para aparecer no ` +
        'percentual, que vem em número inteiro. Mais tempo de subagente rodando resolve.'
      : 'há medida, mas nenhuma janela com valor utilizável para comparar';
    return res;
  }

  // A pior janela manda (D15).
  const pior = comConta.reduce((a, c) => (a.cabemN <= c.cabemN ? a : c));
  res.janelaCritica = pior.nome;
  res.quantosCabem = pior.cabemN;

  if (!pior.cabe) {
    res.veredito = 'nao_cabe';
    res.motivo = `${n}× ${pior.custoUnit.toFixed(2)}% = ${pior.custoTotal.toFixed(1)}% ` +
                 `da janela ${pior.nome}, mas o orçamento é ${pior.orcamento.toFixed(1)}%`;
    // D16 — se a de 5h reseta logo, esperar devolve a janela inteira.
    const j = janelas.cinco;
    if (pior.nome === '5h' && j.segAteReset !== null && j.segAteReset > 0) {
      res.esperarAte = j.resetsAt;
    }
  } else if (pior.custoTotal > pior.orcamento * 0.8) {
    res.veredito = 'apertado';
    res.motivo = `cabe, mas consome ${((pior.custoTotal / pior.orcamento) * 100).toFixed(0)}% ` +
                 `do orçamento da janela ${pior.nome}`;
  } else {
    res.veredito = 'vai';
    res.motivo = `${pior.custoTotal.toFixed(1)}% de um orçamento de ${pior.orcamento.toFixed(1)}% ` +
                 `na janela ${pior.nome}`;
  }
  // D29 — quantos disparar AGORA. Só faz sentido se o veredito libera.
  if (res.veredito !== 'nao_cabe') res.onda = calcularOnda(res, n, pior);
  return res;
}

/*
 * D29 — onda em vez de salva. Quantos disparar AGORA, não só se N cabe.
 *
 * Observação de campo: disparar 10 de uma vez gasta a cota no momento em que
 * se sabe menos sobre ela. Em ondas, cada uma devolve medição (o medidor grava
 * no SubagentStop) e a seguinte decide com base melhor — e dá para parar entre
 * uma e outra, que é a única hora em que parar é barato.
 *
 * Isso também resolve o `SEM BASE` inicial: sem amostra, o veredito antigo
 * dizia "rode e a base se forma sozinha", convidando a disparar tudo justo
 * quando não há estimativa nenhuma. Uma primeira onda pequena é o que cria a
 * base, e errar nela é barato.
 */
const FRACAO_ONDA = 0.25;   // uma onda não passa de 1/4 do orçamento
const ONDA_CEGA = 2;        // sem base nenhuma, começa com isto

function calcularOnda(res, n, pior) {
  // Sem base: onda mínima, cujo propósito é medir, não produzir.
  if (!pior || pior.custoUnit === null) {
    return { tamanho: Math.min(n, ONDA_CEGA), restantes: Math.max(0, n - ONDA_CEGA),
             porque: 'sem medida de ritmo: esta onda serve para medir. ' +
                     'Depois que ela terminar, rode `cabe` de novo — aí haverá base.' };
  }
  const teto = Math.floor((pior.orcamento * FRACAO_ONDA) / pior.custoUnit);
  const limite = Math.min(n, pior.cabemN);
  const tamanho = Math.max(1, Math.min(limite, teto));
  if (tamanho >= n) return { tamanho: n, restantes: 0, porque: null };
  return { tamanho, restantes: n - tamanho,
           porque: `uma onda de ${tamanho} custa ~${(tamanho * pior.custoUnit).toFixed(1)}% ` +
                   `da janela ${pior.nome}; medindo entre as ondas, errar sai barato` };
}

module.exports = { ritmo, ritmoPorTipo, duracaoPorTipo, base, medioPara, admissao, calcularOnda };
