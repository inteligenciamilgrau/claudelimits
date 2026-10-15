'use strict';
/*
 * comando.js — a linha que o Claude Code e o Codex executam para cada hook.
 *
 * Uma só para os dois, para não haver um jeito de falhar por ferramenta.
 *
 * No Windows tem que ser `powershell ... -File run.ps1 <script>`: o executável
 * precisa ser um NOME SIMPLES no PATH e o caminho precisa ir como ARGUMENTO.
 * Os dois jeitos óbvios falham, cada um num shell — o cmd.exe lê o "/c" de
 * "/claude-limits" como switch dele, e o bash come as barras invertidas. E os
 * dois falham CALADOS. Esse formato funciona em cmd, bash e PowerShell, e é
 * legível: no Codex o usuário precisa ler o comando em /hooks para aprovar.
 *
 * Fora do Windows não existe esse problema: node e script, entre aspas.
 *
 * Função pura (plataforma e caminhos entram como parâmetro) para o teste
 * conferir o comando das três plataformas rodando numa só.
 */
const barras = p => p.replace(/\\/g, '/');

function comandoHook({ windows, dir, node, pathMod }, script, ...args) {
  const resto = args.length ? ' ' + args.join(' ') : '';
  if (windows) {
    // Caminho com espaço ("C:/Users/Ana Maria/...") vai entre aspas, senão o
    // -File recebe "C:/Users/Ana" e o hook falha CALADO. Aspas duplas valem
    // igual no cmd.exe, no bash e no PowerShell. Sem espaço, fica como sempre foi.
    const ps1 = barras(pathMod.join(dir, 'run.ps1'));
    return 'powershell -NoProfile -ExecutionPolicy Bypass -File ' +
           (/\s/.test(ps1) ? '"' + ps1 + '"' : ps1) + ' ' + script + resto;
  }
  return JSON.stringify(node) + ' ' + JSON.stringify(pathMod.join(dir, script)) + resto;
}

module.exports = { comandoHook, barras };
