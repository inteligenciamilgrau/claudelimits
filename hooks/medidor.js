#!/usr/bin/env node
'use strict';
/*
 * medidor.js — hooks SubagentStart e SubagentStop.
 *
 * Mede o RITMO de um subagente — quanto da janela ele gasta por hora rodando
 * (D48) — e quanto tempo eles costumam rodar; e vigia a cota durante o
 * trabalho (D30).
 *
 * D47 — a medição é feita em TRECHOS. A cota é um número só, da conta
 * inteira: o gasto de um subagente não se lê direto. Então a cota é lida em
 * marcos, e cada trecho entre dois marcos vira uma amostra de ritmo: o que a
 * cota subiu, dividido pelas horas de subagente rodando nele (de todas as
 * sessões — os hooks são globais).
 *
 *   10:00 marco 40%   A e B começam
 *   10:03 B termina → marco 46%: 6% em 6min de subagente (3 de A, 3 de B)
 *   10:05 A termina → marco 48%: 2% em 2min de subagente (só A)
 *                     ritmo: 8% em 8min de subagente = 60%/h por subagente
 *
 * Trecho que atravessa um reset não tem Δ naquela janela (o número de antes é
 * da janela velha): é pulado nela, e só nela — os trechos antes e depois
 * continuam valendo, e um subagente de 12h entra na conta como qualquer outro.
 * A duração de cada um é gravada quando ele termina.
 *
 * Um subagente que termina só lê a cota se o trecho em curso já tiver
 * `medidor.trecho_s` (2min) ou se o céu esvaziou; senão o trecho segue. Assim
 * a leitura (~1,5s) não segura cada um que termina.
 *
 * Nada aqui faz leitura-alteração-regravação de arquivo compartilhado (D33):
 * cada subagente grava só os próprios arquivos, e quem fecha um trecho o
 * reivindica renomeando o marco — só um consegue.
 *
 * Nunca bloqueia — parar é decisão do agente (D17), e SubagentStop bloquearia
 * o subagente errado (o que já terminou).
 */

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const sonda = require('../lib/sonda');

const VOO = core.F.emVoo;
const FIM = core.F.terminados;

function lerStdin() {
  if (core.CODEX && Object.prototype.hasOwnProperty.call(core, 'eventoHook')) return core.eventoHook;
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return null; }
}

const seguro = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const arq = (dir, id) => path.join(dir, seguro(id) + '.json');
const apagar = p => { try { fs.unlinkSync(p); } catch (_) {} };

function listar(dir) {
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
}
const ler = dir => listar(dir).map(n => Object.assign(
  {}, core.lerJson(path.join(dir, n), {}), { arquivo: path.join(dir, n), id: n.slice(0, -5) }));
const emVoo = () => listar(VOO);

// Registro antigo, de antes do D47, guarda o início em segundos.
const t0De = e => (core.num(e.t0_ms) !== null ? e.t0_ms : (core.num(e.t0) || 0) * 1000);

// Alguém está fechando um trecho agora: o marco foi renomeado para isto.
function fechandoAgora() {
  let nomes = [];
  try { nomes = fs.readdirSync(core.DIR); } catch (_) { return false; }
  return nomes.some(n => {
    if (!n.startsWith('marco.json.fechando.')) return false;
    try { return Date.now() - fs.statSync(path.join(core.DIR, n)).mtimeMs < 60000; }
    catch (_) { return false; }
  });
}

// Os trechos acabaram sem medida: nada daqui serve para o próximo.
function descartarTudo() {
  apagar(core.F.marco);
  for (const n of listar(FIM)) apagar(path.join(FIM, n));
}

/*
 * D25 — a sessão desse subagente ainda está viva? Pelo registro que o próprio
 * Claude Code mantém, um `~/.claude/sessions/<pid>.json` por sessão aberta,
 * com o `sessionId` (não documentado):
 *
 *   true   registrada, e o processo dela existe
 *   false  registrada, mas o processo sumiu — fechou sem avisar
 *   null   o registro não diz (não está lá, ou o formato mudou)
 */
function sessaoViva(sessionId) {
  // Codex has no Claude-style PID registry. SessionEnd + age fallback only.
  if (core.CODEX) return null;
  if (!sessionId) return null;
  let nomes = [];
  try { nomes = fs.readdirSync(core.F.sessoesClaude).filter(n => /^\d+\.json$/.test(n)); }
  catch (_) { return null; }
  for (const n of nomes) {
    const s = core.lerJson(path.join(core.F.sessoesClaude, n), null);
    if (!s || s.sessionId !== sessionId || core.num(s.pid) === null) continue;
    try { process.kill(s.pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }   // EPERM: existe, só não é nosso
  }
  return null;
}

/*
 * D25 — órfão é o subagente cuja sessão morreu: o `SubagentStop` dele nunca
 * vai disparar, e ele ficaria "em voo" para sempre, levando parte de cada
 * trecho. Antes era quem passasse de 2h — mas agente de 12h trabalhando existe,
 * e era descartado vivo. Agora sai quando:
 *
 *   - a sessão dele terminou (`encerrada`, do hook SessionEnd), ou
 *   - o registro de sessões mostra o processo dela morto, ou
 *   - passou de `medidor.orfao_max_s` (48h) — o último recurso, para quando o
 *     registro não diz nada, ou para o agente que morreu sozinho numa sessão
 *     que segue aberta.
 *
 * Dali em diante ele sai da conta: se ainda viveu parte do trecho em curso,
 * o tempo dele deixa de dividir o Δ — o que infla o ritmo dos outros, o lado
 * seguro de errar.
 */
function limparOrfaos(cfg, encerrada) {
  const vivas = new Map();
  const viva = s => {
    if (!vivas.has(s)) vivas.set(s, encerrada && s === encerrada ? false : sessaoViva(s));
    return vivas.get(s);
  };
  let removidos = 0;
  for (const e of ler(VOO)) {
    const velho = Date.now() - t0De(e) > cfg.medidor.orfao_max_s * 1000;
    if (viva(e.sessao) === false || velho) {
      apagar(e.arquivo); removidos++;
    }
  }
  if (!removidos || emVoo().length || fechandoAgora()) return;
  // O céu esvaziou com a saída deles. O tempo de quem já tinha terminado
  // ainda vale como amostra: fecha o trecho. Sem ninguém, acaba ali.
  if (core.CODEX && encerrada) descartarTudo();
  else if (listar(FIM).length && fs.existsSync(core.F.marco)) fecharTrecho(cfg);
  else descartarTudo();
}

/* ------------------------------ começar ------------------------------ */

function inicio(ev, cfg) {
  const agora = Date.now();
  core.gravarJson(arq(VOO, ev.agent_id), {
    tipo: ev.agent_type || null, sessao: ev.session_id || null, t0_ms: agora,
    ...(core.CODEX ? { perfil: require('../lib/codex/perfil').perfilDoEvento(ev), origem: 'hook' } : {}),
  });

  /*
   * Sem marco, e ninguém fechando um trecho agora: abre um. É o caso do
   * primeiro subagente com o céu vazio — e também o de um marco perdido com
   * gente em voo, que assim se recupera sozinho: quem já rodava entra no
   * trecho com o tempo dele a partir daqui. Com alguém fechando, não abre:
   * quem fecha grava o marco seguinte.
   */
  if (fs.existsSync(core.F.marco) || fechandoAgora()) return;
  sonda.garantirFrescoHook(cfg.sonda.idade_s);
  const est = core.lerEstado();
  if (!est || core.num(est.pct5) === null) return;
  try {
    fs.writeFileSync(core.F.marco, JSON.stringify({
      t_ms: core.tMs(est), pct5: est.pct5, pct7: est.pct7,
      reset5: est.reset5, reset7: est.reset7,
      accountId: est.accountId, plano: est.plano,
    }, null, 2), { flag: 'wx' });
  } catch (_) { /* outro abriu primeiro: correto, segue */ }
}

/* ------------------------------ terminar ------------------------------ */

function fim(ev, cfg) {
  const meu = core.lerJson(arq(VOO, ev.agent_id), null);
  if (!meu) return;
  if (core.CODEX) {
    const { normalizarPerfil, perfilDoEvento } = require('../lib/codex/perfil');
    const inicial = normalizarPerfil(meu.perfil), final = perfilDoEvento(ev);
    // Missing stop metadata says nothing; newly supplied or changed metadata
    // cannot be attributed retroactively to the whole interval.
    meu.misto = Object.keys(final).some(k => final[k] !== null && final[k] !== inicial[k]);
    if (meu.misto) meu.perfil_final = final;
  }
  const t1 = Date.now();
  // A duração dele, para a admissão saber quanto um subagente costuma rodar.
  // Não depende de leitura nenhuma: o início e o fim são dos hooks.
  core.appendJsonl(core.F.agentes, {
    t: core.agora(), tipo: meu.tipo || null, sessao: meu.sessao || null,
    dur_s: Math.round((t1 - t0De(meu)) / 1000),
    ...(core.CODEX ? { perfil: meu.perfil || null, misto: !!meu.misto,
      origem: meu.origem || 'desconhecida' } : {}),
  });
  // Grava o fim antes de sair do céu: em nenhum instante ele some dos dois.
  core.gravarJson(arq(FIM, ev.agent_id), Object.assign({}, meu, { t1_ms: t1 }));
  apagar(arq(VOO, ev.agent_id));

  const ultimo = emVoo().length === 0;
  const marco = core.lerJson(core.F.marco, null);
  if (!marco) {
    // Sem marco não há trecho a fechar; se ninguém mais roda, limpa.
    if (ultimo && !fechandoAgora()) descartarTudo();
    return;
  }
  // Trecho curto e ainda há gente: o tempo dele entra no próximo marco.
  if (!ultimo && Date.now() - core.num(marco.t_ms) < cfg.medidor.trecho_s * 1000) return;
  fecharTrecho(cfg);
}

/*
 * Fecha o trecho em curso: lê a cota e grava o trecho — quanto ela subiu e
 * quantas horas de subagente rodaram nele.
 *
 * Quem fecha reivindica o trecho renomeando o marco: dois fechando juntos, só
 * um consegue, e o outro segue sem esperar. A leitura tem de ser PEDIDA
 * depois do fim do trecho (D41) — uma que já estava em curso não o inclui.
 */
function fecharTrecho(cfg) {
  // Mais de uma volta só se alguém terminou DURANTE a leitura e o céu esvaziou.
  for (let volta = 0; volta < 3; volta++) {
    const meu = core.F.marco + '.fechando.' + process.pid;
    try { fs.renameSync(core.F.marco, meu); } catch (_) { return; }
    // Renomear não muda a data do arquivo; sem isto o marco reivindicado
    // pareceria velho, e um subagente que começasse agora abriria outro.
    try { const t = new Date(); fs.utimesSync(meu, t, t); } catch (_) {}
    const marco = core.lerJson(meu, null);

    const tFim = Date.now();
    sonda.garantirFrescoHook(0, { depoisDeMs: tFim });
    const est = core.lerEstado();

    if (core.CODEX && marco && est && (marco.accountId !== est.accountId || marco.plano !== est.plano)) {
      apagar(meu); descartarTudo(); return;
    }
    if (!marco || !est || core.tMs(est) < tFim) {
      // Sem leitura nova. Ainda há gente: devolve o marco, e o próximo fecha
      // um trecho maior. Ninguém mais: o trecho acaba sem medida — um Δ de
      // número velho seria 0%, medição falsa que puxa o ritmo para baixo.
      if (emVoo().length) { try { fs.renameSync(meu, core.F.marco); } catch (_) { apagar(meu); } }
      else { apagar(meu); descartarTudo(); }
      return;
    }
    apagar(meu);
    registrarTrecho(marco, est, tFim);

    // Há trecho seguinte se ainda há gente — em voo, ou que terminou durante a
    // leitura e ficou para ele.
    if (emVoo().length || listar(FIM).length) {
      try {
        fs.writeFileSync(core.F.marco, JSON.stringify({
          t_ms: core.tMs(est), pct5: est.pct5, pct7: est.pct7,
          reset5: est.reset5, reset7: est.reset7,
          accountId: est.accountId, plano: est.plano,
        }, null, 2), { flag: 'wx' });
      } catch (_) {}
    }
    if (emVoo().length === 0 && listar(FIM).length > 0) continue;
    return;
  }
}

/*
 * Um trecho é uma amostra de ritmo: o Δ de cada janela e as horas de
 * subagente nele, por tipo. Cada janela vale pelo próprio reset: se a de 5h
 * virou no meio, o trecho ainda conta para a semanal (D48).
 */
function registrarTrecho(marco, est, tFim) {
  const ini = core.num(marco.t_ms);
  const fim = ler(FIM).filter(e => core.num(e.t1_ms) !== null && e.t1_ms <= tFim);
  const terminou = new Set(fim.map(e => e.id));
  // Quem mudou de pasta no meio da leitura aparece nas duas: vale o fim.
  const partes = fim.concat(ler(VOO).filter(e => !terminou.has(e.id) && t0De(e) < tFim));
  const tempo = e => Math.max(0, Math.min(e.t1_ms || tFim, tFim) - Math.max(t0De(e), ini)) / 1000;

  const porTipo = {};
  let seg = 0;
  for (const e of partes) {
    const s = tempo(e);
    if (!(s > 0)) continue;
    porTipo[e.tipo || 'desconhecido'] = (porTipo[e.tipo || 'desconhecido'] || 0) + s;
    seg += s;
  }
  // A janela virou (ou o número caiu) no meio do trecho: ali o Δ é reset, não gasto.
  const delta = (p, r) => (est[r] === marco[r] && core.num(est[p]) !== null &&
    core.num(marco[p]) !== null && est[p] >= marco[p] ? est[p] - marco[p] : null);
  const d5 = delta('pct5', 'reset5'), d7 = delta('pct7', 'reset7');

  let metadados = {};
  if (core.CODEX) {
    const { normalizarPerfil, chavePerfil } = require('../lib/codex/perfil');
    const perfis = new Map();
    for (const parte of partes) if (tempo(parte) > 0)
      perfis.set(chavePerfil(parte.perfil), normalizarPerfil(parte.perfil));
    const misto = perfis.size !== 1 || partes.some(p => tempo(p) > 0 && p.misto);
    metadados = { perfil: misto ? null : [...perfis.values()][0], misto,
      perfis: [...perfis.values()], atribuicao: 'coletiva_conta',
      sessoes_observadas: new Set(partes.map(p => p.sessao).filter(Boolean)).size,
      inclui_conversa_principal: true, interferencia_externa: 'nao_observavel', origem: 'hook' };
  }

  core.appendJsonl(core.F.trechos, {
    t: core.agora(), dur_s: Math.round((tFim - ini) / 1000),
    d5, d7, valido5: d5 !== null, valido7: d7 !== null,
    seg: Math.round(seg), por_tipo: porTipo, agentes: partes.length,
    ...metadados,
  });
  for (const e of fim) apagar(e.arquivo);
}

// Desligada (D2): não mede nem lê — mas não pode deixar nada para trás.
function descartar(ev) {
  apagar(arq(VOO, ev.agent_id)); apagar(arq(FIM, ev.agent_id));
  if (emVoo().length === 0 && !fechandoAgora()) descartarTudo();
}

/*
 * D30 — o vigia do workflow.
 *
 * Os outros dois avisos não cobrem o cenário que mais importa. O `aviso` pega
 * carona na mensagem do humano: durante um workflow ninguém está digitando,
 * então ele nunca roda. O `admissao` dispara uma vez, no lançamento — e um
 * workflow queima 10% em 15 minutos DEPOIS disso.
 *
 * `SubagentStop` é o único evento que bate ponto sozinho enquanto o trabalho
 * corre. E ele não viola o D3 (não acordar agente ocioso): se ele disparou, há
 * trabalho em curso por definição. É carona, não despertador.
 *
 * Fala por `systemMessage`, único canal que o SubagentStop aceita — ele não
 * suporta `additionalContext`. Nunca bloqueia.
 */
function vigiar(cfg, est, nowS) {
  if (!cfg.ligado || !cfg.vigia.ligado) return null;

  const j = core.lerJanelas(est, cfg, nowS, core.lerHistorico());
  const linhas = [];
  const chaves = [];
  if (core.CODEX) {
    const p = require('../lib/codex/economia').avaliarEconomia(j, cfg);
    if (p.nivel === 'reduzir' || p.nivel === 'concluir') {
      linhas.push(p.mensagem);
      chaves.push('economia:' + p.nivel + ':' + p.janela + ':' + p.reset);
    }
  }
  for (const [jan, rot, lim] of [[j.cinco, '5h', cfg.vigia.limiar_5h],
                                 [j.sete, 'semanal', cfg.vigia.limiar_7d]]) {
    if (jan.pctParaDecidir === null || jan.pctParaDecidir < lim) continue;
    const quando = jan.segAteReset !== null
      ? `, reseta em ${core.fmtDuracao(jan.segAteReset)}` : '';
    linhas.push(`${rot}: ${jan.pctParaDecidir.toFixed(0)}%${quando}`);
    // Assinatura por faixa de 5%: durante workflow a cota anda rápido, e cada
    // faixa nova merece ser dita uma vez.
    chaves.push(`${rot}:${jan.resetsAt}:${Math.floor(jan.pctParaDecidir / 5)}`);
  }
  if (!linhas.length) return null;

  const assinatura = chaves.join('|');
  const ult = core.lerJson(core.F.vigiaUltimo, null);
  if (ult && ult.assinatura === assinatura &&
      nowS - ult.t < cfg.vigia.repetir_min * 60) return null;
  core.gravarJson(core.F.vigiaUltimo, { t: nowS, assinatura });

  return '[cota] Subagente terminou. ' + linhas.join(' · ') +
         '. Antes da próxima onda, rode `cota cabe <n>` — e se não couber, ' +
         'pare limpo e diga o horário do reset em vez de reduzir por conta própria.';
}

try {
  const ev = lerStdin();
  if (ev && ev.hook_event_name === 'SessionEnd') {
    // A sessão fechou: os subagentes dela morreram com ela, com ou sem Stop.
    // O processo ainda existe enquanto este hook roda — por isso ela é dita
    // morta aqui, e não perguntada ao registro.
    limparOrfaos(core.lerConfig(), ev.session_id || null);
  } else if (ev && ev.agent_id) {
    const cfg = core.lerConfig();
    limparOrfaos(cfg);
    core.limparTmp();

    if (ev.hook_event_name === 'SubagentStart') {
      if (cfg.ligado) inicio(ev, cfg);
    } else if (ev.hook_event_name === 'SubagentStop') {
      if (cfg.ligado) fim(ev, cfg); else descartar(ev);
      // O vigia precisa de número vivo no meio do workflow, mas não pode
      // segurar o subagente esperando outra leitura: só aproveita a vez.
      if (cfg.ligado) sonda.garantirFrescoHook(cfg.sonda.vigia_s, { esperar: false });
      // Medir primeiro, vigiar depois: o aviso deve refletir o custo que
      // acabou de ser contabilizado, não o estado anterior a ele.
      const est = core.lerEstado();
      const msg = est && vigiar(cfg, est, core.agora());
      if (msg || core.CODEX) process.stdout.write(JSON.stringify(msg ? { systemMessage: msg } : {}));
    }
  }
} catch (e) {
  if (core.CODEX) {
    const erro = { t: core.agora(), evento: core.eventoHook?.hook_event_name || null,
      codigo: e.code || 'ERRO_HOOK', mensagem: String(e.message || e).slice(0, 500) };
    try { core.gravarJson(core.F.hookErro, erro); } catch (_) {}
    process.stderr.write('[cota-codex] Medição falhou: ' + erro.codigo + '\n');
  }
}
process.exit(0);
