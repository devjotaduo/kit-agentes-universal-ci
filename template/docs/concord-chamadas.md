# Chamadas ao Concord

Um exemplo copiável de cada chamada, com os campos que o Concord exige. Os erros mais comuns nas sessões que usaram o kit foram campo obrigatório ausente, caminho absoluto em `expected_files` e versão desatualizada.

Antes de começar:

- **Carregue o esquema da ferramenta antes da primeira chamada.** No Claude Code as ferramentas do Concord chegam adiadas: carregue com `ToolSearch` (`select:mcp__concord__start_work,mcp__concord__inspect_work,mcp__concord__update_work,mcp__concord__finish_work,mcp__concord__transfer_work`) e só então chame. No Codex, leia a descrição da ferramenta na lista do MCP.
- **Use a sua identidade.** `agent_id` é o que o início da sessão ou o adaptador informam; nunca a de outra sessão.
- **Use o workspace do projeto.** `node .agent-kit/kit.mjs concord workspace` mostra o `workspace_id` e o grava em `.agent-flow/concord-workspace.json`; o início da sessão repete o valor gravado. Nunca use `general` nem o workspace de outra tarefa.
- **Caminhos relativos à raiz do repositório**, com `/`: `src/app.ts`, não `C:\...\src\app.ts` nem `~/...`.
- **Leia a versão na hora.** `finish_work` e `transfer_work` exigem `expected_version`: pegue o `version` do `inspect_work` com `task_id` feito logo antes, ou o da última resposta da própria tarefa. Versão antiga é recusada.

## Começar

```jsonc
// start_work
{ "agent_id": "<sua identidade>", "task_id": "gh-<repo>-<n>", "title": "Resumo curto",
  "kind": "claude-code", "model": "<modelo>", "branch": "fix/assunto",
  "expected_files": ["src/app.ts", "test/app.test.ts"], "parent_task_id": "<tarefa do orquestrador, se houver>" }
```

Se outra tarefa retém um arquivo, a chamada é recusada e diz quem. Veja [posse que não pode ser assumida](orquestracao.md).

## Consultar

```jsonc
// inspect_work: uma tarefa (versão, dono, arquivos)
{ "task_id": "gh-<repo>-<n>" }
// inspect_work: um agente (presença, promptable, caixa de entrada)
{ "agent_id": "<id do agente>" }
// inspect_work: um recibo de mensagem
{ "message_id": "<id>" }
```

Passe no máximo um seletor. Sem nenhum, a resposta é o workspace inteiro, longa e raramente necessária.

## Quando a chamada responde `needs agent_id`

O servidor não sabe quem está chamando. Acontece no Codex, onde quem informa o `agent_id` é o modelo: um subagente não recebe o id do início da sessão, e uma sessão cujos hooks não rodaram também não. No Claude Code o servidor preenche o id sozinho, ignora o `agent_id` informado, e o subagente age como o mesmo agente do pai. Não invente um id e não use o de outra sessão. Subagente: use o `agent_id` que o orquestrador pôs no pedido, que é o da sessão dele, só para ler e para registrar (`operation: "record"`) na tarefa da sua frente; se o pedido não trouxe nenhum, pare de chamar e devolva o relatório ao orquestrador, que registra a frente. Veja [orquestração](orquestracao.md). Sessão principal: use o `agent_id` que o início da sessão informou; se não informou nenhum, rode `node .agent-kit/kit.mjs doctor` e siga o que ele disser sobre os hooks e os servidores do Concord. Com dois servidores na sessão (`concord` do usuário e `concord-kit` do projeto), use só o que o início da sessão e o `doctor` nomeiam: o do usuário, quando existe; senão o `concord-kit`. No Codex é o servidor `concord`. Se o `concord-kit` cair com `CONNECTION_CLOSED`, rode o `doctor`: ele avisa quando o `.mcp.json` abre o servidor com um executável diferente do dos hooks do kit, como `node` fora do PATH numa sessão por ssh.

## Registrar e conversar

```jsonc
// update_work: registro na tarefa (kind: intent|progress|assumption|decision|question|answer|blocker|finding)
{ "agent_id": "<sua identidade>", "operation": "record", "task_id": "gh-<repo>-<n>",
  "kind": "decision", "content": "O que foi decidido e por quê." }
// update_work: pedir algo a outro agente
{ "agent_id": "<sua identidade>", "operation": "prompt", "to_agent_id": "<id>",
  "task_id": "gh-<repo>-<n>", "content": "Pedido.", "idempotency_key": "<chave nova>" }
// update_work: responder
{ "agent_id": "<sua identidade>", "operation": "reply", "reply_to_message_id": "<id>",
  "content": "Resposta.", "idempotency_key": "<chave nova>" }
```

`operation` só aceita `record`, `prompt` e `reply`. Repita a mesma `idempotency_key` só para reenviar uma mensagem cuja resposta você não recebeu.

## Entregar

```jsonc
// finish_work
{ "agent_id": "<sua identidade>", "task_id": "gh-<repo>-<n>", "expected_version": 3,
  "outcome": "review_ready", "what_changed": "Resumo do que mudou.",
  "changed_files": ["src/app.ts"], "tests_run": ["node --test: 12/12"],
  "known_risks": ["..."], "needs_review_from": ["<id do revisor, diferente do autor>"] }
```

`outcome`: `review_ready` para revisão, `complete` ou `closed` depois do merge, `handoff` para só registrar evidência. Uma frente registrada em `record-parallel` precisa terminar com `review_ready` ou `complete`; com `handoff` ela é recusada. Com `reported_outcome`, inclua em `provenance` um item `{ "field": "reported_outcome", "source": "<CI, PR ou revisor>" }`.

## Passar adiante

```jsonc
// transfer_work (action: assign|accept|decline|release|reassign|offer|reopen)
{ "agent_id": "<sua identidade>", "task_id": "gh-<repo>-<n>", "expected_version": 3,
  "action": "offer", "to_agent_id": "<id>", "what_changed": "O que já está feito." }
```

`to_agent_id` é obrigatório em `assign`, `reassign` e `offer`; `reason` em `reassign`, `reopen` e ao recusar uma oferta. Só o dono muda o ciclo de vida da tarefa: não libere a posse de outro agente.
