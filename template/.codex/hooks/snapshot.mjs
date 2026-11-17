import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// .concord/ é o estado local que o Concord Cloud grava em cada projeto (identificadores da máquina e do agente):
// fica fora do snapshot e da trava do commit, como a evidência local.
// Sem caixa só para .agent-flow e docs/work, como antes; .concord/ com caixa exata, porque .Concord/ num sistema
// que diferencia maiúsculas é outra pasta, de produto.
const concordState = (name) => name.startsWith('.concord/');
const localEvidence = { test: (name) => /^(?:\.agent-flow\/(?!\.gitignore$)|docs\/work\/)/i.test(name) || concordState(name) };
const sensitive = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|id_(?:rsa|ed25519)$|credentials[^/]*$)|\.(?:pem|key|pfx|p12)$/i;

function git(root, args, { env = process.env, allowMissing = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 15000,
    maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.status === 0) return result.stdout;
  if (allowMissing && !result.error && result.status === 128) return null;
  throw new Error(result.error?.message || result.stderr?.trim() || 'Falha ao capturar o estado Git.');
}

// Caminho real com os nomes curtos do Windows (PASTA-~1) expandidos, para bater com a raiz que o Git informa.
// A resolução nativa falha em alguns sistemas de arquivos (disco em memória, certas unidades de rede);
// neles vale a resolução em JS, como era antes.
export function realPath(target) {
  try { return realpathSync.native(target); } catch { return realpathSync(target); }
}

// Worktrees do repositório, a principal primeiro, como o Git lista; fora do Git, nenhuma.
// Num projeto Git em que a lista falha, lança: quem depende dela para proteger as worktrees falha fechado.
export function worktrees(root) {
  try {
    return git(root, ['worktree', 'list', '--porcelain']).split('\n')
      .filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice(9)));
  } catch {
    let gitProject = existsSync(path.join(root, '.git'));
    try { gitProject ||= git(root, ['rev-parse', '--show-toplevel'], { allowMissing: true }) !== null; } catch { /* sem Git */ }
    if (!gitProject) return [];
    throw new Error('Não foi possível listar as worktrees do repositório com git worktree list.');
  }
}

// Outras worktrees do mesmo repositório que têm o caminho relativo rel.
export function worktreesWith(root, rel) {
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return [];
  try {
    return worktrees(root).filter((dir) => path.relative(dir, realPath(root)) !== '' && existsSync(path.join(dir, rel)));
  } catch { return []; }
}

// Texto para um caminho que não existe nesta raiz: diz onde ele está, se estiver em outra worktree.
export function missingHere(root, rel, what) {
  const elsewhere = worktreesWith(root, rel);
  return what + ' não existe em ' + root + '.' + (elsewhere.length
    ? ' Existe em ' + elsewhere.slice(0, 5).join(', ') + ': rode o comando nessa worktree.'
    : ' Confira se a sessão está na worktree da tarefa.');
}

export function projectPath(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || /[\\:\x00-\x1f]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'
      || process.platform === 'win32' && /[. ]$/.test(part))) {
    throw new Error('Use caminhos de arquivos relativos à raiz, com barras /.');
  }
  return path.join(root, ...name.split('/'));
}

function validateAncestors(root, name, { allowLeafLink = false } = {}) {
  const absolute = projectPath(root, name);
  const segments = name.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let entry;
    try { entry = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (entry.isSymbolicLink() && !(allowLeafLink && index === segments.length - 1)) {
      throw new Error('Links não são permitidos neste destino: ' + name);
    }
  }
  return absolute;
}

export function validatePatchPath(root, name) {
  return validateAncestors(root, name);
}

export function publicationFiles(root, files) {
  if (!files.length || new Set(files).size !== files.length) {
    throw new Error('Forneça a seleção explícita de arquivos, sem repetições.');
  }
  return files.map((name) => {
    const absolute = validateAncestors(root, name);
    if (!lstatSync(absolute).isFile() || localEvidence.test(name) && !name.startsWith('docs/work/')
      || sensitive.test(name) && !/(?:^|\/)\.env\.example$/i.test(name)) {
      throw new Error('Arquivo local ou potencialmente sensível na seleção: ' + name);
    }
    return name;
  }).sort();
}

function isProjectGit(root) {
  const raw = git(root, ['rev-parse', '--show-toplevel'], { allowMissing: true });
  return raw !== null && realPath(raw.trim()) === root;
}

function plainFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = relative ? relative + '/' + entry.name : entry.name;
    if (entry.name === '.git' || localEvidence.test(file + (entry.isDirectory() ? '/' : ''))) return [];
    return entry.isDirectory() ? plainFiles(root, file) : [file];
  });
}

function fingerprint(root, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    const file = validateAncestors(root, name, { allowLeafLink: true });
    let entry;
    try { entry = lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    hash.update(JSON.stringify([name, entry ? entry.mode & 0o170111 : null]) + '\n');
    if (entry?.isFile()) hash.update(createHash('sha256').update(readFileSync(file)).digest());
    else if (entry?.isSymbolicLink()) hash.update(createHash('sha256').update(readlinkSync(file)).digest());
    else if (entry) throw new Error('Snapshot não cobre arquivo especial ou submódulo: ' + name);
  }
  return hash.digest('hex');
}

function selectionTree(root, selection) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-flow-index-'));
  const index = path.join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(root, ['--literal-pathspecs', 'add', '--', ...selection], { env });
    const actual = git(root, ['ls-files', '-z'], { env }).split('\0').filter(Boolean).sort();
    if (JSON.stringify(actual) !== JSON.stringify(selection)) {
      throw new Error('O conteúdo selecionado para publicação não coincide com a lista revisada.');
    }
    return git(root, ['write-tree'], { env }).trim();
  } finally {
    rmSync(index, { force: true });
    rmSync(index + '.lock', { force: true });
    rmdirSync(dir);
  }
}

// Evidência que pode ser preparada ou commitada depois da revisão: Markdown em docs/work/ e notas do fluxo, também em Markdown.
// Mais estreita que localEvidence e sensível a maiúsculas: Docs/Work/x.js ou docs/work/.env são produto.
const versionedEvidence = (name) => /^docs\/work\/.+\.md$/.test(name) || /^\.agent-flow\/.+\.md$/.test(name);

// Índice sem as linhas de evidência; com -z o Git não põe aspas e o primeiro tab separa o caminho.
function productIndex(listing) {
  const lines = listing.split('\0').filter((line) => line && !versionedEvidence(line.slice(line.indexOf('\t') + 1)));
  return createHash('sha256').update(lines.join('\0')).digest('hex');
}

// Sem objetos substitutos (git replace): o push manda os commits reais, e são eles que precisam ser conferidos.
const realObjects = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };

const isAncestor = (root, older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer],
  { cwd: root, env: realObjects, windowsHide: true, timeout: 15000 }).status === 0;

// Os commits feitos depois de base (ou todos, se base é null) só mudam evidência, inclusive os intermediários.
// Um merge também vale quando só difere em evidência de um pai que é base ou descende dele: é o merge do próprio PR,
// que não traz produto novo. O que chega pelo outro pai são commits do intervalo, conferidos um a um.
// shortcut: squash e rebase trocam o commit validado por outro e continuam recusados; aceitar exige conferir o PR no gh.
export function evidenceOnlySince(root, base) {
  if (base && !isAncestor(root, base, 'HEAD')) return false;
  const range = base ? base + '..HEAD' : 'HEAD';
  const names = (args) => git(root, [...args, '--no-renames', '--name-only', '-z'], { env: realObjects })
    .split('\0').filter(Boolean);
  if (names(['log', '-m', '--format=', range]).every(versionedEvidence)) return true;
  if (!base || !names(['log', '--no-merges', '--format=', range]).every(versionedEvidence)) return false;
  return git(root, ['rev-list', '--merges', '--parents', range], { env: realObjects }).split('\n').filter(Boolean)
    .every((line) => {
      const [merge, ...parents] = line.split(' ');
      return parents.some((parent) => isAncestor(root, base, parent)
        && names(['diff', parent, merge]).every(versionedEvidence));
    });
}

// Arquivos de produto ainda não commitados (no índice, alterados ou novos); fora do Git, null.
// Evidência em Markdown fica de fora: é a única coisa que pode ser commitada depois da revisão.
function uncommitted(root) {
  if (!isProjectGit(root)) return null;
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).split('\0')
    .filter(Boolean).map((entry) => entry.slice(3));
}

export function uncommittedProduct(root) {
  return uncommitted(root)?.filter((name) => !versionedEvidence(name) && !concordState(name)) ?? null;
}

// Evidência em Markdown de docs/work/ ainda fora de commit: o close avisa, porque ela some com a worktree.
export function uncommittedWork(root) {
  return (uncommitted(root) ?? []).filter((name) => /^docs\/work\/.+\.md$/.test(name));
}

export function captureSnapshot(root, selection = [], options = {}) {
  const gitProject = isProjectGit(root);
  if (selection.length && !gitProject) throw new Error('Seleção para publicação exige Git na raiz do projeto.');
  const source = gitProject
    ? git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    : plainFiles(root);
  const names = [...new Set([...source.filter((file) => file && !localEvidence.test(file)), ...selection])].sort();
  return {
    files: fingerprint(root, names),
    head: gitProject ? git(root, ['rev-parse', '--verify', 'HEAD'], { allowMissing: true })?.trim() ?? null : null,
    index: gitProject
      ? createHash('sha256').update(git(root, ['ls-files', '--stage', '-z'])).digest('hex')
      : null,
    productIndex: gitProject ? productIndex(git(root, ['ls-files', '--stage', '-z'])) : null,
    publication: selection.length
      ? { files: publicationFiles(root, selection), tree: options.useTree ?? selectionTree(root, selection) }
      : null,
  };
}

export function validateInitialCommit(root, head, tree) {
  if (git(root, ['rev-list', '--parents', '-n', '1', head]).trim().split(' ').length !== 1
    || git(root, ['show', '-s', '--format=%T', head]).trim() !== tree) {
    throw new Error('O commit inicial não contém exatamente o snapshot revisado.');
  }
  if (git(root, ['write-tree']).trim() !== tree) {
    throw new Error('O índice contém alterações fora do snapshot revisado.');
  }
}
