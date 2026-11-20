import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
const branch = 'fix/agenda';
const kitArgs = (...args) => ['.agent-kit/kit.mjs', '--client', 'codex', ...args];
const prArgs = ['git', 'pr', 'Corrige a agenda', '--body-file', 'README.md'];

function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function refused(result, reason) {
  assert.equal(result.status, 1, result.stdout || result.error?.message);
  assert.match(result.stderr, reason);
}

// O transporte Git usa um origin bare real. O preload substitui o gh e pode apresentar o origin como GitHub.
function project(t) {
  const temp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kit-worktree-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'principal');
  const bare = path.join(temp, 'remoto.git');
  const tree = path.join(root, '.claude', 'worktrees', 'fix-agenda');
  const mock = path.join(temp, 'gh.cjs');
  const calls = path.join(temp, 'gh.log');
  writeFileSync(mock, `const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command === 'git' && ['remote get-url origin', 'remote get-url --push origin'].includes(args.join(' ')) && process.env.KIT_TEST_GITHUB_URL) {
    return { status: 0, stdout: process.env.KIT_TEST_GITHUB_URL, stderr: '' };
  }
  if (command !== 'gh') return spawnSync(command, args, options);
  require('node:fs').appendFileSync(process.env.KIT_TEST_GH_LOG, JSON.stringify(args) + '\\n');
  if (args[0] === 'pr' && args[1] === 'list' && process.env.KIT_TEST_START_FLOW === '1') {
    const started = spawnSync(process.execPath, ['.agent-kit/kit.mjs', 'flow', 'new', 'fix', 'Nova tarefa durante a conferência'], options);
    if (started.status !== 0) throw Error(started.stderr || 'Falha ao iniciar a tarefa concorrente');
  }
  const commands = {
    'repo view': 'estavel',
    'pr create': 'https://github.com/exemplo/calendario/pull/42',
    'pr view': 'true',
    'pr list': process.env.KIT_TEST_GH_PULLS || '[]',
  };
  const stdout = commands[args.slice(0, 2).join(' ')];
  return { status: stdout === undefined ? 1 : 0, stdout: stdout || '', stderr: '' };
};
require('node:module').syncBuiltinESMExports();
`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(temp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', KIT_TEST_GH_LOG: calls, NODE_OPTIONS: '--require "' + mock.replaceAll('\\', '/') + '"' };
  const run = (dir, command, args, extraEnv = {}) => spawnSync(command, args,
    { cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...env, ...extraEnv } });
  const git = (dir, ...args) => ok(run(dir, 'git', args));
  const kit = (dir, ...args) => run(dir, process.execPath, kitArgs(...args));
  git(temp, 'init', '--bare', '-b', 'estavel', bare);
  git(temp, 'clone', bare, root);
  git(root, 'config', 'user.name', 'Teste');
  git(root, 'config', 'user.email', 'teste@example.invalid');
  ok(run(root, process.execPath, [install, root]));
  writeFileSync(path.join(root, 'README.md'), '# Projeto\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Projeto com kit instalado');
  git(root, 'push', '-u', 'origin', 'HEAD:estavel');
  git(root, 'remote', 'set-head', 'origin', 'estavel');
  const linked = () => {
    git(root, 'worktree', 'add', '-qb', branch, tree, 'origin/estavel');
    git(tree, 'branch', '--unset-upstream');
  };
  return { temp, root, bare, tree, calls, env, run, kit, git, linked };
}

test('worktree new cria da padrão atualizada do origin mesmo partindo de outra branch local', (t) => {
  const { root, tree, kit, git } = project(t);
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'outra');
  git(root, 'commit', '--allow-empty', '-qm', 'Mudança alheia');
  git(root, 'update-ref', '-d', 'refs/remotes/origin/estavel');
  ok(kit(root, 'worktree', 'new', branch));
  assert.equal(git(tree, 'rev-parse', 'HEAD'), base);
  assert.equal(git(tree, 'branch', '--show-current'), branch);
  assert.equal(git(root, 'branch', '--show-current'), 'outra');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('worktree new preserva branch existente, diretório ocupado e branches protegidas', (t) => {
  const { root, tree, kit, git } = project(t);
  git(root, 'push', 'origin', 'HEAD:refs/heads/so-no-origin');
  refused(kit(root, 'worktree', 'new', 'so-no-origin'), /branch/i);
  git(root, 'branch', 'existente');
  refused(kit(root, 'worktree', 'new', 'existente'), /branch/i);
  git(root, 'switch', '-qc', 'outra');
  git(root, 'branch', '-D', 'estavel');
  for (const name of ['main', 'release/2', 'estavel']) {
    refused(kit(root, 'worktree', 'new', name), /protegida|padrão/i);
  }
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, 'original'), 'preservado');
  refused(kit(root, 'worktree', 'new', branch), /pasta|diretório|caminho/i);
  assert.equal(readFileSync(path.join(tree, 'original'), 'utf8'), 'preservado');
  assert.equal(git(root, 'branch', '--list', branch), '');
});

test('git pr e issue recusam publicação na principal antes do gh, e issue permite prévia', (t) => {
  const { root, calls, kit, git } = project(t);
  refused(kit(root, ...prArgs), /worktree/i);
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/exemplo/calendario.git');
  const args = ['issue', 'exemplo/agenda', 'bug', 'Consulta de agenda falha', '--body', 'A consulta da agenda falha quando recebe uma data sem horário.'];
  assert.match(ok(kit(root, ...args, '--dry-run')), /exemplo\/agenda/);
  refused(kit(root, ...args), /worktree/i);
  assert.equal(existsSync(calls), false);
});

test('git pr recusa arquivos pendentes e plano incompleto antes de chamar gh', (t) => {
  const { tree, calls, git, kit, linked } = project(t);
  linked();
  git(tree, 'commit', '--allow-empty', '-qm', 'Primeira mudança');
  writeFileSync(path.join(tree, 'pendente'), 'trabalho em curso');
  refused(kit(tree, ...prArgs), /limpa|suja|pendente|mudança|alterações/i);
  rmSync(path.join(tree, 'pendente'));
  ok(kit(tree, 'flow', 'new', 'fix', 'Corrigir a agenda'));
  refused(kit(tree, ...prArgs), /ready|etapa|plano|fluxo/i);
  assert.equal(existsSync(calls), false);
});

test('git pr recusa branch com base compartilhada por uma linha divergente', (t) => {
  const { root, tree, calls, git, kit } = project(t);
  git(root, 'switch', '-qc', 'outra-tarefa');
  git(root, 'commit', '--allow-empty', '-qm', 'Primeiro commit da outra tarefa');
  git(root, 'worktree', 'add', '-qb', branch, tree, 'outra-tarefa');
  // A origem e a tarefa começam no mesmo HEAD.
  refused(kit(tree, ...prArgs), /outra-tarefa|criação da branch.*padrão/);
  git(root, 'commit', '--allow-empty', '-qm', 'Outro lado');
  git(tree, 'commit', '--allow-empty', '-qm', 'Esta tarefa');
  refused(kit(tree, ...prArgs), /outra-tarefa|criação da branch.*padrão/);
  git(root, 'switch', '-q', 'estavel');
  git(root, 'branch', '-D', 'outra-tarefa');
  refused(kit(tree, ...prArgs), /criação da branch.*padrão/);
  assert.equal(existsSync(calls), false);
});

test('git pr recusa o commit de outra branch trazido pela primeira entrega com merge --no-ff', (t) => {
  const { root, tree, calls, git, kit, linked } = project(t);
  linked();
  git(root, 'switch', '-qc', 'entrega-lateral');
  git(root, 'commit', '--allow-empty', '-qm', 'Mudança de outra entrega');
  git(tree, 'merge', '--no-ff', '-qm', 'Integra a entrega lateral', 'entrega-lateral');
  refused(kit(tree, ...prArgs), /entrega-lateral/);
  assert.equal(existsSync(calls), false);
});

test('git pr exige o registro de criação da branch mesmo quando a ref de origem já foi apagada', (t) => {
  const { root, tree, calls, git, kit } = project(t);
  git(root, 'switch', '-qc', 'outra-tarefa');
  git(root, 'commit', '--allow-empty', '-qm', 'Mudança de outra tarefa');
  git(root, 'worktree', 'add', '-qb', branch, tree, 'outra-tarefa');
  git(tree, 'commit', '--allow-empty', '-qm', 'Mudança desta tarefa');
  git(tree, 'reflog', 'delete', 'refs/heads/' + branch + '@{1}');
  git(root, 'switch', '-q', 'estavel');
  git(root, 'branch', '-D', 'outra-tarefa');
  refused(kit(tree, ...prArgs), /registro de criação da branch/);
  assert.equal(existsSync(calls), false);
});

test('worktree done protege a principal, trabalho pendente, tarefa ativa e commits apenas locais', (t) => {
  const { root, tree, kit, git, linked } = project(t);
  linked();
  refused(kit(root, 'worktree', 'done', root), /principal|ligada|vinculada/i);
  writeFileSync(path.join(tree, 'pendente'), 'alteração');
  refused(kit(root, 'worktree', 'done', tree), /limpa|suja|pendente|mudança|alterações/i);
  assert.equal(readFileSync(path.join(tree, 'pendente'), 'utf8'), 'alteração');
  rmSync(path.join(tree, 'pendente'));
  ok(kit(tree, 'flow', 'new', 'fix', 'Corrigir a agenda'));
  refused(kit(root, 'worktree', 'done', tree), /ativa|active|tarefa/i);
  assert.match(ok(kit(tree, 'flow', 'cancel', 'Validação concluída')), /worktree done <caminho>/);
  git(tree, 'commit', '--allow-empty', '-qm', 'Trabalho ainda local');
  refused(kit(root, 'worktree', 'done', tree), /commit|upstream|mesclad|origin/i);
  assert.equal(existsSync(tree), true);
  git(tree, 'push', '-u', 'origin', branch);
  ok(kit(root, 'worktree', 'done', tree));
  assert.equal(existsSync(tree), false);
});

test('worktree done valida o HEAD exato de PR mesclado quando a branch remota foi apagada', (t) => {
  const { root, tree, bare, calls, run, kit, git, linked } = project(t);
  linked();
  writeFileSync(path.join(tree, 'agenda'), 'mudança');
  git(tree, 'add', 'agenda');
  git(tree, 'commit', '-qm', 'Mudança da agenda');
  git(tree, 'push', '-u', 'origin', branch);
  const head = git(tree, 'rev-parse', 'HEAD');
  git(root, 'merge', '--squash', branch);
  git(root, 'commit', '-qm', 'PR integrado por squash');
  git(root, 'push', 'origin', 'estavel');
  git(root, 'push', 'origin', '--delete', branch);
  const url = 'https://github.com/exemplo/calendario.git';
  git(root, 'config', 'url.' + pathToFileURL(bare).href + '.insteadOf', url);
  git(root, 'remote', 'set-url', 'origin', url);
  const done = (oid, fork = false, githubUrl = url) => run(root, process.execPath, kitArgs('worktree', 'done', tree),
    { KIT_TEST_GITHUB_URL: githubUrl, KIT_TEST_GH_PULLS: JSON.stringify([{ headRefOid: oid, isCrossRepository: fork }]) });
  // O origin configurado parece GitHub, mas insteadOf redireciona para o bare local.
  refused(done(head, false, ''), /commit|upstream|mesclad|origin/i);
  assert.equal(existsSync(calls), false);
  refused(done(head, true), /commit|upstream|mesclad|origin/i);
  for (const oid of ['', head.slice(0, 8), git(root, 'rev-parse', 'HEAD')]) {
    refused(done(oid), /commit|upstream|mesclad|origin/i);
    assert.equal(existsSync(tree), true);
  }
  const duringLookup = run(root, process.execPath, kitArgs('worktree', 'done', tree), {
    KIT_TEST_GITHUB_URL: url, KIT_TEST_GH_PULLS: JSON.stringify([{ headRefOid: head, isCrossRepository: false }]),
    KIT_TEST_START_FLOW: '1',
  });
  refused(duringLookup, /tarefa ativa/i);
  assert.match(ok(kit(tree, 'flow', 'status')), /Nova tarefa durante a conferência/);
  ok(kit(tree, 'flow', 'cancel', 'Tarefa concorrente encerrada'));
  ok(done(head));
  assert.equal(existsSync(tree), false);
  assert.match(readFileSync(calls, 'utf8'), /"pr","list"/);
});

test('worktree done preserva arquivos ignorados do usuário e notas que ainda não têm cópia', (t) => {
  const { root, tree, kit, git, linked } = project(t);
  git(root, 'config', 'core.excludesFile', path.join(root, '.git', 'exclusoes'));
  writeFileSync(path.join(root, '.git', 'exclusoes'), '.env\n');
  linked();
  const env = path.join(tree, '.env');
  writeFileSync(env, 'DADO=SINTETICO\n');
  assert.equal(git(tree, 'status', '--porcelain'), '');
  refused(kit(root, 'worktree', 'done', tree), /arquivos ignorados.*\.env/i);
  assert.equal(readFileSync(env, 'utf8'), 'DADO=SINTETICO\n');
  rmSync(env);

  ok(kit(tree, 'flow', 'new', 'fix', 'Conferir cópia das notas'));
  const note = path.join(tree, '.agent-flow', 'notes', 'registro.md');
  mkdirSync(path.dirname(note), { recursive: true });
  writeFileSync(note, 'Nota original');
  ok(kit(tree, 'flow', 'cancel', 'Notas arquivadas'));
  writeFileSync(note, 'Nota alterada depois do cancel');
  refused(kit(root, 'worktree', 'done', tree), /arquivos ignorados.*registro\.md/i);
  assert.equal(readFileSync(note, 'utf8'), 'Nota alterada depois do cancel');
  writeFileSync(note, 'Nota original');
  ok(kit(root, 'worktree', 'done', tree));
  assert.equal(existsSync(tree), false);
});

test('git pr confere as evidências revisadas de uma tarefa em ready', (t) => {
  const { root, tree, calls, kit, run, git, linked } = project(t);
  linked();
  const flow = (...args) => ok(kit(tree, 'flow', ...args));
  const evidence = (name) => {
    const file = '.agent-flow/notes/' + name + '.md';
    mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
    writeFileSync(path.join(tree, file), 'Registro da ' + name);
    return file;
  };
  flow('new', 'fix', 'Corrigir a agenda');
  flow('record-parallel', 'discover', 'agenda', 'descoberta');
  flow('approve', evidence('plano'), 'Aceito no teste');
  flow('advance', 'discover', evidence('descoberta'));
  writeFileSync(path.join(tree, 'agenda'), 'alteração da agenda');
  flow('advance', 'implement', evidence('implementação'));
  git(tree, 'add', 'agenda');
  git(tree, 'commit', '-qm', 'Corrige a agenda');
  git(tree, 'push', '-u', 'origin', branch);
  // Outra tarefa nasceu do primeiro commit próprio. As duas branches avançaram depois.
  git(root, 'switch', '-qc', 'derivada', branch);
  git(root, 'commit', '--allow-empty', '-qm', 'Outra entrega');
  git(tree, 'commit', '--allow-empty', '-qm', 'Completa a entrega');
  flow('advance', 'validate', evidence('validação'));
  flow('record-parallel', 'review', 'agenda', 'revisao');
  flow('advance', 'review', evidence('revisão'));
  flow('check');
  refused(kit(tree, ...prArgs), /push|origin\/fix|remot[oa]/i);
  assert.equal(existsSync(calls), false);
  git(tree, 'push', 'origin', branch);
  const publish = () => run(tree, process.execPath, kitArgs(...prArgs), { KIT_TEST_GITHUB_URL: 'https://github.com/exemplo/calendario.git' });
  assert.match(ok(publish()), /calendario\/pull\/42/);
  const requests = readFileSync(calls, 'utf8');
  assert.match(requests, /"pr","create".*"--draft"/);
  writeFileSync(path.join(tree, 'agenda'), 'alteração posterior');
  git(tree, 'commit', '-qam', 'Mudança posterior à revisão');
  git(tree, 'push', 'origin', branch);
  const invalid = kit(tree, 'flow', 'check');
  assert.equal(invalid.status, 1);
  refused(publish(), /revis|snapshot|flow check|HEAD/i);
  assert.equal(readFileSync(calls, 'utf8'), requests);
});

test('listagem das worktrees ignora diretório e configuração Git herdados de outro repositório', (t) => {
  const { temp, root, tree, run, git, linked } = project(t);
  linked();
  const outro = path.join(temp, 'outro');
  git(temp, 'init', '-q', outro);
  const check = "import {worktrees} from './.codex/hooks/snapshot.mjs'; console.log(JSON.stringify(worktrees(process.cwd())));";
  const result = run(root, process.execPath, ['--input-type=module', '-e', check],
    { GIT_DIR: path.join(outro, '.git'), GIT_CONFIG_PARAMETERS: 'configuração não aplicável a este Git' });
  assert.deepEqual(JSON.parse(ok(result)).map((dir) => realpathSync.native(dir)), [root, tree]);
});
