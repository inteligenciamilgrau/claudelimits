'use strict';
/*
 * codex/economia.js — quando parar de abrir ondas de subagentes.
 *
 * Vale a janela mais gasta (5h ou semanal). Os limiares são em % CONSUMIDO,
 * como todo número do cota:
 *
 *   até reduzir_acima_de (70)       normal    — pode abrir ondas
 *   acima de reduzir_acima_de       reduzir   — evitar ondas novas
 *   acima de concluir_acima_de (85) concluir  — terminar o trecho e parar
 *
 * A comparação é estrita: exatamente 70% ainda é normal. Leitura velha
 * ("piso") é um mínimo — o consumo real pode ser maior, nunca menor.
 * É recomendação: nenhum hook bloqueia ferramenta nem cancela tarefa.
 */
function avaliarEconomia(janelas, cfg) {
  const op = cfg.economia;
  if (!op.ligado) return { nivel: 'desligada', iniciar_nova_onda: null, mensagem: 'Política de economia desativada.' };
  const validas = Object.entries(janelas || {}).filter(([, j]) =>
    j && Number.isFinite(j.pctParaDecidir));
  if (!validas.length) return { nivel: 'sem_dado', iniciar_nova_onda: false,
    mensagem: 'Sem saldo utilizável. Consulte a cota antes de abrir nova onda.' };
  const [nome, janela] = validas.reduce((a, b) => a[1].pctParaDecidir >= b[1].pctParaDecidir ? a : b);
  const consumido = Math.min(100, Math.max(0, janela.pctParaDecidir));
  const nivel = consumido > op.concluir_acima_de ? 'concluir'
    : consumido > op.reduzir_acima_de ? 'reduzir' : 'normal';
  const rotulo = nome === 'cinco' ? '5h' : '7d';
  const piso = janela.estado === 'piso';
  const instrucao = nivel === 'concluir'
    ? 'Conclua somente o trecho em andamento, registre o que falta e informe o reset. Não inicie nova onda nem retome automaticamente.'
    : nivel === 'reduzir'
      ? 'Evite novas ondas de subagentes. Prefira trabalho sequencial e consulte novamente antes de outra etapa.'
      : 'Prefira uma tarefa por vez; consulte novamente antes e depois de etapas maiores.';
  return { nivel, iniciar_nova_onda: nivel === 'normal', janela: rotulo,
    consumido_pct: consumido, consumido_e_piso: piso, reset: janela.resetsAt,
    cobertura_parcial: validas.length < 2, recomendacao: true,
    mensagem: `[cota] ${rotulo}: ${piso ? 'pelo menos ' : ''}${consumido.toFixed(1)}% consumido. ${instrucao}` };
}
module.exports = { avaliarEconomia };
