# Escolher uma skill do Kit

Comece pela pergunta que a frente precisa responder. As etapas abaixo são pontos de entrada. Uma mesma skill pode acompanhar um problema em várias etapas. Abra o SKILL.md escolhido e devolva a evidência indicada. A leitura do método respeita o escopo, as guardas e o destino de publicação autorizado pelo projeto.

## discover

- [setup-matt-pocock-skills](setup-matt-pocock-skills/SKILL.md) — Na primeira adoção, identifique onde ficam tracker, vocabulário de triagem e documentos de domínio. O resultado são convenções reutilizáveis.
- [triage](triage/SKILL.md) — Para issues ou PRs recebidos ainda sem triagem, classifique e confira o relato. Entregue um pedido que outra pessoa consiga executar.
- [grill-me](grill-me/SKILL.md) — Para testar uma ideia em conversa, produza decisões e perguntas em aberto. Use a entrevista sem registro em arquivos quando esse for o formato desejado.
- [grill-with-docs](grill-with-docs/SKILL.md) — Quando as decisões precisam ficar no repositório, combine a entrevista com modelagem do domínio e registre os termos e decisões relevantes.
- [grilling](grilling/SKILL.md) — Método usado pelas duas entrevistas. Investigue os fatos no código e leve à pessoa apenas as decisões que dependem dela.
- [domain-modeling](domain-modeling/SKILL.md) — Quando um termo tem significados conflitantes, confronte exemplos de uso e registre a definição acordada. Também serve à especificação de APIs e regras.
- [research](research/SKILL.md) — Quando uma decisão depende de um fato externo, devolva a resposta com fontes primárias, distinguindo observação e inferência.
- [prototype](prototype/SKILL.md) — Para uma escolha visual, abra [UI.md](prototype/UI.md) e mostre alternativas na página. Para uma dúvida sobre transições ou lógica, abra [LOGIC.md](prototype/LOGIC.md) e exercite os estados. Registre qual pergunta o protótipo resolveu.
- [diagnosing-bugs](diagnosing-bugs/SKILL.md) — Para uma falha ou regressão de desempenho, obtenha uma reprodução repetível, isole a causa e repita o cenário em validate.
- [improve-codebase-architecture](improve-codebase-architecture/SKILL.md) — Ao avaliar acoplamento, compare candidatos de mudança a partir de chamadas e testes reais. Entregue alternativas com seus custos.
- [wayfinder](wayfinder/SKILL.md) — Se o trabalho atravessa sessões e ainda há decisões interdependentes, monte um mapa das decisões. Quando elas estiverem resolvidas, leve a síntese a to-spec.
- [to-questionnaire](to-questionnaire/SKILL.md) — Se a resposta está com uma terceira pessoa, prepare perguntas dirigidas à lacuna e identifique como as respostas serão usadas.

## specify

- [to-spec](to-spec/SKILL.md) — Sintetize decisões já tomadas em comportamentos, limites e critérios de aceite. Para frontend, descreva interações e estados observáveis.
- [codebase-design](codebase-design/SKILL.md) — Para projetar um módulo ou contrato entre camadas, compare interfaces pelo esforço dos chamadores e pelos testes que sobreviveriam à troca da implementação.
- [documentation-and-adrs](documentation-and-adrs/SKILL.md) — Para uma decisão de arquitetura, alteração de contrato público ou documentação desatualizada, registre motivo e consequências e confira o texto contra o código.

## slice

- [to-tickets](to-tickets/SKILL.md) — Divida a especificação em entregas verticais com dependências explícitas. Cada ticket deve demonstrar um comportamento de ponta a ponta.

## implement

- [implement](implement/SKILL.md) — Para um recorte definido, implemente o comportamento e devolva evidência daquele ticket.
- [implement-spec](implement-spec/SKILL.md) — Para a especificação inteira com tickets dependentes, o orquestrador identifica os tickets liberados e integra as entregas conforme o plano do projeto. O escopo e as regras de PR em rascunho do Kit prevalecem sobre as instruções de merge e publicação da skill.
- [tdd](tdd/SKILL.md) — Para comportamento testável, conduza um ciclo vermelho e verde por vez na interface pública. No frontend, exercite uma ação que a pessoa consegue realizar.
- [writing-for-agents](writing-for-agents/SKILL.md) — Ao escrever skills, instruções ou guias para agentes, torne explícitos o gatilho, o caminho que deve ser lido e o critério de conclusão.

## validate

- Repita a reprodução de [diagnosing-bugs](diagnosing-bugs/SKILL.md) para confirmar a correção. Para um comportamento novo, confira o cenário público coberto por [tdd](tdd/SKILL.md).
- Em UI, percorra no navegador o cenário aceito, incluindo estados e largura estreita. Compare com a decisão de [prototype](prototype/SKILL.md) e registre o resultado.

## review

- [code-review](code-review/SKILL.md) — Compare o diff a uma base conhecida e à spec. Distinga quebra de convenção, requisito faltante e risco de regressão. Devolva achados verificáveis.

## ready

- [git-workflow-and-versioning](git-workflow-and-versioning/SKILL.md) — Desde a primeira mudança, confira branch, worktree e escopo do diff. Na entrega, verifique histórico, versão e changelog conforme o repositório.
- [pr](pr/SKILL.md) — Quando a entrega prevê PR, escreva o corpo com mudança de comportamento, evidência antes/depois e impacto do merge.
- [retro](retro/SKILL.md) — Quando pedirem uma retrospectiva ou houver atrito recorrente, identifique a causa no ambiente de trabalho e proponha a menor melhoria verificável.

## apoio

- [ask-matt](ask-matt/SKILL.md) — Se mais de um método parece servir, consulte o roteiro de Matt, abra a skill candidata e confirme que o resultado atende ao pedido.
- [handoff](handoff/SKILL.md) — Quando outra sessão, pessoa ou ferramenta vai assumir, produza uma passagem com objetivo, estado verificado, arquivos de referência e pendências.
- [teach](teach/SKILL.md) — Quando a intenção é aprender um conceito ao longo de sessões, prepare uma lição com exercícios e registre o progresso do aprendiz.
- [wait-what](wait-what/SKILL.md) — Se a explicação anterior não foi compreendida, reapresente-a no vocabulário do projeto, situando a decisão que está em discussão.
- [wizard](wizard/SKILL.md) — Quando só uma pessoa pode completar passos de configuração, prepare um roteiro interativo validável para essas ações.
