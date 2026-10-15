# Estado final da adaptação Codex — 15/10/2026

Implementação e revisão concluídas.

- Consulta real, cache, JSON, erros com exit codes, diagnóstico e instalador.
- Separação Claude/Codex e isolamento de conta/plano.
- Perfis exatos de modelo/esforço/velocidade; desconhecidos não herdam dados.
- Exclusão de trechos mistos e troca detectada de perfil no término do agente.
- Ponderação por idade, confiança heurística, variabilidade e consumo coletivo.
- Documentação e skill instalada atualizadas.

## Validação

- 14 testes ponta a ponta do Codex passaram.
- 6 testes de erros reais de filesystem/RPC passaram.
- 7 testes de estimativa passaram.
- Suíte completa do Claude passou; git diff --check passou.
- Consulta e diagnóstico reais passaram no Windows.
- Um subagente curto, sem histórico herdado, disparou automaticamente os hooks
  SubagentStart e SubagentStop. Foram gravados duração e trecho no estado real.
  Não foram invocados hooks manualmente para produzir essa evidência.

## Limites e próximos cuidados

Uma amostra de quatro segundos NÃO calibra a estimativa. O perfil observado
trouxe modelo, mas esforço e velocidade ficaram desconhecidos. A amostra
teve delta de 5h inválido e semanal de 1 ponto; inclui atividade da conversa
principal e efeitos de arredondamento/atualização do saldo. Não atribuir esse
ponto ao subagente individualmente.

A primeira tentativa, antes desta retomada, não havia registrado eventos.
A validação bem-sucedida atual não garante hooks em todas as superfícies.
Linux/macOS e orquestração na nuvem permanecem fora da validação prática.

Consultar o saldo antes de nova rodada e entre etapas. Preferir trabalho
sequencial e testes locais. Não iniciar ondas para obter amostras quando o
saldo estiver baixo; não comprar créditos nem consumir resets automaticamente.
