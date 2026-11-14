import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const localEvidence = /^(?:\.agent-flow\/(?!\.gitignore$)|docs\/work\/)/i;
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
