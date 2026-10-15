#!/usr/bin/env node
'use strict';
/*
 * aviso.js — hook UserPromptSubmit.
 *
 * D3: pega carona numa mensagem que você já ia mandar. Nunca cria turno,
 * nunca acorda sessão parada. Abaixo do limiar não imprime nada, e nada
 * impresso = zero token gasto.
 */

const fs = require('fs');
const core = require('../lib/core');
const { ritmo } = require('../lib/analise');

function sair(texto) {
  if (texto) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: texto,
      },
    }));
  }
  process.exit(0);
}

try {
  try { fs.readFileSync(0, 'utf8'); } catch (_) {}

  const cfg = core.lerConfig();
  if (!cfg.ligado || !cfg.aviso.ligado) sair(null);          // D2

  // D40 — este hook atrasa a SUA mensagem: lê raramente (aviso_s) e nunca
  // espera outra leitura terminar.
  require('../lib/sonda').garantirFrescoHook(cfg.sonda.aviso_s, { esperar: false });

  const est = core.lerEstado();
  if (!est) sair(null);

  const nowS = core.agora();
  const hist = core.lerHistorico();
  const j = core.lerJanelas(est, cfg, nowS, hist);

  const linhas = [];
  // A assinatura do "não repetir" tem que ser feita de fatos estáveis, nunca do
  // texto formatado: o countdown muda a cada minuto e faria o aviso repetir
  // sempre. A faixa de 10 em 10 deixa escalar (80% → 90%) sem virar spam.
  const chaves = [];
  if (core.CODEX) {
    const p = require('../lib/codex/economia').avaliarEconomia(j, cfg);
    if (p.nivel === 'reduzir' || p.nivel === 'concluir') {
      linhas.push(p.mensagem);
      chaves.push('economia:' + p.nivel + ':' + p.janela + ':' + p.reset);
    }
  }
  // `chave` é interna e fixa; `rotulo` é texto de exibição. Mudar a redação do
  // aviso não pode alterar o comportamento do dedupe.
  const checar = (jan, chave, rotulo, limiar, semanal) => {
    if (jan.pctParaDecidir === null) return;
    if (jan.pctParaDecidir < limiar) return;
    chaves.push(`${chave}:${jan.resetsAt}:${Math.floor(jan.pctParaDecidir / 10)}`);
    const quando = jan.resetsAt === null ? '' :
      (semanal && jan.segAteReset > 86400
        ? ', reseta ' + core.fmtDiaHora(jan.resetsAt)
        : ', reseta em ' + core.fmtDuracao(jan.segAteReset));
    const qualif = jan.estado === 'piso' ? ' (pelo menos — leitura de '
      + core.fmtDuracao(jan.idade) + ' atrás)' : '';
    linhas.push(`${rotulo}: ${jan.pctParaDecidir.toFixed(1)}%${qualif}${quando}`);
  };

  checar(j.cinco, '5h', 'janela de 5h', cfg.aviso.limiar_5h, false);
  checar(j.sete, '7d', 'janela semanal', cfg.aviso.limiar_7d, true);

  if (!linhas.length) sair(null);

  // Não repete antes do intervalo configurado.
  const ult = core.lerJson(core.F.avisoUltimo, null);
  const assinatura = chaves.join('|');
  if (ult && ult.assinatura === assinatura &&
      nowS - ult.t < cfg.aviso.repetir_min * 60) sair(null);
  core.gravarJson(core.F.avisoUltimo, { t: nowS, assinatura });

  const rit = ritmo(hist, 'pct5', 'reset5', est.reset5, est);
  // Só medição, sem projeção: o uso é por rajadas (workflow pesado, dias
  // parado, perguntas lentas), então extrapolar o ritmo atual sobre o
  // relógio descreveria errado quase sempre.
  let extra = '';
  if (rit.pctPorHora !== null) {
    extra = '\nRitmo nos últimos ' + core.fmtDuracao(rit.deltaHoras * 3600) +
            ': ' + rit.pctPorHora.toFixed(1) + '%/h.';
  }

  sair(
    '[cota] Aviso automático de limite de uso:\n' + linhas.map(l => '- ' + l).join('\n') + extra +
    '\nAntes de disparar operação pesada (workflow, fan-out de subagentes), consulte' +
    ' `cota cabe <n>`. Não repita este aviso ao usuário se ele não perguntar.'
  );
} catch (_) {
  process.exit(0);   // falha calada: aviso nunca pode atrapalhar
}
