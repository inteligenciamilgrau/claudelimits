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
 * D32 — média AGRUPADA: soma dos custos ÷ soma dos agentes, não média de
 * médias. Como cada participante carrega Δ_onda/n, somar tudo e dividir pelo
 * total dá exatamente ΣΔ/Σn — o estimador que respeita o peso de cada onda.
 *
 * Do primeiro workflow real, 9 ondas: 65% gastos em 63 agentes = 1.03%/agente.
 * Onda curta mede 0% (o percentual vem em inteiro) e entra na média assim
 * mesmo: zero ali não é "de graça", é "abaixo da resolução", e só a soma com
 * as ondas longas diz o custo de verdade.
 */
function custoPorTipo(amostras) {
  const acc = {};
  for (const a of amostras) {
    for (const k of [a.tipo || 'desconhecido', '__geral']) {
      const b = acc[k] || (acc[k] = { n: 0, s5: 0, s7: 0, dur: 0 });
      b.n++; b.s5 += a.custo5 || 0; b.s7 += a.custo7 || 0; b.dur += a.dur_s || 0;
    }
  }
  const out = {};
  for (const [k, b] of Object.entries(acc)) {
    out[k] = { n: b.n, media5: b.s5 / b.n, media7: b.s7 / b.n, duracaoMedia: b.dur / b.n };
  }
  return out;
}

function medioPara(custos, tipo) {
  if (tipo && custos[tipo] && custos[tipo].n > 0) return { ...custos[tipo], fonte: tipo };
  if (custos.__geral && custos.__geral.n > 0) return { ...custos.__geral, fonte: 'geral' };
  return null;
}

/*
 * A conta da missão:
 *   cabe?  =  n × custo_por_agente  <  restante × margem
 *
 * D15 — avalia as duas janelas e obedece a pior.
 * D16 — quando não cabe, esperar o reset é uma das respostas.
 */
function admissao({ janelas, custos, cfg, n, tipo, nowS }) {
  const margem = cfg.admissao.margem;
  const medio = medioPara(custos, tipo);

  const res = {
    n, tipo: tipo || null, margem,
    baseAmostras: medio ? medio.n : 0,
    baseFonte: medio ? medio.fonte : null,
    janelas: {}, veredito: null, janelaCritica: null,
    quantosCabem: null, esperarAte: null, motivo: null, onda: null,
  };

  const avaliar = (nome, jan, custoUnit) => {
    const o = { nome, disponivel: false, restante: null, orcamento: null,
                custoUnit: null, custoTotal: null, cabe: null, cabemN: null,
                estadoDado: jan.estado };
    if (jan.pctParaDecidir === null) return o;
    o.disponivel = true;
    o.restante = 100 - jan.pctParaDecidir;
    o.orcamento = o.restante * margem;
    if (custoUnit === null || !(custoUnit > 0)) return o;
    o.custoUnit = custoUnit;
    o.custoTotal = custoUnit * n;
    o.cabe = o.custoTotal <= o.orcamento;
    o.cabemN = Math.floor(o.orcamento / custoUnit);
    return o;
  };

  const j5 = avaliar('5h', janelas.cinco, medio ? medio.media5 : null);
  const j7 = avaliar('7d', janelas.sete, medio ? medio.media7 : null);
  res.janelas = { cinco: j5, sete: j7 };

  const comConta = [j5, j7].filter(j => j.cabe !== null);

  if (!j5.disponivel && !j7.disponivel) {
    res.veredito = 'sem_dado';
    res.motivo = 'nenhuma janela com valor utilizável (dado expirado ou ausente)';
    return res;
  }
  if (!medio) {
    // Sem amostra, libera avisando. Recusar travaria tudo no início.
    res.veredito = 'sem_base';
    res.motivo = 'ainda não há amostra de custo por agente; não dá para ' +
                 'estimar. Dispare uma onda pequena: ela é o que forma a base.';
    res.onda = calcularOnda(res, n, null);
    return res;
  }
  if (comConta.length === 0) {
    res.veredito = 'sem_base';
    res.motivo = medio && medio.media5 <= 0
      ? 'as ' + medio.n + ' amostras somam custo zero — as ondas medidas foram ' +
        'curtas demais para aparecer no percentual, que vem em número inteiro. ' +
        'Uma onda mais longa resolve.'
      : 'há amostras, mas nenhuma janela com valor utilizável para comparar';
    return res;
  }

  // A pior janela manda (D15).
  const pior = comConta.reduce((a, b) => (a.cabemN <= b.cabemN ? a : b));
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
             porque: 'sem amostra de custo: esta onda serve para medir. ' +
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

module.exports = { ritmo, custoPorTipo, medioPara, admissao, calcularOnda };
