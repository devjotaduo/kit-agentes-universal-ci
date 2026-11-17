// Abre uma issue no repositório do kit com uma sugestão, falha ou pedido de funcionalidade.
// Recusa texto com cara de segredo ou com caminho pessoal, e mostra issues parecidas antes de criar outra.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT } from './update.mjs';

const kinds = { bug: 'falha', melhoria: 'melhoria', funcionalidade: 'funcionalidade' };
const usage = 'Use feedback <bug|melhoria|funcionalidade> "<título>" (--body "<texto>" | --body-file <arquivo>) [--dry-run] [--force].';

const sensitiveKeys = 'password|passwd|pwd|senha|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key';
// Só o tipo do padrão aparece na recusa, nunca o trecho encontrado.
const secrets = [
  ['token do GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/],
  ['chave de API', /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{30,})/],
  ['JWT', /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/],
  ['cabeçalho de autorização', /\b(?:Bearer|Basic)\s+[\w.+/=-]{16,}/i],
  ['chave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // Chave sensível em atribuição, JSON ou YAML, seguida de : ou = e de um valor entre aspas (com espaços),
  // sem aspas, ou de um bloco YAML (| ou >). Na dúvida, recusa: o usuário pode reescrever sem o valor.
  ['senha ou segredo em texto', new RegExp('["\']?\\b(?:' + sensitiveKeys + ')\\b["\']?\\s*[:=]\\s*'
    + '(?:"[^"\\n]{4,}"|\'[^\'\\n]{4,}\'|[|>][-+]?\\s*$|[^\\s"\',}]{6,})', 'im')],
];
const personal = [/[a-z]:[\\/]+users[\\/]+[^\\/\s]+/i, /\/(?:home|Users)\/[^/\s]+/];

// Desfaz escapes \uXXXX de JSON antes de procurar, para "pass\u0077ord" não escapar.
const unescape = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

export function validate({ kind, title, body }) {
  if (!kinds[kind]) throw Error('Tipo inválido. ' + usage);
  if (typeof title !== 'string' || title.trim().length < 10 || title.length > 120) throw Error('O título deve ter de 10 a 120 caracteres.');
  if (typeof body !== 'string' || body.trim().length < 20 || body.length > 20000) throw Error('O corpo deve ter de 20 a 20000 caracteres.');
  for (const [name, pattern] of secrets) {
    if ([title, body].some((text) => pattern.test(text) || pattern.test(unescape(text)))) {
      throw Error('O texto parece conter ' + name + '. Remova antes de enviar.');
    }
  }
  if (personal.some((pattern) => pattern.test(title) || pattern.test(body))) {
    throw Error('O texto cita um caminho da pasta pessoal. Use caminhos relativos à raiz do projeto.');
  }
}

export function issue({ kind, title, body, client, origin }) {
  return {
    title: '[' + kinds[kind] + '] ' + title.trim(),
    body: body.trim() + '\n\n---\n' + (origin ? 'Aberta por um agente a partir do trabalho em ' + origin + ', com o Kit Universal '
      : 'Enviado pelo comando feedback do Kit Universal ') + KIT.version + (client ? ' (cliente ' + client + ')' : '') + '.\n',
  };
}

const gh = (args) => spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });

export function parseOptions(args, help = usage) {
  const [kind, title, ...rest] = args;
  const options = { kind, title, dryRun: false, force: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--dry-run') options.dryRun = true;
    else if (rest[i] === '--force') options.force = true;
    else if (rest[i] === '--body' && rest[i + 1] !== undefined) options.body = rest[++i];
    else if (rest[i] === '--body-file' && rest[i + 1] !== undefined) {
      // Sem o caminho nem o erro bruto na mensagem: o caminho pode ser pessoal.
      try { options.body = readFileSync(rest[++i], 'utf8'); } catch { throw Error('Não foi possível ler o arquivo do corpo.'); }
    }
    else throw Error(help);
  }
  return options;
}

// Título comparável: sem o prefixo [tipo], sem acento, sem diferença de caixa e de espaços.
const normalTitle = (text) => String(text).replace(/^\s*\[[^\]]*\]\s*/, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// Issues abertas parecidas. A busca do GitHub demora a indexar uma issue nova (no piloto, duas iguais seguidas
// passaram), então a lista recente das abertas, que não depende do índice, também é comparada pelo título.
export function findSimilar(repo, searchTitle, run = gh) {
  const fail = () => { throw Error('Não foi possível consultar as issues de ' + repo + '. Confira gh auth status e o acesso.'); };
  const recent = run(['issue', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title,url', '--limit', '100']);
  const search = run(['issue', 'list', '--repo', repo, '--state', 'open', '--search', searchTitle.trim() + ' in:title',
    '--json', 'number,title,url', '--limit', '5']);
  if (recent.status !== 0 || search.status !== 0) fail();
  const wanted = normalTitle(searchTitle);
  const found = new Map();
  for (const item of JSON.parse(recent.stdout || '[]')) {
    const title = normalTitle(item.title);
    if (title === wanted || title.includes(wanted) || wanted.includes(title)) found.set(item.number, item);
  }
  for (const item of JSON.parse(search.stdout || '[]')) found.set(item.number, item);
  return [...found.values()];
}

// Mostra issues abertas parecidas e só cria com --force; o corpo vai por arquivo temporário, sem passar pelo shell.
export function publish(repo, draft, searchTitle, force) {
  const similar = findSimilar(repo, searchTitle);
  if (similar.length && !force) {
    console.log('Issues abertas parecidas; comente numa delas ou repita com --force:');
    for (const item of similar) console.log('#' + item.number + ' ' + item.title + ' ' + item.url);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-feedback-'));
  try {
    writeFileSync(path.join(dir, 'body.md'), draft.body);
    const created = gh(['issue', 'create', '--repo', repo, '--title', draft.title, '--body-file', path.join(dir, 'body.md')]);
    if (created.status !== 0) throw Error('O GitHub recusou a issue. Confira gh auth status e o acesso a ' + repo + '.');
    console.log(created.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(args) {
  const options = parseOptions(args);
  validate(options);
  const draft = issue({ ...options, client: process.env.AGENT_KIT_CLIENT });
  if (options.dryRun) {
    console.log('Repositório: ' + KIT.repository + '\nTítulo: ' + draft.title + '\n\n' + draft.body);
    return;
  }
  publish(KIT.repository, draft, options.title, options.force);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
