import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = (name) => fileURLToPath(new URL('../.codex/hooks/' + name + '.mjs', import.meta.url));
const clients = ['portable', 'codex', 'claude', 'hermes', 'antigravity'];
const commands = ['flow', 'live', 'concord', 'bootstrap', 'route-model', 'doctor', 'update', 'feedback', 'skills', 'git', 'issue', 'panel', 'onboard'];
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
