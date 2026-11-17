import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = (name) => fileURLToPath(new URL('../.codex/hooks/' + name + '.mjs', import.meta.url));
const clients = ['portable', 'codex', 'claude', 'hermes', 'antigravity'];
const commands = ['flow', 'live', 'concord', 'bootstrap', 'route-model', 'doctor', 'update', 'feedback', 'skills', 'git', 'issue', 'panel', 'onboard'];
// Uso de cada subcomando para `<comando> <subcomando> --help`; nada é executado.
const ajuda = {
  'flow new': 'flow new <feature|fix|maintenance> "<objetivo>" [--ui]. Tarefa só de documentação ou de uma frente: use maintenance (1 frente).',
  'flow status': 'flow status: mostra a tarefa ativa e o próximo passo.',
  'flow link-live': 'flow link-live <pedido> [--checked "<verificação de posse e arquivos>"].',
  'flow record-parallel': 'flow record-parallel <discover|review> <tarefa-pai> <frente-1> [frente-2] [frente-3]'
    + ' [--workspace <workspace-Concord> | --declarativo "<motivo>"]. feature exige 2 frentes; fix e maintenance, 1.',
  'flow approve': 'flow approve <plano.md> "<onde e como o usuário aceitou>".',
  'flow scope': 'flow scope [--session <sessão>] [--task <tarefa-Concord>] [--unclaimed "<motivo>"] -- <arquivos> (só em implement).',
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
  git: 'git commit "<mensagem>" -- <arquivos> | git push | git pr "<título>" --body-file <arquivo.md> [--base <branch>].',
  skills: 'skills find <termos> | skills list | skills upstream | skills add <dono/repositorio@skill> [--fonte-aprovada "<registro do aceite>"].',
  bootstrap: 'bootstrap check | concord | concord-portable | git-init | publish-private dono/repo [-- mesmos arquivos revisados].',
  feedback: 'feedback <bug|melhoria|funcionalidade> "<título>" (--body "<texto>" | --body-file <arquivo>) [--dry-run] [--force].',
  issue: 'issue <dono/repo>.',
  update: 'update <check|notice claude|notice codex>.',
  onboard: 'onboard [--offline] | onboard done | onboard status.',
  doctor: 'doctor [--offline].',
  panel: 'panel [--watch].',
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
    mcp_servers: { 'concord-kit': concordServer() },
    hooks: { pre_tool_call: [{
      matcher: 'write_file|patch',
      command: [process.execPath, runner, 'hook', 'hermes'].map(quote).join(' '),
      timeout: 5,
      fail_closed: true,
    }] },
  };
}

function main(args) {
  let client = 'portable';
  if (args[0] === '--client') client = args.splice(0, 2)[1];
  if (!clients.includes(client)) throw Error('Cliente inválido. Use portable, codex, claude, hermes ou antigravity.');
  const [command, ...rest] = args;
  if (command === 'setup' && !rest.length) {
    if (run('bootstrap', ['git-init'], client)
      && run('bootstrap', [client === 'codex' ? 'concord' : 'concord-portable'], client)
      && (client !== 'antigravity' || run('antigravity', ['setup'], client))) {
      run('concord', ['check'], client);
    }
  } else if (command === 'antigravity-config' && !rest.length) {
    run('antigravity', ['config'], client);
  } else if (command === 'hermes-config' && !rest.length) {
    console.log(JSON.stringify(hermesConfig(), null, 2));
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
    console.log(JSON.stringify({ request: rest[0], profile: 'inherit', client }));
  } else if (commands.includes(command) && rest.length <= 2 && rest.some((a) => a === '--help' || a === '-h')
    && (ajuda[command + ' ' + rest[0]] || ajuda[command])) {
    console.log('Uso: node .agent-kit/kit.mjs ' + (ajuda[command + ' ' + rest[0]] ?? ajuda[command]));
  } else if (commands.includes(command)) {
    run(command, rest, client);
  } else if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Kit: [--client portable|codex|claude|hermes|antigravity] setup | onboard [--offline|done|status] | flow | live | concord | bootstrap | route-model'
      + ' | doctor [--offline] | panel [--watch] | update check | feedback | skills find|list|upstream|add | git commit|push|pr | issue <dono/repo>'
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
