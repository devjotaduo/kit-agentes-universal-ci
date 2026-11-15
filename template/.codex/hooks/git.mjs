// Commit, push e PR seguros para a condução autônoma: o projeto libera estes comandos, e não o git e o gh crus.
// commit: só os arquivos nomeados, um a um, sem opções do git, sem link, sem arquivo ignorado ou com nome de segredo.
// push: só a branch atual, para a mesma branch no origin, sem força nem tags, nunca na padrão ou numa protegida.
// pr: sempre em rascunho, conferido depois de criado.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'Use git commit "<mensagem>" -- <arquivos> | git push | git pr "<título>" --body-file <arquivo.md> [--base <branch>].';
export const protectedBranches = ['main', 'master', 'develop', 'production', 'prod', 'release', 'staging', 'trunk'];
// Nomes que costumam guardar segredo. Para versionar um deles, o usuário faz o commit.
const secretName = /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519|ecdsa)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/i;

// O gh não pode ser redirecionado para outro repositório pelo ambiente.
const env = { ...process.env };
delete env.GH_REPO;
delete env.GH_HOST;
const run = (command, args, options = {}) => spawnSync(command, args,
  { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, env, ...options });
const out = (command, args) => {
  const result = run(command, args);
  return result.status === 0 ? result.stdout.trim() : null;
};

// Dono e nome de um remoto do GitHub, só com o host exatamente github.com, em https ou ssh.
export function repoFromRemote(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  const match = text.match(/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9][\w.-]{0,38})\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], name: match[2], full: match[1] + '/' + match[2] } : null;
}

export function checkBranch(branch, defaultBranch) {
  if (!branch || !/^[\w./-]{1,200}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw Error('Branch atual inválida para push.');
  }
  if (!defaultBranch) throw Error('Não foi possível confirmar a branch padrão do origin. Push fica com o usuário.');
  const base = branch.toLowerCase();
  if (base === defaultBranch.toLowerCase() || protectedBranches.includes(base) || /^release\//.test(base)) {
    throw Error('A branch ' + branch + ' é a padrão ou protegida: crie uma branch de trabalho. Push nela fica com o usuário.');
  }
  return branch;
}

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

function inspectFile(rel) {
  const full = path.join(root, rel);
  let info;
  try { info = lstatSync(full); } catch {
    if (out('git', ['--literal-pathspecs', 'ls-files', '--', rel])) return;
    throw Error('Arquivo não existe: ' + rel);
  }
  if (info.isSymbolicLink()) throw Error('O arquivo ' + rel + ' é um link. Esse commit fica com o usuário.');
  if (info.isDirectory()) throw Error('Nomeie arquivos, não pastas: ' + rel);
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
  const files = checkCommit(args[0], args.slice(2));
  const git = (rest) => run('git', ['--literal-pathspecs', ...rest], { stdio: 'inherit' }).status === 0;
  if (!git(['add', '--', ...files])) throw Error('git add falhou.');
  if (!git(['commit', '-m', args[0].trim(), '--', ...files])) throw Error('git commit falhou.');
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
