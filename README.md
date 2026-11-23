# CI do Kit Universal de agentes

Este repositório guarda só o workflow que roda `node --test` (Linux e Windows) e o `ai-rulez` do Kit Universal de agentes no GitHub Actions. Não é a fonte do projeto e não recebe contribuições.

O workflow `ci` é disparado à mão com o commit a testar. Ele baixa o código do repositório do kit com um token de curta duração do GitHub App `kit-agentes-ci` e publica o resultado naquele commit como o check run `ci-publico`.

As branches `ci/...` são de execuções antigas, de quando o código era copiado para cá a cada execução.
