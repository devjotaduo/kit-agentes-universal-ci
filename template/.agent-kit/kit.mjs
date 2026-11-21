import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER as githubServer, launcher as githubLauncher } from '../.codex/hooks/github-mcp.mjs';
import { requiredKitUpdate } from '../.codex/hooks/update.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = (name) => fileURLToPath(new URL('../.codex/hooks/' + name + '.mjs', import.meta.url));
const clients = ['portable', 'codex', 'claude', 'hermes', 'antigravity'];
const commands = ['flow', 'live', 'concord', 'bootstrap', 'route-model', 'doctor', 'update', 'feedback', 'skills', 'git', 'worktree', 'issue', 'panel', 'onboard', 'github-mcp'];
// Uso de cada subcomando para `<comando> <subcomando> --help`; nada é executado.
const ajuda = {
  'flow new': 'flow new <feature|fix|maintenance> "<objetivo>" [--ui]. Tarefa só de documentação ou de uma frente: use maintenance (1 frente).',
  'flow status': 'flow status: mostra a tarefa ativa e o próximo passo.',
  'flow review-reference': 'flow review-reference: mostra a referência do conteúdo validado, durante review.',
  'flow link-live': 'flow link-live <pedido> [--checked "<verificação de posse e arquivos>"].',
  'flow record-parallel': 'flow record-parallel <discover|review> <tarefa-pai> <frente-1> [frente-2] [frente-3]'
    + ' [--workspace <workspace-Concord> | --declarativo "<motivo>"]. feature exige 2 frentes; fix e maintenance, 1.',
  'flow approve': 'flow approve <plano.md> "<onde e como o usuário aceitou>".',
  'flow scope': 'flow scope [--session <sessão>] [--task <tarefa-Concord>] [--workspace <workspace>] [--unclaimed "<motivo>"] -- <arquivos> (só em implement).',
  'flow publish-selection': 'flow publish-selection -- <arquivos> (antes de avançar validate).',
  'flow advance': 'flow advance <etapa> <evidência.md> (dois arquivos em discover e validate com --ui).',
  'flow reopen': 'flow reopen "<motivo>": volta a etapa depois da implementação.',
  'flow check': 'flow check: confere a entrega antes de close.',
  'flow close': 'flow close: encerra a tarefa depois de check.',
  'flow cancel': 'flow cancel: arquiva a tarefa ativa.',
  'live open': 'live open <id> <chat|concord> <referência> <objetivo> [--workspace <workspace-Concord>] [--deadline <segundos>].',
  'live claim': 'live claim <pedido> <responsável> [--checked "<verificação de posse e arquivos>"].',
  'live supervise': 'live supervise <pedido> <workspace-Concord> <identidade-Concord>.',
  'live status': 'live status <pedido>.',
  'live watch': 'live watch <pedido> [--json] [--until delivered] [--timeout <segundos>].',
  'live ack-read': 'live ack-read <ID-da-mensagem-Concord>.',
  'live delivery': 'live delivery <pedido>.',
  'live retry-delivery': 'live retry-delivery <pedido>.',
  'live event': 'live event <pedido> ...: veja docs/comunicacao.md.',
  'live receipt': 'live receipt <pedido> ...: veja docs/comunicacao.md.',
  concord: 'concord check|workspace|close-merged [--dry-run]|stale|holds -- <arquivos>.',
  worktree: 'worktree new <branch> | worktree done <caminho>.',
  git: 'git commit "<mensagem>" -- <arquivos> | git push | git pr "<título>" --body-file <arquivo.md> [--base <branch>].',
  skills: 'skills guide [etapa|apoio] | skills find <termos> | skills list | skills upstream | skills add <dono/repositorio@skill> [--fonte-aprovada "<registro do aceite>"].',
  bootstrap: 'bootstrap check | concord | concord-portable | git-init | publish-private dono/repo [-- mesmos arquivos revisados].',
  feedback: 'feedback <bug|melhoria|funcionalidade> "<título>" (--body "<texto>" | --body-file <arquivo>) [--dry-run] [--force].',
  issue: 'issue <dono/repo>.',
  update: 'update <check|notice claude|notice codex>.',
  onboard: 'onboard [--offline] | onboard done | onboard status.',
  doctor: 'doctor [--offline].',
  panel: 'panel [--watch].',
  'github-mcp': 'github-mcp install | check | start: GitHub MCP oficial, só leitura.',
};
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function run(name, args, client) {
  const env = { ...process.env };
  if (client === 'codex') delete env.AGENT_FLOW_CONCORD_TRANSPORT;
  else env.AGENT_FLOW_CONCORD_TRANSPORT = 'portable';
  env.AGENT_KIT_CLIENT = client;
  const child = spawnSync(process.execPath, [script(name), ...args], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.exitCode = child.status ?? 1;
    return false;
  }
  return true;
}

function concordServer() {
  const bridge = fileURLToPath(new URL('concord-mcp.mjs', import.meta.url));
  return { command: process.execPath, args: [bridge] };
}

function hermesConfig() {
  const runner = fileURLToPath(import.meta.url);
  const skills = fileURLToPath(new URL('../.agents/skills', import.meta.url));
  return {
    skills: { external_dirs: [skills] },
    mcp_servers: {
      'concord-kit': concordServer(),
      [githubServer]: { command: process.execPath, args: [githubLauncher(), 'start'] },
    },
    hooks: { pre_tool_call: [{
      matcher: 'write_file|patch',
      command: [process.execPath, runner, 'hook', 'hermes'].map(quote).join(' '),
      timeout: 5,
      fail_closed: true,
    }] },
  };
}

// Procura o executável no PATH sem rodá-lo: no Windows vale qualquer extensão de PATHEXT.
function onPath(name) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    .some((dir) => exts.some((ext) => existsSync(path.join(dir, name + ext))));
}

function hermesNotice() {
  if (!onPath('hermes')) {
    console.error('Aviso: Hermes não encontrado no PATH. Instale o Hermes (ou ponha-o no PATH), depois rode'
      + ' node .agent-kit/kit.mjs hermes-config e incorpore o trecho no config.yaml do perfil.');
  }
}

// Sem --client, o ambiente da sessão diz o cliente. Variáveis do Codex e do Claude juntas (um `codex exec` lançado
// pelo Claude herda a dele) não decidem nada: fica portable, como antes.
function detectClient(env = process.env) {
  const codex = Boolean(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  const claude = Boolean(env.CLAUDE_CODE_SESSION_ID);
  if (codex === claude) return 'portable';
  return codex ? 'codex' : 'claude';
}

const inheritNote = {
  claude: 'Escolha o modelo pela ferramenta Agent; o kit não lista modelos neste cliente. Registre a escolha no Concord.',
  hermes: 'Neste cliente o modelo é herdado da sessão: o kit não lista nem escolhe modelo. Registre esse limite no Concord.',
  antigravity: 'Neste cliente o modelo é herdado da sessão: o kit não lista nem escolhe modelo. Registre esse limite no Concord.',
};

function main(args) {
  let client;
  // Opções antes do comando, no lugar das variáveis de ambiente: `Bash(node .agent-kit/kit.mjs *)` casa, `VAR=x node ...` não.
  for (;;) {
    if (args[0] === '--client') client = args.splice(0, 2)[1] ?? '';
    else if (args[0] === '--agent-id') {
      if (!args[1] || args[1].startsWith('--')) throw Error('--agent-id precisa de um id, por exemplo claude-code:revisor-x-r1.');
      process.env.CONCORD_AGENT_ID = args.splice(0, 2)[1];
    } else break;
  }
  client ??= detectClient();
  if (!clients.includes(client)) throw Error('Cliente inválido. Use portable, codex, claude, hermes ou antigravity.');
  const [command, ...rest] = args;
  if (command === 'setup' && rest.every((flag) => ['--dry-run', '--sem-github-mcp'].includes(flag))) {
    const dry = rest.includes('--dry-run');
    const withGithub = client !== 'antigravity' && !rest.includes('--sem-github-mcp');
    // Tudo o que o setup grava fora da raiz do projeto, dito antes de gravar.
    const outside = [
      client === 'codex' ? 'Concord: se faltar, npm install -g do pacote conhecido (global) e codex mcp add concord (~/.codex/config.toml).'
        : 'Concord: se faltar, npm install -g do pacote conhecido (global).',
      ...(withGithub ? ['GitHub MCP: binário e lançador em ' + path.dirname(githubLauncher()) + ' (pasta do usuário)'
        + (client === 'codex' ? ' e codex mcp add ' + githubServer + ' (~/.codex/config.toml).' : '.')] : []),
    ];
    console.log((dry ? 'Setup (simulação, nada foi gravado). ' : 'Setup. ') + 'Dentro do projeto: Git (git init se faltar), .concord/.gitignore'
      + (client === 'antigravity' ? ', .agents/hooks.json, .agents/mcp_config.json e .agents/agent-flow-hook.cjs' : '') + '. Fora da raiz do projeto:');
    for (const line of outside) console.log('- ' + line);
    if (!withGithub) console.log('- Sem o GitHub MCP: a leitura do GitHub segue pelo gh (opção --sem-github-mcp).');
    if (client === 'hermes') hermesNotice();
    if (dry) return;
    if (run('bootstrap', ['git-init'], client)
      && run('bootstrap', [client === 'codex' ? 'concord' : 'concord-portable'], client)
      && (client !== 'antigravity' || run('antigravity', ['setup'], client))) {
      run('concord', ['check'], client);
    }
    // Sem o GitHub MCP a leitura segue pelo gh: a falha não muda o resultado do setup, e o doctor avisa.
    const code = process.exitCode;
    if (withGithub && !run('github-mcp', ['install'], client)) {
      console.log('GitHub MCP não instalado; a leitura segue pelo gh. Rode node .agent-kit/kit.mjs github-mcp install depois.');
      process.exitCode = code;
    }
  } else if (command === 'antigravity-config' && !rest.length) {
    run('antigravity', ['config'], client);
  } else if (command === 'hermes-config' && !rest.length) {
    // O stdout fica só com o JSON (que também é YAML válido), para quem o consome; as instruções vão para o stderr.
    console.log(JSON.stringify(hermesConfig(), null, 2));
    console.error([
      'Destino: o config.yaml do perfil (~/.hermes/config.yaml no perfil padrão, ~/.hermes/profiles/<perfil>/config.yaml'
        + ' num perfil nomeado; hermes -p <perfil> config path mostra o caminho; no Windows nativo a base é %LOCALAPPDATA%\\hermes).',
      'Mescla: não cole uma segunda chave de topo. Se o perfil já tem skills.external_dirs, mcp_servers ou hooks.pre_tool_call,'
        + ' acrescente a pasta, os servidores e o item do hook dentro das listas e mapas que já existem.',
      'Aceite: cada hook precisa de aceite; sem tela, abra com --accept-hooks (ou HERMES_ACCEPT_HOOKS=1), senão a guarda é'
        + ' ignorada sem aviso. Para o ID da sessão no prompt, abra com --pass-session-id.',
      'Os caminhos absolutos do trecho valem para esta pasta e este Node: gere de novo ao mover o projeto ou trocar o Node;'
        + ' com fail_closed, um caminho velho recusa toda escrita.',
    ].join('\n'));
    hermesNotice();
  } else if (command === 'mcp-config' && !rest.length) {
    console.log(JSON.stringify({ type: 'stdio', ...concordServer() }, null, 2));
  } else if (command === 'hook' && rest.length === 1 && rest[0] === 'antigravity') {
    run('antigravity', ['hook'], 'antigravity');
  } else if (command === 'hook' && rest.length === 1 && ['claude', 'hermes'].includes(rest[0])) {
    run('flow', ['hook', rest[0]], rest[0]);
  } else if (command === 'route-model' && client !== 'codex') {
    if (rest.length !== 1 || !['light', 'standard', 'complex', 'critical'].includes(rest[0])) {
      throw Error('Use route-model <light|standard|complex|critical>.');
    }
    console.log(JSON.stringify({ request: rest[0], profile: 'inherit', client, ...(inheritNote[client] && { note: inheritNote[client] }) }));
  } else if (commands.includes(command) && rest.length <= 2 && rest.some((a) => a === '--help' || a === '-h')
    && (ajuda[command + ' ' + rest[0]] || ajuda[command])) {
    console.log('Uso: node .agent-kit/kit.mjs ' + (ajuda[command + ' ' + rest[0]] ?? ajuda[command]));
  } else if (commands.includes(command)) {
    const publishes = command === 'git' || command === 'bootstrap' && rest[0] === 'publish-private'
      || command === 'issue' && !rest.includes('--dry-run') || command === 'worktree' && rest[0] === 'new';
    if (publishes) {
      const upgrade = requiredKitUpdate(root);
      if (upgrade) throw Error(upgrade);
    }
    run(command, rest, client);
  } else if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Kit: [--client portable|codex|claude|hermes|antigravity] [--agent-id <id>] setup [--dry-run] [--sem-github-mcp] | onboard [--offline|done|status] | flow | live | concord | bootstrap | route-model'
      + ' | doctor [--offline] | panel [--watch] | update check | feedback | skills guide|find|list|upstream|add | git commit|push|pr | worktree new|done | issue <dono/repo>'
      + ' | hermes-config | antigravity-config | mcp-config');
  } else {
    throw Error('Comando inválido. Use kit.mjs --help.');
  }
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
