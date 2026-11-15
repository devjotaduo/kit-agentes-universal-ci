import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));

function directory(t) {
  const base = realpathSync(os.tmpdir());
  const dir = mkdtempSync(path.join(base, 'agent-flow-guards-'));
  t.after(() => {
    assert.equal(path.dirname(realpathSync(dir)), base);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15000, ...options });
}
const flow = (root, ...args) => run(root, process.execPath, ['.codex/hooks/flow.mjs', ...args]);
const boot = (root, ...args) => run(root, process.execPath, ['.codex/hooks/bootstrap.mjs', ...args]);
const git = (root, ...args) => run(root, 'git', args);

function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function blocked(result, message) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, message);
}

function note(root, name) {
  mkdirSync(path.join(root, '.agent-flow/notes'), { recursive: true });
  const file = '.agent-flow/notes/' + name + '.md';
  writeFileSync(path.join(root, file), 'Evidência ' + name);
  return file;
}

function init(root) {
  ok(run(root, process.execPath, [install, root]));
  ok(boot(root, 'git-init'));
  ok(git(root, 'config', 'user.name', 'Teste Agent Flow'));
  ok(git(root, 'config', 'user.email', 'agent-flow@example.invalid'));
  ok(git(root, 'config', 'commit.gpgsign', 'false'));
}

function start(root) {
  init(root);
  ok(flow(root, 'new', 'fix', 'Teste de guardas'));
  ok(flow(root, 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b'));
  ok(flow(root, 'approve', note(root, 'plano'), 'Aceite de teste'));
  ok(flow(root, 'advance', 'discover', note(root, 'discover')));
}

function review(root) {
  ok(flow(root, 'record-parallel', 'review', 'parent', 'review-a', 'review-b'));
  return flow(root, 'advance', 'review', note(root, 'review'));
}

// A guarda aceita a pasta temporária do sistema, e os projetos de teste ficam nela: os hooks rodam com uma pasta
// temporária e um home próprios (os.tmpdir() lê TEMP/TMP/TMPDIR; os.homedir(), USERPROFILE/HOME).
function hookEnv(temp = path.join(os.tmpdir(), 'agent-flow-guards-sem-temp'), home = path.join(temp, 'home')) {
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function hookOutput(root, client, session, toolName, toolInput, env = hookEnv()) {
  const input = JSON.stringify({ cwd: root, session_id: session, hook_event_name: 'PreToolUse', tool_name: toolName,
    tool_input: toolInput });
  return JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook', client], { input, env }))).hookSpecificOutput;
}

const patch = (...lines) => ({ command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') });

function patchDecision(root, session, ...lines) {
  return hookOutput(root, 'codex', session, 'apply_patch', patch(...lines))?.permissionDecision;
}

test('scope reads the Claude Code session id and the hook shows it', (t) => {
  const root = directory(t);
  start(root);
  const input = JSON.stringify({ cwd: root, session_id: 'claude-1', hook_event_name: 'SessionStart' });
  const started = JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook'], { input })));
  assert.match(started.hookSpecificOutput.additionalContext, /Sessão: claude-1\./);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'claude-1' };
  for (const name of ['AGENT_FLOW_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name];
  ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'scope', '--', 'src/**'], { env }));
  assert.equal(patchDecision(root, 'claude-1', '*** Add File: src/a.txt', '+ok'), undefined);
  assert.equal(patchDecision(root, 'claude-2', '*** Add File: src/a.txt', '+outra'), 'deny');
  const refusal = JSON.stringify({ cwd: root, session_id: 'claude-2', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: src/b.txt\n+x\n*** End Patch' } });
  assert.match(JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook'], { input: refusal })))
    .hookSpecificOutput.permissionDecisionReason, /kit\.mjs flow scope --session claude-2 -- <arquivos>/);
  blocked(flow(root, 'scope', '--session', 'C:/scratch/claude-1', '--', 'src/**'), /ID de sessão inválido/);
  env.CODEX_THREAD_ID = 'codex-1';
  ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'scope', '--', 'src/**'], { env }));
  assert.equal(patchDecision(root, 'codex-1', '*** Add File: src/a.txt', '+ok'), undefined);
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  blocked(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'scope', '--', 'src/**'], { env }), /Identidade da sessão indisponível/);
});

test('Live sem impasse: dono fecha depois do prazo, link-live aceita o anterior vencido ou done e reopen dispensa cancel', (t) => {
  const root = directory(t);
  start(root);
  const as = (token, script, ...args) => run(root, process.execPath, ['.codex/hooks/' + script + '.mjs', ...args],
    { env: { ...process.env, AGENT_FLOW_LEASE: token } });
  const claim = (request) => JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/live.mjs', 'claim', request, 'eu']))).token;
  const open = (request) => ok(run(root, process.execPath, ['.codex/hooks/live.mjs', 'open', request, 'chat', 'sessao', 'Corrigir']));
  // Vincula direto no estado: o vínculo inicial só vale em discover, e o fluxo de teste já está em implement.
  const stateFile = path.join(root, '.agent-flow/active.json');
  const link = (request) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), liveRequest: request }));
  const expire = (request) => {
    const first = path.join(root, '.agent-flow/live', request, '000000000001.json');
    const opened = JSON.parse(readFileSync(first, 'utf8'));
    writeFileSync(first, JSON.stringify({ ...opened, at: opened.at - (opened.policy.hardSeconds + 1) * 1000 }) + '\n');
  };

  open('prazo-1');
  const first = claim('prazo-1');
  link('prazo-1');
  ok(as(first, 'live', 'event', 'prazo-1', 'qa', 'queued', 'Frente'));
  expire('prazo-1');
  // Sem supervisor e com o prazo vencido: o pedido novo assume a etapa e o antigo é fechado pelo dono.
  blocked(as(first, 'flow', 'advance', 'implement', note(root, 'implement')), /abra outro pedido/i);
  open('prazo-2');
  const second = claim('prazo-2');
  blocked(as(second, 'flow', 'link-live', 'prazo-2'), /confira a posse/);
  ok(as(second, 'flow', 'link-live', 'prazo-2', '--checked', 'Frente qa parada e arquivos conferidos'));
  blocked(as(first, 'live', 'event', 'prazo-1', 'root', 'heartbeat', 'Ainda aqui'), /Prazo total atingido/);
  blocked(as('outra', 'live', 'event', 'prazo-1', 'root', 'blocked', 'Sem posse'), /não corresponde a nenhuma posse/);
  blocked(as(first, 'live', 'event', 'prazo-1', 'root', 'blocked', 'Frente aberta'), /frentes abertas/);
  ok(as(first, 'live', 'event', 'prazo-1', 'qa', 'canceled', 'Prazo vencido'));
  ok(as(first, 'live', 'event', 'prazo-1', 'root', 'blocked', 'Prazo vencido; segue em prazo-2'));

  // Pedido done e correção pedida no PR: reopen sem cancel, e o próximo passo pede um pedido novo.
  ok(as(second, 'flow', 'advance', 'implement', note(root, 'implement-2')));
  ok(as(second, 'live', 'event', 'prazo-2', 'root', 'done', 'Entregue'));
  ok(flow(root, 'reopen', 'Correção pedida no PR'));
  // Pedido cancelado também aceita a troca.
  open('cancelado');
  const canceled = claim('cancelado');
  link('cancelado');
  ok(as(canceled, 'live', 'event', 'cancelado', 'root', 'canceled', 'Desistência'));
  open('apos-cancel');
  ok(as(claim('apos-cancel'), 'flow', 'link-live', 'apos-cancel', '--checked', 'Arquivos conferidos'));
  // Pedido do Concord vencido e ainda aberto não pode ser trocado: a resposta ficaria sem entrega.
  // Abre como chat e marca a origem como Concord: abrir pelo Concord exigiria o servidor.
  open('origem');
  const origin = path.join(root, '.agent-flow/live/origem/000000000001.json');
  writeFileSync(origin, JSON.stringify({ ...JSON.parse(readFileSync(origin, 'utf8')), channel: 'concord' }) + '\n');
  const concord = claim('origem');
  link('origem');
  expire('origem');
  open('apos-concord');
  const after = claim('apos-concord');
  blocked(as(after, 'flow', 'link-live', 'apos-concord', '--checked', 'Arquivos conferidos'), /veio do Concord/);
  ok(as(concord, 'live', 'event', 'origem', 'root', 'blocked', 'Prazo vencido'));
  ok(as(after, 'flow', 'link-live', 'apos-concord', '--checked', 'Arquivos conferidos'));
  link('prazo-2');
  blocked(as(second, 'flow', 'advance', 'implement', note(root, 'implement-3')), /abra outro pedido/i);
  open('prazo-3');
  const third = claim('prazo-3');
  ok(as(third, 'flow', 'link-live', 'prazo-3', '--checked', 'Correção do PR; arquivos conferidos'));
  ok(as(third, 'flow', 'advance', 'implement', note(root, 'implement-4')));
});

// Concord falso por stdio: responde inspect_work com as tarefas gravadas no arquivo, relido a cada chamada.
const concordFixture = String.raw`
  const fs = require('node:fs');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    const reply = (result) => console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (req.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
    if (req.method !== 'tools/call') return;
    const id = req.params.arguments.task_id;
    const tasks = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    reply({ structuredContent: id ? { workspace_id: 'fixture/projeto', ...tasks[id] } : { scope: 'workspace', workspace_id: 'fixture/projeto' } });
  });
`;

test('correção pedida no PR: reopen, implement, validate e review de novo sem cancel; revisão anterior à validação da correção recusada', (t) => {
  const root = directory(t);
  const sandbox = directory(t);
  const tasks = path.join(sandbox, 'tarefas.json');
  const results = (at) => writeFileSync(tasks, JSON.stringify({ parent: { task: { taskId: 'parent' } },
    ...Object.fromEntries(['discover-a', 'discover-b', 'review-a', 'review-b'].map((id) => [id, {
      task: { taskId: id, parentTaskId: 'parent', status: 'review_ready', title: id, version: 1 },
      latest_handoff: { whatChanged: 'feito', createdAt: at } }])) }));
  const config = path.join(sandbox, 'concord.json');
  writeFileSync(config, JSON.stringify({ enabled: true,
    transport: { type: 'stdio', command: process.execPath, args: ['-e', concordFixture, tasks] } }));
  let token = '';
  const as = (script, ...args) => run(root, process.execPath, ['.codex/hooks/' + script + '.mjs', ...args],
    { env: { ...process.env, AGENT_FLOW_CONCORD_CONFIG: config, AGENT_FLOW_LEASE: token } });
  const request = (id) => {
    ok(as('live', 'open', id, 'chat', 'sessao', 'Corrigir'));
    token = JSON.parse(ok(as('live', 'claim', id, 'eu'))).token;
  };
  const workspace = ['--workspace', 'fixture/projeto'];
  const reviewFronts = (...extra) => as('flow', 'record-parallel', 'review', 'parent', 'review-a', 'review-b', ...extra);
  const deliver = (round) => {
    for (const stage of ['implement', 'validate']) ok(as('flow', 'advance', stage, note(root, stage + '-' + round)));
  };
  init(root);
  results('2026-01-01T00:00:00.000Z');

  // Com pedido Live: as frentes são conferidas no Concord.
  ok(as('flow', 'new', 'fix', 'Correção com pedido'));
  request('pedido-1');
  ok(as('flow', 'link-live', 'pedido-1'));
  assert.match(ok(as('flow', 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b', ...workspace)), /conferidas no Concord/);
  ok(as('flow', 'approve', note(root, 'plano'), 'Aceite de teste'));
  ok(as('flow', 'advance', 'discover', note(root, 'discover')));
  deliver(1);
  ok(reviewFronts(...workspace));
  ok(as('flow', 'advance', 'review', note(root, 'review-1')));
  ok(as('live', 'event', 'pedido-1', 'root', 'done', 'Entregue'));
  ok(flow(root, 'reopen', 'Correção pedida no PR'));
  request('pedido-2');
  ok(as('flow', 'link-live', 'pedido-2', '--checked', 'Frentes antigas encerradas e arquivos conferidos'));
  // Entrega feita entre o reopen e a validação da correção também é recusada.
  results(new Date().toISOString());
  deliver(2);
  blocked(reviewFronts(...workspace), /review-a anterior à validação da versão corrigida/);
  results(new Date().toISOString());
  ok(reviewFronts(...workspace));
  ok(as('flow', 'advance', 'review', note(root, 'review-2')));
  ok(as('flow', 'check'));
  ok(as('live', 'event', 'pedido-2', 'root', 'done', 'Correção entregue'));
  assert.match(ok(as('flow', 'close')), /closed/);

  // Sem pedido Live: sem reopen o registro sem --workspace é declarativo e diz isso; depois do reopen exige --workspace.
  ok(flow(root, 'new', 'fix', 'Correção sem pedido'));
  assert.match(ok(flow(root, 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b')),
    /sem consulta ao Concord \(registro declarativo\).*--workspace <workspace-Concord>/);
  ok(flow(root, 'approve', note(root, 'plano-2'), 'Aceite de teste'));
  ok(flow(root, 'advance', 'discover', note(root, 'discover-2')));
  deliver(3);
  ok(reviewFronts(...workspace));
  ok(flow(root, 'advance', 'review', note(root, 'review-3')));
  ok(flow(root, 'reopen', 'Correção pedida no PR'));
  deliver(4);
  blocked(reviewFronts(), /precisa ser conferida no Concord.*--workspace <workspace-Concord>/);
  writeFileSync(path.join(root, '.agent-flow/concord-workspace.json'), JSON.stringify({ workspace_id: 'fixture/projeto' }));
  blocked(reviewFronts(), /flow record-parallel review parent review-a review-b --workspace fixture\/projeto\./);
  blocked(reviewFronts(...workspace), /anterior à validação/);
  results(new Date().toISOString());
  ok(reviewFronts(...workspace));
  ok(flow(root, 'advance', 'review', note(root, 'review-4')));
  ok(flow(root, 'check'));
  assert.match(ok(flow(root, 'close')), /closed/);
  assert.equal(readdirSync(path.join(root, '.agent-flow/archive')).map((file) =>
    JSON.parse(readFileSync(path.join(root, '.agent-flow/archive', file), 'utf8')).outcome).sort().join(), 'closed,closed');
});

test('recusas dizem a causa: credencial, posse, destino, worktree e próximo comando', (t) => {
  const root = directory(t);
  ok(run(root, process.execPath, [install, root]));
  ok(boot(root, 'git-init'));
  ok(git(root, 'config', 'user.name', 'Teste Agent Flow'));
  ok(git(root, 'config', 'user.email', 'agent-flow@example.invalid'));
  ok(git(root, 'config', 'commit.gpgsign', 'false'));
  assert.match(ok(flow(root, 'new', 'fix', 'Mensagens')), /Próximo: node \.agent-kit\/kit\.mjs flow record-parallel discover .*--workspace.*flow approve <plano\.md>/);
  ok(flow(root, 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b'));
  ok(flow(root, 'approve', note(root, 'plano'), 'Aceite de teste'));
  assert.match(ok(flow(root, 'advance', 'discover', note(root, 'discover'))), /Próximo: .*flow scope \[--task <tarefa-Concord>\] -- <arquivos>/);

  // Evidência que só existe em outra worktree: a mensagem diz qual, sem ENOENT.
  ok(git(root, 'commit', '--allow-empty', '-q', '-m', 'base'));
  const other = path.join(directory(t), 'outra');
  ok(git(root, 'worktree', 'add', '-q', other));
  mkdirSync(path.join(other, '.agent-flow/notes'), { recursive: true });
  writeFileSync(path.join(other, '.agent-flow/notes/so-la.md'), 'Evidência');
  const missing = flow(root, 'advance', 'implement', '.agent-flow/notes/so-la.md');
  blocked(missing, /Evidência .*so-la\.md não existe em/);
  assert.ok(missing.stderr.includes(realpathSync.native(other)) && !/ENOENT/.test(missing.stderr), missing.stderr);
  blocked(run(root, process.execPath, ['.codex/hooks/live.mjs', 'status', 'nenhum']), /Pedido Live nenhum não existe em/);

  // Posse: sem credencial, com a posse vencida.
  const liveCli = (env, ...args) => run(root, process.execPath, ['.codex/hooks/live.mjs', ...args], { env: { ...process.env, ...env } });
  ok(liveCli({}, 'open', 'msgs', 'chat', 'sessao', 'Mensagens'));
  const token = JSON.parse(ok(liveCli({}, 'claim', 'msgs', 'eu'))).token;
  const withoutLease = { ...process.env };
  delete withoutLease.AGENT_FLOW_LEASE;
  blocked(run(root, process.execPath, ['.codex/hooks/live.mjs', 'event', 'msgs', 'root', 'heartbeat', 'Oi'], { env: withoutLease }),
    /Credencial ausente: defina AGENT_FLOW_LEASE .*posse de eu/);
  const leaseFile = path.join(root, '.agent-flow/live/msgs/000000000002.json');
  writeFileSync(leaseFile, JSON.stringify({ ...JSON.parse(readFileSync(leaseFile, 'utf8')), expiresAt: Date.now() - 1000 }) + '\n');
  blocked(liveCli({ AGENT_FLOW_LEASE: token }, 'event', 'msgs', 'root', 'heartbeat', 'Oi'),
    /Posse expirada em .*kit\.mjs live claim msgs/);

  // Destino: a recusa traz a causa, o destino e a raiz.
  const reason = (target) => hookOutput(root, 'codex', 's1', 'apply_patch', patch('*** Add File: ' + target, '+x'))
    .permissionDecisionReason;
  const outside = reason('../fora.txt');
  assert.match(outside, /destino recusado: \.\.\/fora\.txt\. Caminho deve ficar dentro do projeto\. Raiz considerada: /);
  assert.ok(outside.includes(realpathSync.native(root)), outside);
});

// Projeto em implement com escopo src/** para s1, e pasta temporária e home próprios para os hooks.
function outsideProject(t) {
  const root = directory(t);
  start(root);
  ok(git(root, 'commit', '--allow-empty', '-q', '-m', 'base'));
  ok(flow(root, 'scope', '--session', 's1', '--', 'src/**'));
  const base = directory(t);
  const temp = path.join(base, 'temp');
  const home = path.join(base, 'home');
  mkdirSync(temp);
  mkdirSync(home);
  const env = hookEnv(temp, home);
  const claude = (file, session = 's1') => hookOutput(root, 'claude', session, 'Write', { file_path: file, content: 'x' }, env);
  const codex = (session, ...lines) => hookOutput(root, 'codex', session, 'apply_patch', patch(...lines), env);
  const hermes = (toolName, toolInput, session = 's1') => JSON.parse(ok(run(root, process.execPath,
    ['.codex/hooks/flow.mjs', 'hook', 'hermes'], { env, input: JSON.stringify({ cwd: root, session_id: session,
      hook_event_name: 'pre_tool_call', tool_name: toolName, tool_input: toolInput }) })));
  return { root, base, temp, home, env, claude, codex, hermes };
}

test('fora do projeto só passam a pasta temporária e a memória deste projeto no Claude Code', (t) => {
  const { root, temp, home, claude, codex: codexPatch } = outsideProject(t);
  const codex = (file) => codexPatch('s1', '*** Add File: ' + file, '+x');
  const real = realpathSync.native(root);
  const memory = path.join(home, '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

  // Aceitos sem escopo nem etapa: a sessão sem escopo grava no temporário e na memória, mas não no produto.
  assert.equal(claude(path.join(temp, 'claude', 'scratchpad', 'nota.md'), 'sem-escopo'), undefined);
  assert.equal(claude(path.join(memory, 'MEMORY.md'), 'sem-escopo'), undefined);
  assert.equal(claude(path.join(root, 'src', 'a.txt'), 'sem-escopo').permissionDecision, 'deny');
  assert.equal(codex(path.join(temp, 'codex.txt')), undefined);
  assert.equal(codex(path.join(memory, 'MEMORY.md')).permissionDecision, 'deny');

  // Fora da lista: outra pasta do home e a memória de outro projeto.
  for (const file of [path.join(home, 'Documents', 'x.md'), path.join(home, '.claude', 'projects', 'outro', 'memory', 'x.md')]) {
    assert.match(claude(file).permissionDecisionReason, /Caminho deve ficar dentro do projeto\. Raiz considerada: /);
  }

  // Link fora do projeto que aponta para dentro dele, mesmo dentro da pasta temporária.
  symlinkSync(root, path.join(temp, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(claude(path.join(temp, 'link', 'src', 'a.txt')).permissionDecisionReason,
    /link ou junção fora do projeto e cai dentro dele/);

  // Worktree do mesmo repositório, mesmo dentro da pasta temporária: diz qual e manda abrir a sessão nela.
  const other = path.join(temp, 'outra');
  ok(git(root, 'worktree', 'add', '-q', other));
  const tree = claude(path.join(other, 'src', 'a.txt')).permissionDecisionReason;
  assert.ok(tree.includes('worktree ' + realpathSync.native(other) + ' do mesmo repositório: abra a sessão nessa worktree'), tree);

  // Outro repositório: recusa com a raiz considerada.
  const repo = directory(t);
  ok(git(repo, 'init', '-q'));
  const elsewhere = claude(path.join(repo, 'a.txt')).permissionDecisionReason;
  assert.match(elsewhere, /Caminho deve ficar dentro do projeto\. Raiz considerada: /);
  assert.ok(elsewhere.includes(real), elsewhere);
});

test('fora do projeto: cabeçalho recuado, Move to, Hermes, hardlink, junção no projeto e worktrees sem lista', (t) => {
  const { root, base, temp, env, claude, codex, hermes } = outsideProject(t);
  const link = (target, at) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const scratch = path.join(temp, 'isca.txt');
  const state = path.join(root, '.agent-flow', 'active.json');

  // Codex: a pasta temporária não leva junto produto nem estado local, com ou sem cabeçalho recuado.
  assert.equal(codex('sem-escopo', '*** Add File: ' + scratch, '+x'), undefined);
  for (const header of ['*** Update File: ', '  *** Update File: ', '\t*** Update File: ']) {
    assert.equal(codex('s1', '*** Add File: ' + scratch, '+x', header + state, '@@', '+x').permissionDecision, 'deny', header);
  }
  assert.equal(codex('sem-escopo', '*** Add File: ' + scratch, '+x', '  *** Add File: src/a.txt  ', '+x').permissionDecision, 'deny');
  assert.match(codex('s1', '*** Add File: ' + scratch, '+x', ' *** Frobnicate File: src/a.txt').permissionDecisionReason,
    /cabeçalho \*\*\* que a guarda não reconhece/);
  // Move to da pasta temporária para o produto ou para o estado local.
  writeFileSync(scratch, 'x\n');
  assert.equal(codex('sem-escopo', '*** Update File: ' + scratch, '*** Move to: src/movido.txt', '@@', '-x', '+y')
    .permissionDecision, 'deny');
  assert.equal(codex('s1', '*** Update File: ' + scratch, '  *** Move to: .agent-flow/active.json', '@@', '-x', '+y')
    .permissionDecision, 'deny');

  // Hermes: a pasta temporária passa; com produto junto, inclusive recuado ou por Move File, não.
  const hermesPatch = (...lines) => hermes('patch', { mode: 'patch', patch: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
    'sem-escopo');
  assert.deepEqual(hermes('write_file', { path: scratch }, 'sem-escopo'), {});
  assert.deepEqual(hermesPatch('*** Add File: ' + path.join(temp, 'h.txt'), '+x'), {});
  assert.equal(hermesPatch('*** Add File: ' + path.join(temp, 'h.txt'), '+x', '  *** Add File: ' + path.join(root, 'src', 'h.txt'), '+x')
    .action, 'block');
  assert.equal(hermesPatch('*** Update File: ' + scratch, '***Move File: ' + scratch + ' -> ' + path.join(root, 'src', 'h.txt'))
    .action, 'block');
  assert.equal(hermesPatch('*** Add File: ' + path.join(temp, 'h.txt'), '\t***  Unknown: x').action, 'block');

  // U+0085 (NEL) é branco para o trim() do Rust: o cabeçalho com ele na frente é lido como destino.
  assert.equal(codex('s1', '*** Add File: ' + scratch, '+x', '\u0085*** Update File: ' + state, '@@', '+x').permissionDecision, 'deny');
  assert.equal(codex('sem-escopo', '*** Add File: ' + scratch, '+x', '\u0085*** Add File: src/nel.txt', '+x').permissionDecision, 'deny');
  assert.equal(hermesPatch('*** Add File: ' + path.join(temp, 'h.txt'), '+x', '\u0085*** Add File: ' + path.join(root, 'src', 'h.txt'), '+x')
    .action, 'block');
  // O Codex grava o caminho com os espaços à esquerda: " src/a.txt" não é src/a.txt e fica fora do escopo src/**.
  assert.equal(codex('s1', '*** Add File: src/a.txt', '+x'), undefined);
  assert.equal(codex('s1', '*** Add File:  src/a.txt', '+x').permissionDecision, 'deny');
  // No Hermes o caminho é aparado, como no parser dele.
  assert.deepEqual(hermesPatch('*** Add File:   ' + path.join(temp, 'h.txt') + '  ', '+x'), {});
  // Markdown com *** no contexto ou no texto não é cabeçalho; CRLF também é lido.
  assert.equal(codex('s1', '*** Update File: src/doc.md', '@@', ' ***', '-***negrito***', '+**negrito**', '+ *** fim ***'), undefined);
  assert.equal(hookOutput(root, 'codex', 's1', 'apply_patch',
    { command: ['*** Begin Patch', '*** Add File: src/crlf.txt', '+x', '*** End Patch'].join('\r\n') }, env), undefined);
  assert.deepEqual(hermesPatch('*** Add File: ' + path.join(temp, 'doc.md'), '+***', '+***negrito***'), {});
  assert.deepEqual(hermes('patch', { mode: 'patch', patch: ['*** Begin Patch', '*** Add File: ' + path.join(temp, 'crlf.md'), '+x',
    '*** End Patch'].join('\r\n') }, 'sem-escopo'), {});
  // Forma de cabeçalho desconhecida continua recusando, mesmo no meio do texto.
  assert.equal(codex('s1', '*** Update File: src/doc.md', '@@', ' *** Nota: x').permissionDecision, 'deny');

  // Hermes: o \s do Python inclui U+001C a U+001F; com eles o cabeçalho continua lido como destino.
  const ch = (code) => String.fromCharCode(code);
  const bait = '*** Add File: ' + path.join(temp, 'isca.md');
  assert.equal(hermesPatch(bait, '+x', '***' + ch(0x1c) + 'Add File: ' + path.join(root, 'src', 'h.txt'), '+x').action, 'block');
  assert.equal(hermesPatch(bait, '+x', '*** Add' + ch(0x1f) + 'File: ' + state, '+x').action, 'block');
  assert.equal(hermesPatch(bait, '+x', '***' + ch(0x1e) + 'Move File: ' + scratch + ' -> ' + state).action, 'block');
  assert.equal(hermesPatch(bait, '+x', ch(0x1d) + '*** Update File: ' + state).action, 'block');
  // Palavra de cabeçalho que a guarda não entende recusa; Markdown no contexto, não.
  assert.equal(hermesPatch(bait, '+x', '***' + ch(0x1c) + 'Delete' + ch(0x1c) + 'Files ' + state).action, 'block');
  assert.deepEqual(hermesPatch('*** Update File: ' + scratch, '@@', ' ***', ' ***negrito***', ' *** fim ***', '-x', '+***Endereço***'), {});

  // Hardlink na pasta temporária para um arquivo de produto.
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'produto.txt'), 'produto');
  linkSync(path.join(root, 'src', 'produto.txt'), path.join(temp, 'hard.txt'));
  assert.match(claude(path.join(temp, 'hard.txt')).permissionDecisionReason, /hardlink/);

  // Caminho que entra no projeto por um link de fora e sai por uma junção dele para a pasta temporária.
  const alias = path.join(base, 'alias');
  link(path.dirname(root), alias);
  link(temp, path.join(root, 'tj'));
  assert.match(claude(path.join(alias, path.basename(root), 'tj', 'x.md')).permissionDecisionReason,
    /link ou junção dentro do projeto/);

  // Nome curto do Windows na raiz com junção do projeto para a pasta temporária (caso do CI).
  const short = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-Command',
    "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('" + root + "').ShortPath"], { encoding: 'utf8' }).stdout?.trim();
  if (short && short.toLowerCase() !== root.toLowerCase()) {
    assert.equal(claude(path.join(short, 'tj', 'escape.md')).permissionDecision, 'deny');
  } else t.diagnostic('Sem nome curto do Windows nesta máquina: caso do nome curto não exercitado.');

  // Projeto Git em que git worktree list falha: destinos fora do projeto recusados; sem Git, como antes.
  renameSync(path.join(root, '.git'), path.join(root, '.git-guardado'));
  mkdirSync(path.join(root, '.git'));
  assert.match(claude(path.join(temp, 'sem-lista.md')).permissionDecisionReason,
    /listar as worktrees .*destinos fora do projeto ficam recusados/);
  rmSync(path.join(root, '.git'), { recursive: true });
  assert.equal(claude(path.join(temp, 'sem-lista.md')), undefined);
});

test('implement guard verifies exact session scope, move destinations and symlinks', (t) => {
  const root = directory(t);
  start(root);
  assert.equal(patchDecision(root, 'scope-1', '*** Add File: ../fora.txt', '+outside'), 'deny');
  assert.equal(patchDecision(root, 'scope-1', '*** Add File: .git/config', '+outside'), 'deny');
  ok(flow(root, 'scope', '--session', 'scope-1', '--', 'src/**'));
  assert.equal(patchDecision(root, 'scope-1', '*** Add File: src/valid.txt', '+allowed'), undefined);
  assert.equal(patchDecision(root, 'scope-2', '*** Add File: src/valid.txt', '+denied'), 'deny');
  assert.equal(patchDecision(root, 'scope-1', '*** Add File: src-other/a.txt', '+denied'), 'deny');
  assert.equal(patchDecision(root, 'scope-1', '*** Update File: src/a.txt', '*** Move to: outside.txt'), 'deny');
  mkdirSync(path.join(root, 'src'));
  const outside = directory(t);
  symlinkSync(outside, path.join(root, 'src/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(patchDecision(root, 'scope-1', '*** Add File: src/link/escape.txt', '+denied'), 'deny');
});

test('validation and review cover worktree files, Git index and HEAD', (t) => {
  const root = directory(t);
  start(root);
  const app = path.join(root, 'app.txt');
  writeFileSync(app, 'before');
  ok(flow(root, 'advance', 'implement', note(root, 'implement')));
  ok(flow(root, 'advance', 'validate', note(root, 'validate')));
  writeFileSync(app, 'unreviewed');
  blocked(review(root), /conteúdo do projeto mudou/);
  writeFileSync(app, 'before');
  ok(review(root));
  writeFileSync(path.join(root, 'extra.txt'), 'added after review');
  blocked(flow(root, 'check'), /conteúdo do projeto mudou/);
  rmSync(path.join(root, 'extra.txt'));
  ok(flow(root, 'check'));
  // Snapshot gravado pelo kit até 0.7.3, sem productIndex, segue valendo com o mesmo commit e índice.
  const stateFile = path.join(root, '.agent-flow/active.json');
  const saved = readFileSync(stateFile, 'utf8');
  const old = JSON.parse(saved);
  delete old.snapshot.productIndex;
  writeFileSync(stateFile, JSON.stringify(old));
  ok(flow(root, 'check'));
  writeFileSync(stateFile, saved);
  // Evidência versionada depois da revisão: preparar e commitar docs/work/ não muda o snapshot.
  mkdirSync(path.join(root, 'docs/work'), { recursive: true });
  writeFileSync(path.join(root, 'docs/work/rev.md'), 'Revisão');
  ok(git(root, 'add', 'docs/work/rev.md'));
  ok(flow(root, 'check'));
  ok(git(root, 'commit', '-m', 'evidência'));
  ok(flow(root, 'check'));
  // Fora da evidência em Markdown, nada passa: nem em docs/work, nem num commit intermediário.
  for (const file of ['docs/work/run.js', 'docs/work/.env']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), 'x');
    ok(git(root, 'add', file));
    blocked(flow(root, 'check'), /HEAD ou o índice/);
    ok(git(root, 'rm', '-q', '--cached', file));
    rmSync(path.join(root, file));
  }
  ok(flow(root, 'check'));
  writeFileSync(path.join(root, 'secret.txt'), 'x');
  ok(git(root, 'add', 'secret.txt'));
  ok(git(root, 'commit', '-m', 'intermediário'));
  ok(git(root, 'rm', '-q', 'secret.txt'));
  ok(git(root, 'commit', '-m', 'remove'));
  blocked(flow(root, 'check'), /HEAD ou o índice/);
  ok(git(root, 'reset', '-q', '--hard', 'HEAD~2'));
  ok(flow(root, 'check'));
  ok(git(root, 'add', 'app.txt'));
  blocked(flow(root, 'check'), /HEAD ou o índice/);
  ok(git(root, 'commit', '-m', 'unexpected head'));
  blocked(flow(root, 'check'), /HEAD ou o índice/);
});

test('publication recovers the initial commit and interrupted creation without changing the approved tree', async (t) => {
  const root = directory(t);
  start(root);
  writeFileSync(path.join(root, 'app.txt'), 'approved content');
  writeFileSync(path.join(root, 'excluded.txt'), 'worktree only');
  ok(flow(root, 'publish-selection', '--', 'app.txt'));
  ok(flow(root, 'advance', 'implement', note(root, 'implement')));
  ok(flow(root, 'advance', 'validate', note(root, 'validate')));
  ok(review(root));

  const { publish } = await import(pathToFileURL(path.join(root, '.codex/hooks/bootstrap.mjs')));
  const slug = 'fixture/agent-flow';
  const remoteDir = directory(t);
  ok(git(remoteDir, 'init', '--bare'));
  let remote;
  let creates = 0;
  let pushes = 0;
  const network = (program, args) => {
    if (program === 'gh' && args[0] === 'auth') {
      assert.throws(() => publish('fixture/outro-projeto', [], network), /destino já registrado/);
      return { status: 0 };
    }
    if (program === 'gh' && args[1] === 'view') return remote
      ? { status: 0, stdout: JSON.stringify(remote) }
      : { status: 1, stderr: 'HTTP 404: repository not found' };
    if (program === 'gh' && args[1] === 'create') {
      creates++;
      assert.equal(args[3], '--private');
      remote = { id: 'fixture', nameWithOwner: slug, visibility: 'PRIVATE',
        url: 'https://github.com/' + slug, description: args[5] };
      return { status: 1, error: { code: 'ETIMEDOUT' } };
    }
    assert.equal(program, 'git');
    pushes++;
    const spec = args.at(-1);
    assert.match(spec, /:refs\/heads\/main$/);
    return git(root, 'push', remoteDir, spec);
  };
  assert.throws(() => publish(slug, ['excluded.txt'], network), /seleção.*não corresponde/i);
  assert.throws(() => publish(slug, ['app.txt'], network), /excedeu o prazo/);
  const committed = ok(git(root, 'rev-parse', 'HEAD'));
  const marker = path.join(root, '.agent-flow/bootstrap.json');
  const beforeHeadRecorded = JSON.parse(readFileSync(marker, 'utf8'));
  delete beforeHeadRecorded.head;
  writeFileSync(marker, JSON.stringify(beforeHeadRecorded));

  remote.visibility = 'PUBLIC';
  assert.throws(() => publish(slug, [], network), /Privacidade/);
  assert.equal(pushes, 0);
  remote.visibility = 'PRIVATE';
  publish(slug, [], network);
  assert.equal(creates, 1);
  assert.equal(pushes, 1);
  assert.equal(ok(git(root, 'rev-parse', 'HEAD')), committed);
  assert.equal(ok(git(remoteDir, 'rev-parse', 'refs/heads/main')), committed);
  assert.equal(ok(git(remoteDir, 'ls-tree', '--name-only', 'refs/heads/main')), 'app.txt');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).published, true);
  ok(flow(root, 'close'));
});

test('plano mudado depois do aceite: avisos dizem para parar, reopen funciona e approve novo volta para implement', (t) => {
  const root = directory(t);
  start(root);
  const hook = (event) => JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook'],
    { input: JSON.stringify({ cwd: root, hook_event_name: event }) })));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'plano.md'), 'Plano fora do lugar');
  blocked(flow(root, 'approve', 'docs/plano.md', 'Aceite'), /Guarde o plano em docs\/work/);

  ok(flow(root, 'advance', 'implement', note(root, 'implementacao')));
  writeFileSync(path.join(root, '.agent-flow/notes/plano.md'), 'Plano alterado');
  assert.match(hook('SessionStart').hookSpecificOutput.additionalContext, /O plano mudou depois do aceite/);
  assert.match(hook('Stop').systemMessage, /o plano mudou depois do aceite/);
  ok(flow(root, 'reopen', 'Plano mudou'));
  blocked(flow(root, 'advance', 'implement', note(root, 'implementacao-2')), /O plano mudou depois do aceite/);
  assert.doesNotMatch(ok(flow(root, 'approve', '.agent-flow/notes/plano.md', 'Usuário aceitou a versão nova')), /voltou/);
  ok(flow(root, 'advance', 'implement', '.agent-flow/notes/implementacao-2.md'));
  writeFileSync(path.join(root, '.agent-flow/notes/plano.md'), 'Plano alterado de novo');
  assert.match(ok(flow(root, 'approve', '.agent-flow/notes/plano.md', 'Usuário aceitou a terceira versão')), /voltou para implement/);
  assert.equal(JSON.parse(ok(flow(root, 'status'))).stage, 'implement');
  assert.match(hook('SessionStart').hookSpecificOutput.additionalContext, /Plano aceito/);
});

test('nota de decisões pode ser editada em implement mesmo fora do escopo da sessão', (t) => {
  const root = directory(t);
  start(root);
  ok(flow(root, 'scope', '--session', 'sessao-um', '--', 'src/**'));
  const write = (file) => JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook', 'claude'], { input: JSON.stringify({
    cwd: root, session_id: 'sessao-um', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, file) },
  }) })));
  assert.deepEqual(write('.agent-flow/notes/decisoes.md'), {});
  assert.equal(write('docs/fora.md').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(write('.agent-flow/active.json').hookSpecificOutput.permissionDecision, 'deny');
});

test('plano apagado em implement: só o plano e as notas podem ser editados até o aceite novo', (t) => {
  const root = directory(t);
  start(root);
  const write = (file) => JSON.parse(ok(run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook', 'claude'], { input: JSON.stringify({
    cwd: root, session_id: 'sessao-um', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, file) },
  }) })));
  assert.deepEqual(write('src/app.js'), {});
  rmSync(path.join(root, '.agent-flow/notes/plano.md'));
  assert.match(write('src/app.js').hookSpecificOutput.permissionDecisionReason, /O plano mudou ou sumiu/);
  assert.deepEqual(write('.agent-flow/notes/plano.md'), {});
  assert.deepEqual(write('.agent-flow/notes/decisoes.md'), {});
  writeFileSync(path.join(root, '.agent-flow/notes/plano.md'), 'Plano refeito');
  ok(flow(root, 'approve', '.agent-flow/notes/plano.md', 'Usuário aceitou o plano refeito'));
  assert.deepEqual(write('src/app.js'), {});
});
