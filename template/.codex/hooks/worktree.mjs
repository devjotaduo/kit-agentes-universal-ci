import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBranch, repoFromRemote } from './git-target.mjs';
import { realPath, worktreeEnv, worktrees } from './snapshot.mjs';

const usage = 'Use worktree new <branch> ou worktree done <caminho>.';

function run(cwd, command, args) {
  const env = worktreeEnv();
  delete env.GH_HOST;
  delete env.GH_REPO;
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024 });
}

function output(result) {
  if (result.status !== 0) throw Error(result.stderr?.trim() || result.error?.message || 'Falha ao conferir a worktree.');
  return result.stdout.trimEnd();
}

const git = (cwd, ...args) => output(run(cwd, 'git', args));
const same = (a, b) => path.relative(a, b) === '';

function present(file) {
  return Boolean(lstatSync(file, { throwIfNoEntry: false }));
}

export function isLinkedWorktree(root) {
  return worktrees(root).slice(1).some((tree) => same(tree, realPath(root)));
}

export function requireLinkedWorktree(root) {
  if (!isLinkedWorktree(root)) throw Error('O checkout principal não pode publicar esta entrega. Use worktree new <branch>.');
}

function clean(root) {
  if (git(root, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) {
    throw Error('A worktree tem mudanças pendentes. Confira git status.');
  }
}

// Consulta a referência simbólica no servidor: origin/HEAD pode continuar apontando para uma padrão antiga.
function originHeads(root) {
  const lines = git(root, 'ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*').split(/\r?\n/);
  const defaultBranch = lines.find((line) => line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD'))
    ?.slice('ref: refs/heads/'.length, -'\tHEAD'.length);
  if (!defaultBranch) throw Error('Não foi possível confirmar a branch padrão do origin.');
  const heads = new Map(lines.filter((line) => line.includes('\trefs/heads/')).map((line) => {
    const [oid, name] = line.split('\trefs/heads/');
    return [name, oid];
  }));
  return { defaultBranch, heads };
}

function fetchBranch(root, branch) {
  const ref = 'refs/remotes/origin/' + branch;
  git(root, 'fetch', '--no-tags', 'origin', '+refs/heads/' + branch + ':' + ref);
  return ref;
}

function newWorktree(root, branch) {
  const { defaultBranch, heads } = originHeads(root);
  checkBranch(branch, defaultBranch);
  git(root, 'check-ref-format', 'refs/heads/' + branch);
  if (heads.has(branch) || git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + branch)) {
    throw Error('Já existe uma branch com esse nome: ' + branch);
  }
  const [main] = worktrees(root);
  const folder = path.join(main, '.claude', 'worktrees');
  for (const dir of [path.dirname(folder), folder]) {
    if (present(dir) && !same(realPath(dir), dir)) throw Error('O destino da worktree passa por um link: ' + dir);
  }
  const dest = path.join(folder, branch.replaceAll('/', '-'));
  if (present(dest)) throw Error('Já existe uma pasta no destino: ' + dest);
  const base = fetchBranch(root, defaultBranch);
  mkdirSync(folder, { recursive: true });
  const relative = path.relative(main, dest).replaceAll('\\', '/') + '/';
  if (run(main, 'git', ['check-ignore', '-q', '--', relative]).status !== 0) {
    // Evita adicionar a worktree como repositório aninhado em um commit da principal.
    try { writeFileSync(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (run(main, 'git', ['check-ignore', '-q', '--', relative]).status !== 0) {
      throw Error('Inclua ' + relative + ' nas regras de exclusão do Git antes de criar a worktree.');
    }
  }
  git(root, 'worktree', 'add', '--no-track', '-b', branch, dest, base);
  console.log(dest);
}

function ancestor(root, first, second) {
  const result = run(root, 'git', ['merge-base', '--is-ancestor', first, second]);
  if (result.status === 1) return false;
  output(result);
  return true;
}

// Só o registro de criação atesta de onde saiu a ref. Um reflog truncado pode começar em qualquer commit.
function creation(root, ref) {
  const line = git(root, 'reflog', 'show', '--format=%H%x09%gs', ref).split('\n').at(-1);
  return /^([a-f0-9]+)\tbranch: Created from /.exec(line)?.[1];
}

function checkOrigin(root, branch, base) {
  const first = git(root, 'rev-list', '--topo-order', '--reverse', base + '..HEAD').split('\n')[0];
  if (!first) throw Error('A branch não tem commits próprios para abrir um PR.');
  const head = git(root, 'rev-parse', '--verify', 'HEAD');
  const own = 'refs/heads/' + branch;
  const ownRemote = 'refs/remotes/origin/' + branch;
  const refs = git(root, 'for-each-ref', '--contains=' + first, '--format=%(refname)%09%(objectname)',
    'refs/heads', 'refs/remotes/origin').split('\n');
  const started = creation(root, own);
  if (started && !ancestor(root, started, base)) {
    throw Error('O commit de criação da branch está fora da história da padrão do origin. Confira a origem da branch.');
  }
  for (const row of refs) {
    const [ref, tip] = row.split('\t');
    if (ref === own || ref === ownRemote || ref === 'refs/remotes/origin/HEAD') continue;
    if (tip !== head && ancestor(root, head, tip)) continue;
    // Uma branch local criada de um commit nosso pode ter divergido desde então.
    // Uma ref remota só herda essa evidência se tiver o mesmo tip que a local.
    const local = ref.replace(/^refs\/remotes\/origin\//, 'refs/heads/');
    const localTip = git(root, 'for-each-ref', '--format=%(objectname)', local);
    const cut = localTip === tip ? creation(root, local) : null;
    if (started && cut && ancestor(root, first, cut) && ancestor(root, cut, head)) continue;
    throw Error('O primeiro commit próprio também está em ' + ref + '. Confira a origem da branch.');
  }
}

export function guardPr(root) {
  requireLinkedWorktree(root);
  clean(root);
  const { defaultBranch } = originHeads(root);
  const branch = checkBranch(git(root, 'branch', '--show-current'), defaultBranch);
  git(root, 'fetch', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  checkOrigin(root, branch, 'refs/remotes/origin/' + defaultBranch);
  const head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  const result = run(root, process.execPath, [path.join(root, '.codex', 'hooks', 'flow.mjs'), 'check']);
  if (result.status !== 0) throw Error('flow check falhou: ' + (result.stderr?.trim() || result.error?.message || 'entrega pendente'));
  // gh pr create publica a ponta remota. Consulte-a depois do check, inclusive se a branch foi apagada.
  const remoteHead = git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/' + branch).split('\t')[0];
  if (remoteHead !== head || git(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== head
    || git(root, 'branch', '--show-current') !== branch) {
    throw Error('A revisão no origin não corresponde ao HEAD revisado. Confira a branch e faça git push antes do PR.');
  }
}

function hasMergedPr(root, branch, head) {
  const repo = repoFromRemote(git(root, 'remote', 'get-url', 'origin'));
  if (!repo || !branch || !head) return false;
  const result = run(root, 'gh', ['pr', 'list', '--repo', repo.full, '--state', 'merged', '--head', branch,
    '--json', 'headRefOid,isCrossRepository', '--limit', '1000']);
  return JSON.parse(output(result)).some((pr) => pr.isCrossRepository === false && pr.headRefOid === head);
}

function ensureRemovable(target) {
  if (present(path.join(target, '.agent-flow', 'active.json'))) throw Error('Há tarefa ativa na worktree. Conclua com flow close ou flow cancel.');
  clean(target);
}

function done(root, name) {
  const target = realPath(path.resolve(root, name));
  const [main, ...linked] = worktrees(root);
  if (!linked.some((tree) => same(tree, target))) throw Error('Indique a raiz de uma worktree ligada deste repositório.');
  if (linked.some((tree) => tree.startsWith(target + path.sep))) throw Error('O destino contém outra worktree ligada.');
  ensureRemovable(target);
  const branch = git(target, 'branch', '--show-current');
  const head = git(target, 'rev-parse', '--verify', 'HEAD^{commit}');
  const { defaultBranch, heads } = originHeads(target);
  const defaultRef = fetchBranch(target, defaultBranch);
  let saved = ancestor(target, head, defaultRef);
  // Só conta uma cópia que ainda existe no origin; a ref de rastreamento pode ter sobrado de um push antigo.
  if (!saved && branch) {
    const tracking = git(target, 'for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', 'refs/heads/' + branch);
    const [remote, ref] = tracking.split('\t');
    const upstream = ref?.replace(/^refs\/heads\//, '');
    if (remote === 'origin' && heads.has(upstream)) saved = ancestor(target, head, fetchBranch(target, upstream));
  }
  if (!saved && !hasMergedPr(target, branch, head)) {
    throw Error('Há commits fora da padrão e do upstream, sem PR mesclado no mesmo HEAD. A worktree foi mantida.');
  }
  // A consulta ao origin ou ao GitHub pode demorar. Confira de novo a revisão e a tarefa antes de remover.
  if (git(target, 'rev-parse', '--verify', 'HEAD^{commit}') !== head || git(target, 'branch', '--show-current') !== branch) {
    throw Error('A revisão da worktree mudou durante a conferência. Repita worktree done.');
  }
  ensureRemovable(target);
  git(main, 'worktree', 'remove', '--', target);
  console.log('Worktree removida: ' + target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const [command, arg, ...extra] = process.argv.slice(2);
    if (!arg || extra.length) throw Error(usage);
    if (command === 'new') newWorktree(root, arg);
    else if (command === 'done') done(root, arg);
    else throw Error(usage);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
