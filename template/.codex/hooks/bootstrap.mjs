import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicationFiles, realPath, validateInitialCommit } from './snapshot.mjs';
import { CONCORD, concordUpdateMessage, newer } from './update.mjs';

const root = realPath(fileURLToPath(new URL('../../', import.meta.url)));
const state = path.join(root, '.agent-flow', 'bootstrap.json');
const intentFile = path.join(root, '.agent-flow', 'publication-intent.json');
const concordPackage = CONCORD.package + '@' + CONCORD.version;

function exec(name, args, { inherit = false, env = process.env, timeout = 30000 } = {}) {
  // npm and Concord ship .cmd shims on Windows; this branch accepts only fixed tokens.
  const shim = process.platform === 'win32' && ['npm', 'concord'].includes(name);
  if (shim && args.some((a) => !/^[a-zA-Z0-9@./_-]+$/.test(a))) throw Error('Argumento inválido para shim.');
  return spawnSync(shim ? 'cmd.exe' : name,
    shim ? ['/d', '/c', name + '.cmd', ...args] : args,
    { cwd: root, env, encoding: 'utf8', timeout, windowsHide: true, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
}

function requireThat(ok, why) { if (!ok) throw Error(why); }

function result(name, args, options) {
  return checkedResult(exec(name, args, options), name);
}

function checkedResult(r, name) {
  if (r.error?.code === 'ETIMEDOUT') throw Error(name + ' excedeu o prazo. Confira o estado e execute novamente para retomar.');
  requireThat(r.status === 0, r.error?.message || r.stderr?.trim() || name + ' falhou; revise a saída.');
  return r.stdout?.trim() ?? '';
}

function concordCheck(install, configureCodex = true) {
  let r = exec('concord', ['--version']);
  const version = (output) => output?.trim().match(/^(?:v)?(\d+\.\d+\.\d+)$/)?.[1];
  let have = version(r.stdout);
  const upgrade = newer(CONCORD.version, have);
  if (r.status !== 0) {
    const missing = process.platform === 'win32'
      ? exec('where.exe', ['concord.cmd']).status === 1
      : r.error?.code === 'ENOENT';
    requireThat(missing, r.error?.message || r.stderr?.trim() || 'O Concord existe, mas não respondeu.');
    requireThat(install, 'Concord indisponível. Use node .agent-kit/kit.mjs setup para instalar.');
  } else {
    requireThat(have, 'Versão do Concord não reconhecida. Confira o executável com concord --version.');
    if (upgrade) {
      requireThat(install, concordUpdateMessage(have));
      console.log(concordUpdateMessage(have));
    }
  }
  if (r.status !== 0 || upgrade) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    requireThat(major > 22 || major === 22 && minor >= 12, 'Para instalar o Concord use Node.js 22.12 ou posterior.');
    result('npm', ['install', '-g', concordPackage], { inherit: true, timeout: 120000 });
    r = exec('concord', ['--version']);
    requireThat(r.status === 0, 'Pacote instalado, mas Concord não está no PATH. Reabra o terminal e verifique.');
    have = version(r.stdout);
    requireThat(have && !newer(CONCORD.version, have),
      'O executável do PATH ainda não atende ao mínimo ' + CONCORD.version + '. Confira a origem do comando concord.');
    console.log('Abra uma nova sessão para carregar o Concord atualizado antes de retomar a tarefa.');
  }
  console.log('Concord CLI: ' + r.stdout.trim());
  if (!configureCodex) return;
  const get = exec('codex', ['mcp', 'get', 'concord', '--json']);
  if (get.status !== 0) {
    requireThat(/No MCP server named 'concord' found/.test(get.stderr ?? ''),
      get.error?.message || get.stderr?.trim() || 'Não consegui verificar o MCP Concord.');
    requireThat(install, 'MCP Concord não cadastrado. Use node .agent-kit/kit.mjs --client codex setup.');
    result('codex', ['mcp', 'add', 'concord', '--', 'concord-mcp'], { inherit: true });
    console.log('MCP registrado; abra uma nova sessão Codex.');
  } else {
    requireThat(JSON.parse(get.stdout).enabled === true, 'MCP Concord cadastrado, mas desabilitado. Revise a configuração existente.');
    console.log('MCP Concord habilitado; confirme a conexão usando inspect_work nesta sessão.');
  }
}

function gitRoot() {
  const r = exec('git', ['rev-parse', '--show-toplevel']);
  if (r.status === 0) return realPath(r.stdout.trim());
  requireThat(/not a git repository/i.test(r.stderr ?? ''),
    r.error?.message || r.stderr?.trim() || 'Não consegui consultar o Git.');
  return null;
}

function saveMarker(marker) {
  const tmp = state + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmp, state);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function marker() {
  return existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : null;
}

function readIntent() {
  return existsSync(intentFile) ? JSON.parse(readFileSync(intentFile, 'utf8')) : null;
}

function reserveIntent(intent) {
  const tmp = intentFile + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(intent, null, 2) + '\n', { flag: 'wx' });
    try { linkSync(tmp, intentFile); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    rmSync(tmp, { force: true });
  }
  const saved = readIntent();
  requireThat(saved.repo === intent.repo && saved.branch === intent.branch && samePlan(saved.plan, intent.plan),
    'Já existe outra transação de publicação para este projeto.');
  return saved;
}

// O Concord Cloud grava .concord/cloud-agents/ em cada projeto, mas só o concord setup (que o kit não roda) cria o
// .concord/.gitignore. O kit cria o mesmo arquivo do Concord quando ele falta, sem editar um que já exista.
const concordIgnore = '# Created by concord setup. Keeps the local Concord workspace untracked.\n*\n';
function ignoreConcord() {
  // Só numa pasta .concord comum: se ela for link, junção ou arquivo, gravar o "*" ali esconderia do Git outra pasta.
  const folder = lstatSync(path.join(root, '.concord'), { throwIfNoEntry: false });
  if (folder && (folder.isSymbolicLink() || !folder.isDirectory())) {
    console.log('Aviso: .concord não é uma pasta comum; o kit não criou .concord/.gitignore. Confira o que ela é.');
    return;
  }
  const file = path.join(root, '.concord', '.gitignore');
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, concordIgnore, { flag: 'wx' });
  } else if (!entry.isFile() || !readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).includes('*')) {
    console.log('Aviso: .concord/.gitignore existe sem a regra *; confira se o estado local do Concord está fora do Git.');
  }
}

function init() {
  const current = gitRoot();
  const previous = marker();
  if (current) {
    requireThat(current === root, 'O projeto está dentro de outro repositório; use sua raiz.');
    if (previous?.initializing) saveMarker({ ...previous, initializing: false });
    ignoreConcord();
    console.log('Git já existe; preservado.');
    return;
  }
  mkdirSync(path.dirname(state), { recursive: true });
  requireThat(!previous || previous.createdByKit && previous.initializing, 'Há um registro Git anterior que precisa ser conferido.');
  const transaction = previous ?? { createdByKit: true, initializing: true, nonce: randomUUID() };
  if (!previous) writeFileSync(state, JSON.stringify(transaction, null, 2) + '\n', { flag: 'wx' });
  result('git', ['init', '-b', 'main']);
  saveMarker({ ...transaction, initializing: false });
  ignoreConcord();
  console.log('Git criado na raiz; publicação ainda não executada.');
}

function parseTarget(slug) {
  requireThat(/^[\w-]+\/[A-Za-z0-9_.-]+$/.test(slug ?? ''), 'Informe o GitHub como dono/repositorio.');
  return slug;
}

function remoteMatches(url, slug) {
  const candidates = [
    'https://github.com/' + slug, 'git@github.com:' + slug, 'ssh://git@github.com/' + slug,
  ];
  return candidates.some((value) => [value, value + '.git'].some((x) => x.toLowerCase() === url.toLowerCase()));
}

function currentHead() {
  const head = exec('git', ['rev-parse', '--verify', 'HEAD']);
  if (head.status === 0) return head.stdout.trim();
  requireThat(!head.error && head.status === 128, head.error?.message || 'Não foi possível consultar HEAD.');
  return null;
}

function reviewedPlan(headOrStage) {
  const args = ['.codex/hooks/flow.mjs', 'publication-plan'];
  if (headOrStage) args.push(headOrStage);
  return JSON.parse(result(process.execPath, args, { timeout: 45000 }));
}

function samePlan(a, b) {
  return a.tree === b.tree && JSON.stringify(a.files) === JSON.stringify(b.files);
}

function gitIndexIsEmpty() {
  return !result('git', ['ls-files', '--stage', '-z']);
}

function verifyRemotes(slug, allowOrigin) {
  const remotes = result('git', ['remote']).split(/\r?\n/).filter(Boolean);
  requireThat(!remotes.length || allowOrigin && remotes.length === 1 && remotes[0] === 'origin',
    'Remoto preexistente; o bootstrap não o substitui.');
  if (!remotes.length) return false;
  for (const args of [['remote', 'get-url', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
    const url = result('git', args);
    requireThat(remoteMatches(url, slug), 'Origin não aponta ao destino autorizado.');
  }
  return true;
}

function ensurePrivateRepo(slug, transaction, opt, network) {
  const description = 'Agent Flow bootstrap ' + transaction.nonce;
  const args = ['repo', 'view', slug, '--json', 'id,nameWithOwner,visibility,url,description'];
  let view = network('gh', args, opt);
  if (view.status !== 0) {
    requireThat(!transaction.remoteId && !view.error
      && /Could not resolve to a Repository|HTTP 404|repository not found/i.test(view.stderr ?? ''),
    view.error?.message || view.stderr?.trim() || 'Não foi possível verificar o destino GitHub.');
    // The unique description lets a retry distinguish our interrupted create from an unrelated repository.
    checkedResult(network('gh', ['repo', 'create', slug, '--private', '--description', description], opt), 'gh');
    view = network('gh', args, opt);
  }
  requireThat(view.status === 0, view.error?.message || view.stderr?.trim() || 'Não foi possível ler a privacidade.');
  const remote = JSON.parse(view.stdout);
  requireThat(remote.id && remote.visibility === 'PRIVATE' && remote.nameWithOwner.toLowerCase() === slug.toLowerCase()
    && (transaction.remoteId ? remote.id === transaction.remoteId : remote.description === description),
  'Privacidade ou identidade da transação não confirmada; push bloqueado.');
  return remote;
}

export function publish(slug, files, network = exec) {
  parseTarget(slug);
  let transaction = marker();
  requireThat(gitRoot() === root && transaction?.createdByKit === true && !transaction.initializing,
    'Publicação automática reservada a Git novo criado por node .agent-kit/kit.mjs setup.');
  const previous = readIntent() ?? transaction;
  requireThat(!previous.repo || previous.repo === slug, 'O destino já registrado é ' + previous.repo + '.');
  requireThat(!transaction.published, 'Repositório inicial já publicado; siga o fluxo Git normal.');
  const branch = result('git', ['symbolic-ref', '--short', 'HEAD']);
  requireThat(!previous.branch || previous.branch === branch, 'A branch inicial mudou. Volte à branch revisada.');
  let head = currentHead();
  requireThat(!head || previous.plan && (!transaction.head || transaction.head === head),
    'HEAD existente não corresponde ao commit preparado pelo bootstrap.');
  const plan = reviewedPlan(head ?? (previous.plan ? '--staged' : undefined));
  if (files.length) requireThat(JSON.stringify(publicationFiles(root, files)) === JSON.stringify(plan.files),
    'A seleção informada não corresponde à seleção revisada.');
  if (previous.plan) requireThat(samePlan(previous.plan, plan), 'O snapshot mudou durante a publicação.');
  else requireThat(gitIndexIsEmpty(), 'Já há arquivos no índice; revise antes de continuar.');
  verifyRemotes(slug, Boolean(transaction.remoteId));
  const intent = reserveIntent({ repo: slug, nonce: previous.nonce ?? randomUUID(), branch, plan });
  transaction = { ...marker(), ...intent };
  requireThat(!transaction.published, 'Repositório inicial já publicado; siga o fluxo Git normal.');
  saveMarker(transaction);
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
  const opt = { env };
  checkedResult(network('gh', ['auth', 'status', '--hostname', 'github.com'], opt), 'gh');
  if (!head) {
    if (gitIndexIsEmpty()) result('git', ['--literal-pathspecs', 'add', '--', ...plan.files]);
    requireThat(result('git', ['write-tree']) === plan.tree, 'O índice não contém exatamente o snapshot revisado.');
    result('git', ['diff', '--cached', '--check']);
    result('git', ['commit', '-m', 'chore: initialize project'], { inherit: true, timeout: 45000 });
    head = currentHead();
  }
  validateInitialCommit(root, head, plan.tree);
  requireThat(samePlan(plan, reviewedPlan(head)), 'O snapshot mudou após o commit.');
  transaction = { ...transaction, head };
  saveMarker(transaction);
  const remote = ensurePrivateRepo(slug, transaction, opt, network);
  transaction = { ...transaction, remoteId: remote.id };
  saveMarker(transaction);
  if (!verifyRemotes(slug, true)) {
    result('git', ['remote', 'add', 'origin', 'https://github.com/' + slug + '.git']);
  }
  verifyRemotes(slug, true);
  validateInitialCommit(root, head, plan.tree);
  requireThat(samePlan(plan, reviewedPlan(head)), 'O snapshot mudou antes do push.');
  // Use gh's credentials for this push only; do not modify Git's global configuration.
  checkedResult(network('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', 'origin', head + ':refs/heads/' + branch], { ...opt, inherit: true, timeout: 60000 }), 'git');
  result('git', ['config', 'branch.' + branch + '.remote', 'origin']);
  result('git', ['config', 'branch.' + branch + '.merge', 'refs/heads/' + branch]);
  saveMarker({ ...transaction, published: true });
  console.log(remote.url);
}

function main([command, ...args]) {
  if (command === 'check' && !args.length) concordCheck(false);
  else if (command === 'concord' && !args.length) concordCheck(true);
  else if (command === 'concord-portable' && !args.length) concordCheck(true, false);
  else if (command === 'git-init' && !args.length) init();
  else if (command === 'publish-private' && (args.length === 1 || args[1] === '--')) publish(args[0], args.slice(2));
  else {
    console.log('Uso: node .agent-kit/kit.mjs bootstrap check | concord | concord-portable | git-init | publish-private dono/repo [-- mesmos arquivos revisados]');
    if (command && !['--help', '-h'].includes(command)) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error('Bootstrap: ' + error.message);
    process.exitCode = 1;
  }
}
