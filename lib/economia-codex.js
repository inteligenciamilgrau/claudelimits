'use strict';
function avaliarEconomia(janelas, cfg) {
  const op = cfg.economia;
  if (!op.ligado) return { nivel: 'desligada', iniciar_nova_onda: null, mensagem: 'Política de economia desativada.' };
  const validas = Object.entries(janelas || {}).filter(([, j]) =>
    j && Number.isFinite(j.pctParaDecidir));
  if (!validas.length) return { nivel: 'sem_dado', iniciar_nova_onda: false,
    mensagem: 'Sem saldo utilizável. Consulte a cota antes de abrir nova onda.' };
  const [nome, janela] = validas.reduce((a, b) => a[1].pctParaDecidir >= b[1].pctParaDecidir ? a : b);
  const restante = Math.max(0, 100 - janela.pctParaDecidir);
  const nivel = restante < op.concluir_abaixo_pct ? 'concluir'
    : restante < op.evitar_ondas_abaixo_pct ? 'reduzir' : 'normal';
  const rotulo = nome === 'cinco' ? '5h' : '7d';
  const saldo = janela.estado === 'piso' ? 'no máximo ' : '';
  const instrucao = nivel === 'concluir'
    ? 'Conclua somente o trecho em andamento, registre o que falta e informe o reset. Não inicie nova onda nem retome automaticamente.'
    : nivel === 'reduzir'
      ? 'Evite novas ondas de subagentes. Prefira trabalho sequencial e consulte novamente antes de outra etapa.'
      : 'Prefira uma tarefa por vez; consulte novamente antes e depois de etapas maiores.';
  return { nivel, iniciar_nova_onda: nivel === 'normal', janela: rotulo,
    restante_pct: restante, restante_e_teto: janela.estado === 'piso', reset: janela.resetsAt,
    cobertura_parcial: validas.length < 2, recomendacao: true,
    mensagem: `[cota] ${rotulo}: ${saldo}${restante.toFixed(1)}% disponível. ${instrucao}` };
}
module.exports = { avaliarEconomia };
