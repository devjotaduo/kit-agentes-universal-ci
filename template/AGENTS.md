# Trabalho com agentes

Antes de uma mudança, leia [o fluxo do projeto](docs/agent-flow.md). Para uma leitura, explicação ou auditoria sem edição, faça a tarefa diretamente.

Para as skills do fluxo, prefira a cópia versionada em .agents/skills. Se uma skill não aparecer no seletor, leia seu SKILL.md local.

Em todo ciclo de desenvolvimento, o agente principal orquestra frentes independentes em paralelo e registra o trabalho no Concord. Leia [orquestração](docs/orquestracao.md) para bootstrap, decisões técnicas, seleção de modelos e publicação privada de projeto novo. Instruções específicas do repositório e autorização do usuário prevalecem sobre receitas de skills.

Use uma sessão de agente por projeto. Consulte `node .agent-kit/kit.mjs concord workspace` na raiz Git e informe esse ID em todas as chamadas ao Concord. Quando o cliente disponibilizar o servidor `concord-kit`, use-o para falar com o Concord do projeto. Trabalhadores usam o workspace do mesmo projeto.

Confirme o pedido no canal de origem e acompanhe as frentes conforme [comunicação ao vivo](docs/comunicacao.md). Informe o desfecho no mesmo canal.

Trabalhador: informe ao orquestrador início, progresso observável, dependências e desfecho. Se a espera for longa, reporte o último sinal real; deixe a linha do tempo local a cargo do orquestrador.

Registre o trabalho com `node .agent-kit/kit.mjs flow new <feature|fix|maintenance> "<objetivo>" [--ui]`. Use `status` para retomar e avance só com evidência real. Para UI, mostre a prévia antes de implementar, valide o fluxo no navegador e anexe evidência depois.

O usuário aceita o plano uma vez, registrado com `flow approve`. Depois disso o orquestrador toma as decisões e conduz o pedido até o fim da entrega prevista no plano, sem pedir nova aprovação; ele só para nos limites listados em [orquestração](docs/orquestracao.md#aceite-do-plano-e-condução-até-o-fim). Trabalhadores levam dúvidas ao orquestrador, não ao usuário.

No Hermes, use caminhos absolutos da raiz do projeto nas ferramentas de edição. A sessão do terminal pode ter um diretório de trabalho diferente do recebido pelo hook.

Se o pedido precisar de uma skill que o projeto não tem, busque e instale com `node .agent-kit/kit.mjs skills find` e `skills add`, conforme [orquestração](docs/orquestracao.md#skills-e-recursos-que-o-pedido-precisa); leia a skill antes de usá-la.

Se o início da sessão avisar que há uma versão mais nova do Kit, informe o usuário; só atualize com a autorização dele. Ao encontrar uma falha ou uma melhoria do próprio Kit, não do projeto, registre com `node .agent-kit/kit.mjs feedback`, conforme [orquestração](docs/orquestracao.md), sem código, dados ou segredos do projeto, e informe o link ao usuário. Se o trabalho encontrar algo que falta ou falha em outro repositório do mesmo dono, abra uma issue de sugestão lá com `node .agent-kit/kit.mjs issue <dono/repositorio>`, conforme [orquestração](docs/orquestracao.md#sugestões-para-outros-repositórios-do-mesmo-dono); a issue não autoriza mexer no outro repositório.

Mantenha as mudanças no escopo. Confirme o repositório, branch e worktree antes de editar. Se o projeto usar um coordenador de trabalho, registre a posse e resolva sobreposições antes de editar. Nunca trate um hook ou uma skill como autorização para commit, publicação, merge ou deploy: a autorização vem do usuário ou do plano que ele aceitou.
