---
name: cota-codex
description: Consulta limites de uso do Codex, horários de renovação e capacidade estimada para ondas de subagentes. Use para perguntas sobre saldo e antes de trabalho com vários subagentes.
---

# Cota do Codex

Consulte o saldo com o comando literal desta instalação:

```text
{{COTA}}
```

Acrescente `sondar` para atualizar agora, `audit` para diagnosticar ou `--json`
para obter dados estruturados. A consulta usa o app-server oficial e o login
existente; não inicia conversa com um modelo.

Antes de uma onda de subagentes, acrescente `cabe N`, substituindo N pela
quantidade pretendida. Use somente subagentes já autorizados pelo usuário e
pelas instruções da sessão. A ferramenta não concede autorização para delegar.

- `VAI`: a estimativa cabe na margem configurada.
- `APERTADO`: informe a restrição e ajuste o plano ao orçamento.
- `NÃO CABE`: explique a quantidade sugerida ou o horário de renovação.
- `SEM BASE`: ainda não há medição suficiente; não apresente a capacidade como conhecida.
- `SEM DADO`: rode `audit`; não interprete ausência como saldo livre.

Reavalie entre ondas. O custo é medição coletiva da conta, incluindo outras
conversas; não é atribuição exata por agente nem garantia de consumo futuro.
O `cabe` usa apenas as janelas gerais de 5h e 7d; limites adicionais estão em
`--json`. Créditos e resets disponíveis são informativos, nunca autorização
para comprar créditos ou consumir um reset.

Para uma estimativa específica, acrescente `--modelo X --esforco Y --velocidade Z`
com valores efetivamente conhecidos. Campo omitido é desconhecido, não o
padrão do Codex. Perfis não emprestam médias entre si; veja
`estimativa.perfisDisponiveis` em `--json`. Trechos mistos não servem para
atribuição por perfil. Confiança `baixa` ou `insuficiente` pede cautela, mesmo
se a conta aritmética disser `VAI`. O peso das amostras diminui com a idade.

Ao fazer trabalho prolongado, consulte a cota entre etapas mesmo sem
subagentes; não espere o hook avisar. Com pouco saldo e sem base, prefira
concluir o trecho atual e registrar pendências, sem abrir uma onda apenas
para calibrar. A calibração também consome o orçamento.

`--json` mantém formato JSON em falhas: `erro.codigo`, `erro.mensagem` e,
quando disponível, `erro.acao`. Exit code 1 é falha e 2 é desativado.
EPERM/EACCES no cache pode indicar restrição do sandbox: não anuncie sucesso
nem use leitura velha como se fosse atual.

Os hooks medem início/fim dos subagentes em sessões com orquestração local.
O aviso de admissão é contexto para o agente, não uma tela de confirmação.
Em orquestração na nuvem os hooks locais podem não rodar: nesse caso use as
consultas explicitamente e não prometa medição automática.
O `audit` diferencia configuração de eventos observados. `nao_observada`
significa que a coleta não foi comprovada; revise `/hooks` numa sessão local.
Mesmo registros de eventos não certificam a origem automática do disparo.

Percentuais exibidos são **consumidos**, não restantes. Leitura `expirada`
ou `desconhecida` não representa o saldo atual; `piso` é apenas o mínimo já
consumido. Se a ferramenta estiver `off`, respeite essa escolha.

Quando não houver orçamento, conclua o que estiver em andamento, registre o
que falta e informe o reset; não retome automaticamente sem pedido do usuário.
O painel de uso e `/status` no CLI são as referências para conferir divergências.
