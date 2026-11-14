// Busca e instala skills pela CLI "skills" (a mesma do find-skills), com as regras do kit:
// instalação só no projeto, arquivos copiados para revisão, exatamente uma skill e fonte confiável ou aprovada.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'Use skills find <termos> | skills list | skills add <dono/repositorio@skill> [--fonte-aprovada "<registro do aceite>"].';
// Versão da CLI cujo comportamento o kit conferiu. Subir só depois de rever --copy, --skill e --list.
export const cli = 'skills@1.8.1';

// Donos aceitos sem perguntar. O projeto pode trocar a lista em .agent-kit/skills-sources.json: { "trusted": [...] }.
export const defaultTrusted = ['anthropics', 'openai', 'vercel-labs', 'mattpocock', 'microsoft', 'google', 'github', 'supabase', 'stripe'];
// Clientes que o kit suporta, nos nomes da CLI. Sem esta lista a CLI copia a skill para todo cliente que detectar
// na máquina (no piloto, sete pastas, quatro delas fora das previstas abaixo).
export const kitAgents = ['claude-code', 'codex', 'antigravity-cli', 'hermes-agent'];

// Entradas da raiz do projeto, para apontar pasta que a instalação crie fora das previstas.
export const topLevel = (dir = root) => {
  try { return new Set(readdirSync(dir)); } catch { return new Set(); }
};

// Pastas onde a CLI grava skills de projeto, conforme o cliente. Nenhuma pode ser link para fora do projeto.
export const destinations = ['.agents', '.agents/skills', '.claude', '.claude/skills', '.codex', '.codex/skills',
  '.gemini', '.gemini/skills', '.cursor', '.cursor/skills', '.windsurf', '.windsurf/skills', '.hermes', '.hermes/skills',
  '.github', '.github/skills', 'skills'];

export function trustedOwners(dir = root) {
  try {
    const list = JSON.parse(readFileSync(path.join(dir, '.agent-kit', 'skills-sources.json'), 'utf8')).trusted;
    if (Array.isArray(list) && list.every((item) => typeof item === 'string')) return list.map((item) => item.toLowerCase());
  } catch { /* usa a lista padrão */ }
  return defaultTrusted;
}

// Validação na fronteira: estes valores vão para a linha de comando do npx.
export function validateAdd(pkg, skill, trusted, approval) {
  const match = typeof pkg === 'string' && pkg.match(/^([A-Za-z0-9][\w.-]{0,38})\/([\w.-]{1,100})$/);
  if (!match) throw Error('Pacote inválido: use dono/repositorio do GitHub.');
  if (typeof skill !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) throw Error('Skill inválida: um nome por vez, sem curinga.');
  const owner = match[1].toLowerCase();
  if (!trusted.includes(owner) && !(typeof approval === 'string' && approval.trim().length >= 10)) {
    throw Error('Fonte fora da lista confiável (' + owner + '). Peça ao usuário e repita com --fonte-aprovada "<onde e como ele aceitou>".');
  }
  return { pkg, skill, owner, trusted: trusted.includes(owner) };
}

// Palavras simples; nada que a CLI leia como opção.
export function validateTerms(terms) {
  const text = terms.join(' ').trim();
  if (!/^[\p{L}\p{N} .@/+-]{2,80}$/u.test(text)) throw Error('Termos de busca inválidos: use palavras simples, até 80 caracteres.');
  const words = text.split(/\s+/);
  if (words.some((word) => word.startsWith('-'))) throw Error('Termos de busca inválidos: nenhum termo pode começar com -.');
  return words;
}

// Nomes listados por "skills add <pacote> --list": linhas com exatamente quatro espaços depois da moldura.
// A CLI pinta os nomes; as sequências de cor saem antes de ler.
export function listedSkills(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  return [...plain.matchAll(/^[│|]? {4}(\S[^\r\n]*?)\s*$/gm)].map((match) => match[1]);
}

// A CLI normaliza espaço e sublinhado para hífen e instala todas as correspondências: exige uma só, com o nome exato.
export function uniqueSkill(names, skill) {
  const normal = (name) => name.toLowerCase().replace(/[\s_]+/g, '-');
  const matches = names.filter((name) => normal(name) === skill);
  if (matches.length !== 1 || matches[0] !== skill) {
    throw Error(matches.length ? 'Nome ambíguo no repositório: ' + matches.length + ' skills correspondem. Nada foi instalado.'
      : 'Skill não encontrada no repositório. Confira com skills find.');
  }
}

// Recusa destino que seja link ou cujo caminho real saia do projeto, antes de qualquer escrita.
export function checkDestinations(dir = root) {
  const real = realpathSync(dir);
  for (const item of destinations) {
    const target = path.join(dir, item);
    if (!existsSync(target)) continue;
    const inside = path.relative(real, realpathSync(target));
    if (lstatSync(target).isSymbolicLink() || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw Error('A pasta ' + item + ' aponta para fora do projeto. Nada foi instalado.');
    }
  }
}

// Conteúdo das pastas de destino, para mostrar o que a instalação criou, alterou ou removeu.
export function snapshot(dir = root, limit = 20000) {
  const files = new Map();
  const walk = (current) => {
    if (files.size >= limit) return;
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else if (entry.isFile()) files.set(path.relative(dir, full).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  for (const item of new Set(destinations.map((entry) => entry.split('/')[0]))) walk(path.join(dir, item));
  // Trava de versões que a CLI grava na raiz.
  const lock = path.join(dir, 'skills-lock.json');
  if (existsSync(lock)) files.set('skills-lock.json', createHash('sha256').update(readFileSync(lock)).digest('hex'));
  return files;
}

export function difference(before, after) {
  const out = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) out.push('criado ' + file);
    else if (before.get(file) !== hash) out.push('alterado ' + file);
  }
  for (const file of before.keys()) if (!after.has(file)) out.push('removido ' + file);
  return out.sort();
}

// npx no Windows é um .cmd e só roda pelo shell; a linha é montada com argumentos já validados acima,
// que só têm letras, números e . @ / + - e espaço.
const npx = (args, capture = false) => {
  const options = { cwd: root, timeout: 300000, windowsHide: true, ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' }) };
  return process.platform === 'win32'
    ? spawnSync(['npx', '-y', cli, ...args].join(' '), { ...options, shell: true })
    : spawnSync('npx', ['-y', cli, ...args], options);
};

function add(args) {
  // Aceita também dono/repositorio@skill, o formato que a busca mostra.
  const joined = args[0]?.match(/^([^@\s]+)@([^@\s]+)$/);
  const [pkg, skill, ...rest] = joined ? [joined[1], joined[2], ...args.slice(1)] : args;
  let approval;
  if (rest.length) {
    if (rest[0] !== '--fonte-aprovada' || rest.length !== 2) throw Error(usage);
    approval = rest[1];
  }
  const checked = validateAdd(pkg, skill, trustedOwners(), approval);
  const listing = npx(['add', checked.pkg, '--list'], true);
  if (listing.status !== 0) throw Error('Não foi possível listar as skills do repositório. Nada foi instalado.');
  uniqueSkill(listedSkills(listing.stdout + listing.stderr), checked.skill);
  checkDestinations();
  const before = snapshot();
  const rootBefore = topLevel();
  const result = npx(['add', checked.pkg, '--skill', checked.skill, '--agent', ...kitAgents, '--copy', '--yes']);
  const changes = difference(before, snapshot());
  const expected = new Set([...destinations.map((item) => item.split('/')[0]), 'skills-lock.json']);
  const extra = [...topLevel()].filter((name) => !rootBefore.has(name) && !expected.has(name));
  if (extra.length) {
    console.log('Atenção: a instalação criou na raiz do projeto, fora das pastas previstas: ' + extra.join(', ')
      + '. Revise e apague o que não for usar antes do commit.');
  }
  if (result.status !== 0) {
    throw Error('A instalação falhou.' + (changes.length ? ' Arquivos mexidos antes da falha:\n  ' + changes.join('\n  ') : ' Nada mudou.'));
  }
  const log = path.join(root, '.agents', 'skills', 'FONTES.md');
  mkdirSync(path.dirname(log), { recursive: true });
  appendFileSync(log, '- ' + new Date().toISOString().slice(0, 10) + ': ' + checked.skill + ' de ' + checked.pkg + ' via ' + cli
    + (checked.trusted ? ' (fonte confiável)' : ' (aprovada: ' + approval.trim().replace(/\s+/g, ' ') + ')') + '\n');
  console.log('Instalada no projeto: ' + checked.skill + ' de ' + checked.pkg + '.');
  console.log('Revise antes de usar: leia o SKILL.md e qualquer script da skill; não rode script que você não leu.');
  console.log(changes.length ? 'Arquivos:\n  ' + changes.join('\n  ') : 'Nenhum arquivo mudou nas pastas de skills.');
}

function main([command, ...args]) {
  if (command === 'find' && args.length) {
    if (npx(['find', ...validateTerms(args)]).status !== 0) process.exitCode = 1;
  } else if (command === 'list' && !args.length) {
    if (npx(['list']).status !== 0) process.exitCode = 1;
  } else if (command === 'add') add(args);
  else throw Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
