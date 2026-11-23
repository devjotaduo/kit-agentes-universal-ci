// Commit, push e PR seguros para a condução autônoma: o projeto libera estes comandos, e não o git e o gh crus.
// commit: só os arquivos nomeados, um a um, sem opções do git, sem link, sem arquivo ignorado ou com nome de segredo.
// push: só a branch atual, para a mesma branch no origin, sem força nem tags, nunca na padrão ou numa protegida.
// pr: sempre em rascunho, conferido depois de criado.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { worktreeEnv } from './snapshot.mjs';
import { guardPr } from './worktree.mjs';
import { checkBranch, repoFromRemote } from './git-target.mjs';

export { checkBranch, protectedBranches, repoFromRemote } from './git-target.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'Use git commit "<mensagem>" -- <arquivos> | git push | git pr "<título>" --body-file <arquivo.md> [--base <branch>].';
// Nomes que costumam guardar segredo. Para versionar um deles, o usuário faz o commit.
const secretName = /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

// O gh não pode ser redirecionado para outro repositório pelo ambiente.
const env = worktreeEnv();
delete env.GH_REPO;
delete env.GH_HOST;
const run = (command, args, options = {}) => spawnSync(command, args,
  { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, env, ...options });
const out = (command, args) => {
  const result = run(command, args);
  return result.status === 0 ? result.stdout.trim() : null;
};

// Repositório para onde o push vai de fato (url de push do origin), que precisa ser o mesmo do origin;
// a padrão é consultada no GitHub para esse repositório, sem referência local.
function pushTarget() {
  const fetchRepo = repoFromRemote(out('git', ['remote', 'get-url', 'origin']));
  const pushRepo = repoFromRemote(out('git', ['remote', 'get-url', '--push', 'origin']));
  if (!fetchRepo || !pushRepo || fetchRepo.full.toLowerCase() !== pushRepo.full.toLowerCase()) {
    throw Error('O origin não aponta para um único repositório do GitHub. Push fica com o usuário.');
  }
  const main = out('gh', ['repo', 'view', pushRepo.full, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
  return { repo: pushRepo.full, main: main || null };
}

// Cada nome precisa ser um arquivo comum do projeto, sem link (simbólico ou físico), ou um arquivo rastreado
// que foi apagado. Pasta e curinga não valem: o commit leva exatamente o que foi nomeado.
export function checkCommit(message, files, inspect = inspectFile) {
  if (typeof message !== 'string' || message.trim().length < 5 || message.startsWith('-')) throw Error('Mensagem de commit inválida.');
  if (!files.length) throw Error('Diga os arquivos depois de --.');
  return files.map((file) => {
    if (/[*?[\]{}]/.test(file) || file.startsWith(':') || file.startsWith('-')) throw Error('Nomeie arquivos, sem curinga nem opção: ' + file);
    const rel = path.relative(root, path.resolve(root, file)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Arquivo fora do projeto: ' + file);
    if (secretName.test(rel)) throw Error('O arquivo ' + rel + ' tem nome de segredo. Esse commit fica com o usuário.');
    inspect(rel);
    return rel;
  });
}

// No Windows o Git pode devolver a caixa original do caminho no disco.
const pathKey = (file) => process.platform === 'win32' ? file.toLowerCase() : file;

function listedPath(args, rel) {
  const result = run('git', ['--literal-pathspecs', ...args, '--', rel]);
  return result.status === 0 && result.stdout.split('\0').some((file) => pathKey(file) === pathKey(rel));
}

function inspectFile(rel) {
  const full = path.join(root, rel);
  let info;
  try { info = lstatSync(full); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    // Um pathspec de diretório também lista seus filhos. Só o nome completo pode ser selecionado.
    if (listedPath(['ls-files', '-z'], rel)
      || listedPath(['diff', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z'], rel)) return 'removed';
    throw Error('Arquivo não existe: ' + rel);
  }
  if (info.isSymbolicLink()) throw Error('O arquivo ' + rel + ' é um link. Esse commit fica com o usuário.');
  if (info.isDirectory()) {
    // Diz o que há para commitar na pasta, para o próximo comando sair certo.
    const changed = (run('git', ['--literal-pathspecs', 'status', '--porcelain', '--no-renames', '--untracked-files=all', '-z', '--', rel]).stdout ?? '')
      .split('\0').filter(Boolean).map((line) => line.slice(3));
    throw Error('Nomeie arquivos, não pastas: ' + rel + (changed.length ? '. Alterados nela: ' + changed.slice(0, 8).join(', ')
      + (changed.length > 8 ? ' e mais ' + (changed.length - 8) : '') : '') + '.');
  }
  if (!info.isFile()) throw Error('Não é um arquivo comum: ' + rel);
  if (info.nlink > 1) throw Error('O arquivo ' + rel + ' tem outro nome no disco (link físico). Esse commit fica com o usuário.');
  const real = path.relative(realpathSync(root), realpathSync(full));
  if (real.startsWith('..') || path.isAbsolute(real)) throw Error('O arquivo ' + rel + ' fica fora do projeto. Esse commit fica com o usuário.');
  if (run('git', ['--literal-pathspecs', 'check-ignore', '-q', '--', rel]).status === 0) {
    throw Error('O arquivo ' + rel + ' é ignorado pelo Git. Esse commit fica com o usuário.');
  }
}

function commit(args) {
  if (args.indexOf('--') !== 1) throw Error(usage);
  const removed = new Set();
  const files = checkCommit(args[0], args.slice(2), (file) => {
    if (inspectFile(file) === 'removed') removed.add(file);
  });
  // A saída segue para o terminal; na falha, a causa vai junto do erro: a última linha fatal:/error: do Git
  // (depois dela o Git costuma imprimir dicas), ou a última linha.
  const git = (step, rest) => {
    // Entrada e saída do Git (e dos hooks de commit) seguem no terminal; só o stderr é capturado, para achar a causa.
    const result = run('git', ['--literal-pathspecs', ...rest], { stdio: ['inherit', 'inherit', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    process.stderr.write(result.stderr ?? '');
    const lines = (result.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const cause = lines.findLast((line) => /^(?:fatal|error):/.test(line)) ?? lines.at(-1) ?? result.error?.message;
    if (result.status !== 0) throw Error('git ' + step + ' falhou' + (cause ? ': ' + cause : '.'));
  };
  // Arquivos que já estavam no índice antes (por quem chamou) ficam como estão se o commit falhar.
  // Se a consulta falhar, nada é desfeito. --no-renames inclui os dois caminhos de uma renomeação preparada.
  // Sem trim: um nome que começa ou termina com espaço precisa casar.
  const query = run('git', ['--literal-pathspecs', 'diff', '--cached', '--no-renames', '--name-only', '-z', '--', ...files]);
  const cached = query.status === 0 ? query.stdout : null;
  const staged = new Set((cached ?? '').split('\0').filter(Boolean).map(pathKey));
  // O Git seleciona as remoções diretamente no commit. Prepará-las antes pode perder o blob que já estava no índice
  // se o commit falhar, ou recusar um caminho que já foi removido do índice.
  const needsAdd = files.filter((file) => !removed.has(file));
  const added = cached === null ? [] : needsAdd.filter((file) => !staged.has(pathKey(file)));
  if (needsAdd.length) git('add', ['add', '--', ...needsAdd]);
  try { git('commit', ['commit', '-m', args[0].trim(), '--', ...files]); } catch (error) {
    // Sem desfazer, o índice ficaria com os arquivos adicionados e um commit seguinte levaria o que não foi pedido.
    if (added.length) run('git', ['--literal-pathspecs', 'reset', '-q', '--', ...added]);
    throw Error(error.message + explainFailure(error.message) + (cached === null ? ' Não foi possível ler o índice antes do add, então ele não foi desfeito: confira git status.'
      : added.length ? ' O índice foi desfeito (' + added.length + ' arquivo(s) tirados do stage); nada foi commitado.' : ''));
  }
}

// Falta de identidade é a causa mais comum num projeto novo, e o cliente pode não deixar rodar git config.
export function explainFailure(message) {
  return /empty ident|ident(?:ity)? unknown|unable to auto-detect|no (?:name|email) was given|user\.(?:name|email)/i.test(message)
    ? ' Defina a identidade do Git neste repositório e repita: git config user.name "<nome>" e git config user.email "<email>"'
      + ' (--global vale para todos os repositórios). Se o cliente pedir aprovação para git config, peça ao usuário.'
    : '';
}

function push() {
  const target = pushTarget();
  const branch = checkBranch(out('git', ['branch', '--show-current']), target.main);
  const result = run('git', ['push', '--no-follow-tags', '-u', 'origin', 'refs/heads/' + branch + ':refs/heads/' + branch],
    { stdio: 'inherit', timeout: 300000 });
  if (result.status !== 0) throw Error('O push falhou.');
}

function pr(args) {
  const [title, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--body-file', '--base'].includes(rest[i]) || rest[i + 1] === undefined) throw Error(usage);
    options[rest[i]] = rest[i + 1];
  }
  if (typeof title !== 'string' || title.trim().length < 5 || title.startsWith('-')) throw Error('Título inválido. ' + usage);
  if (!options['--body-file']) throw Error(usage);
  try { readFileSync(options['--body-file'], 'utf8'); } catch { throw Error('Não foi possível ler o arquivo do corpo.'); }
  guardPr(root);
  const target = pushTarget();
  const branch = checkBranch(out('git', ['branch', '--show-current']), target.main);
  const base = options['--base'] ?? target.main;
  if (!/^[\w./-]{1,200}$/.test(base) || base.startsWith('-')) throw Error('Base inválida.');
  const created = run('gh', ['pr', 'create', '--repo', target.repo, '--draft', '--title', title.trim(),
    '--body-file', options['--body-file'], '--base', base, '--head', branch]);
  if (created.status !== 0) throw Error('O GitHub recusou o PR. Confira gh auth status e se o push foi feito.');
  const url = created.stdout.trim().split(/\s+/).pop();
  const state = out('gh', ['pr', 'view', url, '--json', 'isDraft', '--jq', '.isDraft']);
  if (state !== 'true') throw Error('O PR foi criado mas não está em rascunho: ' + url + '. Converta com gh pr ready --undo.');
  console.log(url);
}

function main([command, ...args]) {
  if (command === 'commit') commit(args);
  else if (command === 'push' && !args.length) push();
  else if (command === 'pr') pr(args);
  else throw Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
