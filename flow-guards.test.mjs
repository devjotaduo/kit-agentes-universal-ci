import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function start(root) {
  ok(run(root, process.execPath, [install, root]));
  ok(boot(root, 'git-init'));
  ok(git(root, 'config', 'user.name', 'Teste Agent Flow'));
  ok(git(root, 'config', 'user.email', 'agent-flow@example.invalid'));
  ok(git(root, 'config', 'commit.gpgsign', 'false'));
  ok(flow(root, 'new', 'fix', 'Teste de guardas'));
  ok(flow(root, 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b'));
  ok(flow(root, 'approve', note(root, 'plano'), 'Aceite de teste'));
  ok(flow(root, 'advance', 'discover', note(root, 'discover')));
}

function review(root) {
  ok(flow(root, 'record-parallel', 'review', 'parent', 'review-a', 'review-b'));
  return flow(root, 'advance', 'review', note(root, 'review'));
}

function patchDecision(root, session, ...lines) {
  const input = JSON.stringify({ cwd: root, session_id: session, hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } });
  const result = run(root, process.execPath, ['.codex/hooks/flow.mjs', 'hook'], { input });
  return JSON.parse(ok(result)).hookSpecificOutput?.permissionDecision;
}

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
