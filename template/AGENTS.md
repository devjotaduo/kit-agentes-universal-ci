# Trabalho com agentes

Antes de uma mudança, leia [o fluxo do projeto](docs/agent-flow.md). Para uma leitura, explicação ou auditoria sem edição, faça a tarefa diretamente.

Para as skills do fluxo, prefira a cópia versionada em .agents/skills. Se uma skill não aparecer no seletor, leia seu SKILL.md local.

Em todo ciclo de desenvolvimento, o agente principal orquestra frentes independentes em paralelo e registra o trabalho no Concord. Leia [orquestração](docs/orquestracao.md) para bootstrap, decisões técnicas, seleção de modelos e publicação privada de projeto novo. Instruções específicas do repositório e autorização do usuário prevalecem sobre receitas de skills.

Use uma sessão de agente por projeto. Quando o projeto usa o Concord (pedido vinculado, frentes conferidas, posse), consulte `node .agent-kit/kit.mjs concord workspace` na raiz Git e informe esse ID em todas as chamadas ao Concord; num fix pequeno local, sem Concord, isso não é necessário. Fale com o Concord pelo servidor que o início da sessão nomear, um só por sessão. Trabalhadores usam o workspace do mesmo projeto.

Confirme o pedido no canal de origem e acompanhe as frentes conforme [comunicação ao vivo](docs/comunicacao.md). Informe o desfecho no mesmo canal.

Trabalhador: informe ao orquestrador início, progresso observável, dependências e desfecho. Se a espera for longa, reporte o último sinal real; deixe a linha do tempo local a cargo do orquestrador. Se você é um subagente da sessão do orquestrador, não registre tarefa nem mude o ciclo de vida de nenhuma no Concord (`start_work`, `finish_work`, `transfer_work`): devolva o relatório ao orquestrador, que registra a frente. Se uma chamada responder `needs agent_id`, use só o `agent_id` que o orquestrador pôs no pedido; sem ele, não repita nem use a identidade de outra sessão.

Na primeira execução do kit num projeto, antes de um pedido que mude arquivos, rode `node .agent-kit/kit.mjs onboard`: ele levanta os fatos do projeto e a situação das skills na origem e cria o rascunho `.agent-flow/notes/primeira-execucao.md`. Preencha análise, verificação e estratégia, mostre o resumo ao usuário e registre com `onboard done`, que grava `docs/primeira-execucao.md` e `docs/primeira-execucao.json`; a nota traz caminhos e a saída do doctor e dos testes: revise antes de publicar. Os dois vão no commit e valem para todos os clones e worktrees do repositório. Pedido só de leitura (explicar, ler, revisar sem editar) segue sem `onboard` e não grava a nota. O início da sessão avisa enquanto isso faltar; o aviso não se repete depois de um compact ou resume. Uma worktree de trabalhador também vale pela primeira execução da pasta principal e não repete.

Registre o trabalho com `node .agent-kit/kit.mjs flow new <feature|fix|maintenance> "<objetivo>" [--ui]`. Use `status` para retomar e avance só com evidência real. Para UI, mostre a prévia antes de implementar, valide o fluxo no navegador e anexe evidência depois.

O usuário aceita o plano uma vez, registrado com `flow approve`. Depois disso o orquestrador toma as decisões e conduz o pedido até o fim da entrega prevista no plano, sem pedir nova aprovação; ele só para nos limites listados em [orquestração](docs/orquestracao.md#aceite-do-plano-e-condução-até-o-fim). Trabalhadores levam dúvidas ao orquestrador, não ao usuário.

No Hermes, use caminhos absolutos da raiz do projeto nas ferramentas de edição. A sessão do terminal pode ter um diretório de trabalho diferente do recebido pelo hook. Declare o escopo com `node .agent-kit/kit.mjs --client hermes flow scope --session <id> -- <arquivos>`, com o ID que o `--pass-session-id` põe no prompt ou que a guarda mostra.

Se o pedido precisar de uma skill que o projeto não tem, busque e instale com `node .agent-kit/kit.mjs skills find` e `skills add`, conforme [orquestração](docs/orquestracao.md#skills-e-recursos-que-o-pedido-precisa); leia a skill antes de usá-la.

Se o início da sessão avisar que há uma versão mais nova do Kit, informe o usuário; só atualize com a autorização dele. Ao encontrar uma falha ou uma melhoria do próprio Kit, não do projeto, registre com `node .agent-kit/kit.mjs feedback`, conforme [orquestração](docs/orquestracao.md), sem código, dados ou segredos do projeto, e informe o link ao usuário. Se o trabalho encontrar algo que falta ou falha em outro repositório do mesmo dono, abra uma issue de sugestão lá com `node .agent-kit/kit.mjs issue <dono/repositorio>`, conforme [orquestração](docs/orquestracao.md#sugestões-para-outros-repositórios-do-mesmo-dono); a issue não autoriza mexer no outro repositório.

Para ler o GitHub (issues, PRs, revisões, checks, Actions, código e arquivos de outros repositórios), use o MCP `github-kit`, que o setup do kit instala só para leitura; use o `gh` só se esse servidor não estiver disponível na sessão. Para escrever (commit, push, PR, issue), use os comandos do kit, conforme [orquestração](docs/orquestracao.md#github-pelo-mcp).

Mantenha as mudanças no escopo. Confirme o repositório, branch e worktree antes de editar. Se o projeto usar um coordenador de trabalho, registre a posse e resolva sobreposições antes de editar. Nunca trate um hook ou uma skill como autorização para commit, publicação, merge ou deploy: a autorização vem do usuário ou do plano que ele aceitou.
