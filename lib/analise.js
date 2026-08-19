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

function ritmo(hist, chavePct, chaveReset, resetsAt) {
  const r = { pctPorHora: null, amostras: 0, deltaPct: null, deltaHoras: null,
              motivo: null };
  if (resetsAt === null || resetsAt === undefined) return r;

  const pts = hist
    .filter(h => h[chaveReset] === resetsAt && num(h[chavePct]) !== null)
    .sort((a, b) => a.t - b.t);
  r.amostras = pts.length;
  if (pts.length < 2) { r.motivo = 'precisa de 2+ leituras'; return r; }

  const a = pts[0], b = pts[pts.length - 1];
  const horas = (b.t - a.t) / 3600;
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
/*
 * D14 + D32 — média agrupada, e amostra suja é melhor que amostra nenhuma.
 *
 * Duas correções que vieram do primeiro workflow real, com 9 ondas medidas:
 *
 *   n=7 → 21%   n=16 → 7%   n=14 → 7%   n=6 → 10%   n=4 → 9%   ...
 *   65% gastos em 63 agentes.
 *
 * (1) Só 2 das 9 ondas passaram no critério de limpa, e eram as duas mais
 *     CURTAS — que mediram 0%, porque o percentual vem em inteiro e uma onda de
 *     94s custa menos de 1%. Zero não quer dizer "de graça", quer dizer "abaixo
 *     da resolução". A média das limpas deu 0.000%/agente, e o `cabe` respondia
 *     SEM BASE com 12 amostras na mão. O filtro escolhia sistematicamente as
 *     ondas mais baratas e concluía que agente é grátis.
 *
 * (2) O motivo de sujeira dominante é "outra sessão escreveu no período" — e
 *     esse usuário roda VS Code e TUI ao mesmo tempo, por padrão. O critério
 *     supunha uma sessão só. Contaminação de outra sessão INFLA o Δ, ou seja,
 *     erra para o lado seguro no controle de admissão. Superestimar custo deixa
 *     conservador; não ter número nenhum deixa cego.
 *
 * Então: prefere a base limpa, cai para a completa quando a limpa não produz
 * custo positivo, e diz em qual das duas está apoiado.
 *
 * A média é AGRUPADA (soma dos custos ÷ soma dos agentes), não média de médias.
 * Como cada participante carrega Δ_onda/n, somar tudo e dividir pelo total dá
 * exatamente ΣΔ/Σn — o estimador que respeita o peso de cada onda. Com os dados
 * acima: 65/63 = 1.03%/agente.
 */
function custoPorTipo(amostras) {
  const acc = {};
  const balde = chave => acc[chave] || (acc[chave] = {
    limpa: { n: 0, s5: 0, s7: 0, dur: 0 },
    todas: { n: 0, s5: 0, s7: 0, dur: 0 },
  });
  const somar = (alvo, a) => {
    alvo.n++; alvo.s5 += a.custo5 || 0; alvo.s7 += a.custo7 || 0; alvo.dur += a.dur_s || 0;
  };

  for (const a of amostras) {
    for (const chave of [a.tipo || 'desconhecido', '__geral']) {
      const b = balde(chave);
      somar(b.todas, a);
      if (a.limpa) somar(b.limpa, a);
    }
  }

  const out = {};
  for (const [k, b] of Object.entries(acc)) {
    // A base limpa só serve se produzir custo positivo: média zero não é
    // "custa nada", é "não deu para medir".
    const limpaServe = b.limpa.n > 0 && b.limpa.s5 > 0;
    const s = limpaServe ? b.limpa : b.todas;
    if (s.n === 0) continue;
    out[k] = {
      n: s.n,
      media5: s.s5 / s.n,
      media7: s.s7 / s.n,
      duracaoMedia: s.dur / s.n,
      base: limpaServe ? 'limpa' : 'completa',
      nLimpa: b.limpa.n,
      nTodas: b.todas.n,
    };
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
    baseQualidade: medio ? medio.base : null,
    baseLimpas: medio ? medio.nLimpa : 0,
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
    // Q5 — sem amostra limpa, libera avisando. Recusar travaria tudo no início.
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
