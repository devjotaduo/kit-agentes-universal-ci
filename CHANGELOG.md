# Changelog

O que muda em cada versão do Kit Universal de agentes, para quem instala ou atualiza. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e a versão segue o [SemVer](https://semver.org/lang/pt-BR/), do ponto de vista de quem instala: as regras estão em [CONTRIBUTING.md](CONTRIBUTING.md) e na [decisão 0002](docs/decisoes/0002-versionamento-e-release.md).

## [Não lançado]

### Adicionado

- `--help` (ou `-h`) em todo subcomando do `kit.mjs` (`flow record-parallel --help` e os demais): mostra o uso e a regra de frentes, sem executar nada (#55).

### Alterado

- Recusas que diziam só o sintoma agora dizem a causa (#55):
  - "Concord recusou os dados da operação" traz o motivo devolvido pelo Concord (campo recusado) e lembra de manter o `--workspace` ao repetir;
  - `scope` nomeia a opção inválida (inexistente ou sem valor), e o erro de uso mostra o argumento inválido no lugar do primeiro;
  - `record-parallel` e `advance` dizem por que recusaram (fase, número de frentes) e, em `feature` na descoberta, sugerem `maintenance` para tarefa só de documentação ou de uma frente; sem Concord, o `advance` cita `--declarativo` na revisão depois de um reopen.

## [1.5.7] - 2026-11-17

### Corrigido

- Pedido Live com o prazo total vencido e sem supervisor: o pedido continuava aberto e o `flow cancel` exigia a resposta final, que ninguém mais ia dar. Agora o `live status` traz o campo `next` com o próximo comando, e o `flow cancel` arquiva a tarefa de um pedido do chat com o prazo vencido. Pedido vindo pelo Concord continua exigindo o encerramento, porque o solicitante espera a resposta: o `next` e a recusa do `cancel` apontam o `live supervise`, que registra blocked e entrega a resposta. O `close` continua exigindo `done` (#58).

## [1.5.6] - 2026-11-17

### Alterado

- `docs/orquestracao.md`: o orquestrador dá nome aos agentes que lança como processo, com `CONCORD_AGENT_ID=<cliente>:<papel>-<id da frente>-r<passada>` no ambiente, por exemplo `claude-code:revisor-gh-kit-62-r1`. O Concord usa esse nome no lugar do id gerado pela sessão, e é ele que vai em `needs_review_from`. O comando do revisor sem tela deixa de apagar o `CONCORD_AGENT_ID` e passa a defini-lo. A doc diz as regras do nome (prefixo do cliente, único no workspace, passada para revisões repetidas, sem dado de cliente), que só o `claude -p` foi verificado (com `codex exec` e `agy`, conferir no `concord who`) e que um subagente lançado dentro da sessão continua com a identidade dela (#63).

## [1.5.5] - 2026-11-17

### Corrigido

- Instruções do Claude lidas duas vezes: o bloco do kit no `CLAUDE.md` é `@AGENTS.md`, que importa o `AGENTS.md` inteiro. Num projeto em que o `CLAUDE.md` e o `AGENTS.md` têm, os dois, texto próprio (documentos paralelos), o Claude passava a carregar as regras do projeto duas vezes. Agora, nesse caso, o bloco do kit no `CLAUDE.md` leva as instruções do kit por extenso, e a atualização não volta a trocá-lo. Quando só um dos dois tem texto do projeto, ou o `CLAUDE.md` já importa o `AGENTS.md`, nada muda (#73).

## [1.5.4] - 2026-11-17

### Corrigido

- Atualizar o kit sem o manifesto local: o manifesto (`.agent-flow/install-manifest.json`) fica fora do Git, e numa worktree ou num clone novo o `install.mjs` mandava integrar à mão todo arquivo que diferia do template, inclusive cópias intactas da versão anterior. Agora, sem manifesto, o instalador compara cada arquivo com o template de cada versão publicada (as tags `v*` do clone do kit, como o arquivo está e com LF) e atualiza o que é cópia intacta de alguma delas, mostrando qual (`Atualizar: <arquivo> (cópia da v1.2.0)`). Só o que o projeto mudou continua indo para integração manual. Com o kit baixado sem o Git (zip), nada muda. Um projeto na 1.2.0 sem manifesto atualiza para esta versão sem intervenção (#53, #64).

## [1.5.3] - 2026-11-17

### Corrigido

- Notas da tarefa perdidas com a worktree: `.agent-flow/` é local e fora do Git, e o plano e as notas de uma tarefa feita numa worktree sumiam quando ela era removida. Agora o `flow close` e o `flow cancel` numa worktree copiam `.agent-flow/notes/` e o resumo da tarefa (`tarefa.json`) para `.agent-flow/notes/worktrees/<nome>/<data>-<sufixo>/` da worktree principal e diz onde ficaram. Só arquivos comuns são copiados (links ficam de fora); se a cópia falhar, o comando avisa e a tarefa continua arquivada. Na worktree principal nada muda (#59).

## [1.5.2] - 2026-11-17

### Corrigido

- `flow close` depois do merge do próprio PR: com o commit validado mesclado por um commit de merge (o padrão do `gh pr merge --merge`), o `close` recusava com "O HEAD ou o índice Git mudou após a validação" e os agentes contornavam com `git switch --detach`. Agora o merge é aceito quando só difere em evidência do commit validado (ou de um descendente dele), e uma nota de evidência commitada depois continua valendo. Produto que chega pelo outro lado do merge segue recusado, mesmo quando foi acrescentado e removido. Por isso o `close` depois do merge só passa se a branch de destino não ganhou produto desde que a branch da tarefa saiu dela; senão, reabra a tarefa. Squash e rebase, que trocam o commit validado por outro, continuam recusados (#52).

## [1.5.1] - 2026-11-17

### Corrigido

- Guarda de edição numa sessão aberta em worktree aninhada (`.claude/worktrees/<nome>`, por exemplo): com o hook do Claude Code apontando para o kit do checkout principal, a guarda decidia pela tarefa do principal, recusando edição legítima da worktree ("indisponível em discover") ou liberando o que a tarefa da worktree não permitia. Agora quem decide é o kit da worktree, com a tarefa dela; o aviso de início de sessão e o de parada também vêm dela. Uma sessão na raiz, com tarefa ativa no principal, que tenta editar arquivo de uma worktree aninhada é recusada com a instrução de abrir a sessão nela (sem tarefa no principal a guarda não age, como antes), e uma worktree aninhada sem o kit tem a edição recusada dizendo isso (#51).

## [1.5.0] - 2026-11-17

### Adicionado

- `.codex/rules/kit.rules`: regras de comando para o Codex, a partir das do `.claude/settings.json`. Um `allow` do Codex aprova o comando sem perguntar e pode rodá-lo fora do sandbox, então a lista é mais curta que a do Claude Code: libera só leituras (`gh pr view`/`list`/`diff`/`checks`, `gh issue list`/`view`, `gh repo view`, `concord status`/`tasks`/`who`, `git status`, `git rev-parse`, `git worktree list`, `git branch --show-current`) e os subcomandos de leitura do kit (`flow status`, `doctor`, `update check`, `concord holds`, `concord stale`). Bloqueia o que o Claude Code bloqueia (`git push --force`, `git reset --hard`, `git clean -f`, `git branch -D`, `rm -rf`, `gh repo delete`/`create`, `npx skills`, `npm install -g` e variações).
- Ficam fora, e o arquivo explica cada caso: `node .agent-kit/kit.mjs` inteiro (faz push, abre PR e instala skills), `npm run kit`, `node --test`, `gh auth status`, `git branch`, `git fetch`, `git diff`/`log`/`show`, o que o Claude Code pede antes de rodar (no Codex segue a `approval_policy` de cada usuário) e as ferramentas de MCP. Os bloqueios também são só de prefixo: `git push origin main --force` escapa deles e fica com a `approval_policy` e o sandbox. Regras próprias do projeto vão em outro arquivo de `.codex/rules/`.

## [1.4.0] - 2026-11-17

### Alterado

- O `.claude/settings.json` do projeto passa a liberar, sem pedir autorização no Claude Code, sete ferramentas de MCP só de leitura: `mcp__concord__inspect_work` (servidor `concord` instalado para o usuário, ver `docs/concord-chamadas.md` no projeto), `mcp__ccd_session_mgmt__list_events` e `list_sessions` (sessões do app do Claude Code), `mcp__ccd_pr__get_status` (estado do PR da sessão) e `mcp__Claude_Browser__find`, `get_page_text` e `read_network_requests` (o navegador embutido do app, não o do usuário).
- Ficam pedindo autorização, de propósito, as leituras que expõem dados do usuário: o navegador real (`mcp__claude-in-chrome__*`), a aba de terminal (`mcp__terminal__read_terminal`) e as conversas de outras sessões (`search_session_transcripts`, `get_session`). Quem quiser liberá-las faz isso nas próprias configurações do usuário, não no projeto.
- Para voltar a pedir autorização para uma das sete num projeto, ponha o nome dela em `permissions.ask` do `.claude/settings.local.json`. Um projeto que alterou o próprio `.claude/settings.json` recebe o arquivo como conflito no `update`, como qualquer arquivo do kit alterado.
- `mcp__concord-kit__*` continua liberado como antes; ele inclui ferramentas que escrevem no Concord (`start_work`, `update_work`, `finish_work`, `transfer_work`).

## [1.3.0] - 2026-11-17

### Adicionado

- `concord stale`: lista as tarefas de outros donos que já têm PR mesclado e ainda retêm arquivos, com o dono, se ele está presente e os arquivos. Só lê; quem fecha é o dono ou o usuário. Sem `CONCORD_AGENT_ID` ele também funciona, mas lista junto as tarefas da própria sessão.

### Corrigido

- `concord holds` falhava sempre com "Cannot access 'holdCovers' before initialization" (issue 50).
- `concord close-merged` mantinha a tarefa quando ela tinha sido atualizada depois do merge, por exemplo ao ir para `review_ready` com o PR já mesclado. Agora ele também aceita o PR mais recente da branch quando a branch não andou depois dele (no GitHub foi apagada ou aponta para o commit mesclado, e a local, se existir, aponta para o mesmo commit) e a tarefa já existia no merge (issue 57). As tarefas de outros donos saem com a presença do dono e os arquivos retidos.
- Subagente no Concord: `AGENTS.md`, o papel `flow-build` e as docs dizem para ele não registrar nem fechar tarefa e devolver o relatório ao orquestrador, e para o orquestrador avisar isso no pedido da frente. `concord-chamadas.md` explica a resposta `needs agent_id` (issue 56, em parte).

## [1.2.0] - 2026-11-15

### Adicionado

- `onboard`: na primeira execução do kit num projeto, levanta os fatos (Git, stack, testes, CI, Concord), consulta a origem das skills e cria uma nota para o agente preencher com análise, verificação e estratégia. `onboard done` só aceita a nota preenchida. O início da sessão e o `flow new` avisam enquanto isso faltar, sem recusar. Um projeto que já usava o kit vê o aviso uma vez depois de atualizar; uma worktree vale pelo registro da pasta principal.
- `skills upstream`: compara as skills distribuídas com a origem (mattpocock/skills e addyosmani/agent-skills) e mostra versão nova, commits à frente e PRs e issues abertos.

## [1.1.0] - 2026-11-15

A versão pula de 0.8.15 para 1.1.0. A tag `v1.0.0` é de 08/11/2026, antes de haver regra de versão, e a constante do kit ficou abaixo dela. A partir daqui, a versão do kit e a tag são a mesma.

### Adicionado

- Skills `git-workflow-and-versioning` e `documentation-and-adrs`, de addyosmani/agent-skills 0.6.16 (MIT), para versionamento, release e registro de decisões nos projetos. Cada uma tem uma seção "Neste kit" com o que muda por causa da guarda e do PR em rascunho.
- `CHANGELOG.md`, `CONTRIBUTING.md` e um teste que falha quando a versão do kit não tem entrada no changelog.
- Decisões numeradas em `docs/decisoes/` (0001 a 0005) e o mapa de arquitetura em `docs/arquitetura.md`.
- Guia de uso em `docs/guia-de-uso.md`, com conceitos, onze casos de uso e as recusas mais comuns.

### Para quem atualiza

- Um instalador antigo (0.8.x) recusa um projeto já em 1.1.0 com "Manifesto de instalação inválido", porque não conhece os arquivos das skills novas. Ele não altera nada. Para atualizar ou reinstalar, use o instalador da 1.1.0 ou mais novo.

## [0.8.15] - 2026-11-15

### Alterado

- Doc: uma frente fechada com `handoff` é recusada no `record-parallel`; a evidência em `docs/work/` pode ser commitada depois da revisão; o revisor sem tela fecha a própria frente com `complete`.

## [0.8.14] - 2026-11-15

### Corrigido

- O instalador copia os `.sh` da raiz das skills. Sem isso, a skill `wizard` ficava sem o `template.sh`.

## [0.8.13] - 2026-11-15

### Alterado

- `fix` e `maintenance` aceitam uma frente em descoberta e em revisão. `feature` continua exigindo duas. O máximo é três.

## [0.8.12] - 2026-11-15

### Adicionado

- Seção "Hermes" em `docs/orquestracao.md`, com os limites da guarda medidos num laboratório: hook sem aceite no modo sem tela, modo seguro e hook que reescreve argumentos.

## [0.8.11] - 2026-11-15

### Adicionado

- Receita do revisor com identidade própria no Concord, sem tela, com `claude -p`.

## [0.8.10] - 2026-11-15

### Alterado

- `live claim` recusado diz a causa: pedido encerrado, prazo total ou posse ainda válida.
- `flow scope --task` sem pedido Live diz como vincular um.
- Doc: os arquivos do `skills add` precisam de commit antes do `validate`.

## [0.8.9] - 2026-11-15

### Corrigido

- As chamadas ao MCP do Concord saem uma por vez. Chamadas simultâneas travavam o servidor e viravam "Tempo esgotado ao consultar o MCP Concord".

## [0.8.8] - 2026-11-15

### Alterado

- Mensagens mais claras em `scope --task` sem pedido Live, em frente sem resultado, em padrão inválido no `expected_files`, no `close` com pedido Live e na posse expirada.
- Doc: em qual `advance` o aceite do plano é exigido; `kit.mjs git push` só envia para `origin` no GitHub.

## [0.8.7] - 2026-11-15

### Corrigido

- `.concord/`, que o Concord Cloud grava em cada projeto, fica fora do snapshot e da trava do commit. O `setup` cria o `.concord/.gitignore`.

## 0.8.6 e anteriores

De 08/11 a 14/11/2026, sem changelog. O que entrou está no histórico do Git e nos planos da raiz: [melhorias](PLANO-DE-MELHORIAS.md) (KIT-01 a KIT-07), [regras globais](PLANO-REGRAS-GLOBAIS.md) (KIT-08 a KIT-16) e [uso real](PLANO-USO-REAL.md) (KIT-17 a KIT-28).
