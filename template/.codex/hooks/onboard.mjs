// Primeira execução num projeto: levanta os fatos, confere a origem das skills e pede ao agente análise,
// verificação e estratégia antes do primeiro pedido. O rascunho fica local, em .agent-flow/notes/; o registro e a nota final ficam em docs/, versionados.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatUpstream, upstream } from './skills.mjs';
import { KIT, writeCache } from './update.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// O registro vai para o Git (docs/), para valer por repositório e não por pasta; o antigo, local, continua valendo.
const marker = (dir) => path.join(dir, 'docs', 'primeira-execucao.json');
const legacyMarker = (dir) => path.join(dir, '.agent-flow', 'onboarding.json');
const published = (dir) => path.join(dir, 'docs', 'primeira-execucao.md');
const note = (dir) => path.join(dir, '.agent-flow', 'notes', 'primeira-execucao.md');
const placeholder = '<preencha>';
// Cada seção e a orientação que o kit escreve nela; a orientação não conta como conteúdo do agente.
const guide = {
  'Análise': 'O que o projeto é e como está: objetivo, estrutura das pastas, pontos de entrada, dependências, convenções que o código já segue e o que está pela metade.',
  'Verificação': 'O que você rodou e o resultado: `node .agent-kit/kit.mjs doctor`, os testes do projeto, o build, o estado do Git e do Concord. Diga o que não conseguiu rodar e por quê.',
  'Estratégia': 'Como trabalhar aqui: tipo de tarefa mais comum e as etapas que ele pede, comando de teste a usar em cada validação, riscos e limites (produção, dados, credenciais), o que precisa do usuário e, se a origem das skills tem versão nova, o que fazer com isso.',
};
const sections = Object.keys(guide);
const usage = 'Use onboard [--offline] | onboard done | onboard status.';

const git = (dir, ...args) => {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};

function readMarker(dir, shared, inherited = false) {
  try {
    const data = JSON.parse(readFileSync((shared ? marker : legacyMarker)(dir), 'utf8'));
    return data && typeof data.at === 'string' && typeof data.kit === 'string' ? { data, dir, shared, inherited } : null;
  } catch { return null; }
}

// Uma worktree de trabalhador vale pela primeira execução da worktree principal do mesmo repositório:
// o registro novo vai com a branch, mas uma branch criada antes dele ainda não o tem, e o antigo era local.
function record(dir) {
  const shared = readMarker(dir, true);
  if (shared) return shared;
  const legacy = readMarker(dir, false);
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common || path.basename(common) !== '.git') return legacy;
  const main = path.dirname(common);
  return path.resolve(main) === path.resolve(dir) ? legacy
    : readMarker(main, true, true) ?? legacy ?? readMarker(main, false, true);
}

export function onboarded(dir = root) {
  return record(dir)?.data ?? null;
}

function recordStatus({ data, dir, shared, inherited }, already = false) {
  const files = [marker(dir), published(dir)].map((file) => path.relative(dir, file).split(path.sep).join('/'));
  const committed = shared && files.every((file) => git(dir, 'cat-file', '-e', 'HEAD:' + file) !== null)
    && git(dir, 'status', '--porcelain', '--untracked-files=all', '--', ...files) === '';
  const source = !shared ? 'registro legado local'
    : committed ? 'registro compartilhado no Git' : 'registro em docs/, ainda não commitado por completo';
  return 'Primeira execução ' + (already ? 'já ' : '') + 'registrada em ' + data.at.slice(0, 10) + ' (kit ' + data.kit + '). Origem: '
    + source + (inherited ? ', herdado da worktree principal' : '') + '.'
    + (!shared ? ' Para compartilhar, rode node .agent-kit/kit.mjs onboard e registre uma nota nova com onboard done.' : '');
}

// Aviso que o início da sessão e o flow new mostram enquanto o projeto não passou pela primeira execução.
export function onboardingNotice(dir = root) {
  return onboarded(dir) ? '' : 'Primeira execução do kit neste projeto: antes de um pedido que mude arquivos, rode node .agent-kit/kit.mjs onboard,'
    + ' preencha a nota que ele cria (análise, verificação e estratégia) e registre com node .agent-kit/kit.mjs onboard done.'
    + ' Pedido só de leitura (explicar, ler, revisar sem editar) segue sem onboard e não grava a nota.';
}

// Arquivos que dizem qual é a stack, sem abrir o conteúdo (fora o script de teste do package.json).
const stacks = [['package.json', 'Node.js'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'], ['pom.xml', 'Java (Maven)'], ['build.gradle', 'Java ou Kotlin (Gradle)'], ['build.gradle.kts', 'Kotlin (Gradle)'],
  ['Gemfile', 'Ruby'], ['composer.json', 'PHP'], ['mix.exs', 'Elixir'], ['Package.swift', 'Swift'], ['deno.json', 'Deno'],
  ['Dockerfile', 'Docker'], ['docker-compose.yml', 'Docker Compose']];

export function facts(dir = root) {
  const entries = (() => { try { return readdirSync(dir); } catch { return []; } })();
  const has = (name) => entries.includes(name);
  let testScript = null;
  try { testScript = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test ?? null; } catch { /* sem package.json */ }
  let workspace = null;
  try { workspace = JSON.parse(readFileSync(path.join(dir, '.agent-flow', 'concord-workspace.json'), 'utf8')).workspace_id ?? null; } catch { /* sem cache */ }
  const workflows = (() => { try { return readdirSync(path.join(dir, '.github', 'workflows')).length; } catch { return 0; } })();
  const status = git(dir, 'status', '--porcelain');
  return {
    kit: KIT.version,
    git: git(dir, 'rev-parse', '--show-toplevel') ? {
      // symbolic-ref responde também num repositório ainda sem commits.
      branch: git(dir, 'symbolic-ref', '--short', 'HEAD') ?? 'HEAD destacado',
      commits: Number(git(dir, 'rev-list', '--count', 'HEAD') ?? 0),
      remote: Boolean(git(dir, 'remote', 'get-url', 'origin')),
      uncommitted: status === null ? null : status.split('\n').filter(Boolean).length,
    } : null,
    stack: [...new Set(stacks.filter(([file]) => has(file)).map(([, label]) => label))],
    testScript,
    ci: workflows,
    docs: ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].filter(has),
    workspace,
    activeTask: existsSync(path.join(dir, '.agent-flow', 'active.json')),
  };
}

function render(found, upstreamText) {
  const repo = found.git
    ? 'branch ' + found.git.branch + ', ' + found.git.commits + ' commit(s), ' + (found.git.remote ? 'com' : 'sem') + ' remoto origin, '
      + (found.git.uncommitted === null ? 'estado não lido' : found.git.uncommitted + ' arquivo(s) sem commit')
    : 'a pasta não é um repositório Git (rode node .agent-kit/kit.mjs setup)';
  return [
    '# Primeira execução do kit neste projeto',
    '',
    'Criada por `node .agent-kit/kit.mjs onboard` em ' + new Date().toISOString().slice(0, 10) + ', com o kit ' + found.kit
      + '. Preencha as três seções do fim, troque cada `' + placeholder + '` pelo que você conferiu e rode `node .agent-kit/kit.mjs onboard done`.',
    '',
    '## Fatos levantados pelo kit',
    '',
    '- Git: ' + repo + '.',
    '- Stack pelos arquivos da raiz: ' + (found.stack.join(', ') || 'não identificada') + '.',
    '- Teste declarado em package.json: ' + (found.testScript ? '`' + found.testScript + '`' : 'nenhum') + '.',
    '- CI: ' + (found.ci ? found.ci + ' arquivo(s) em .github/workflows' : 'nenhum workflow em .github/workflows') + '.',
    '- Documentos na raiz: ' + (found.docs.join(', ') || 'nenhum') + '.',
    '- Concord: ' + (found.workspace ? 'workspace consultado' : 'workspace ainda não consultado (node .agent-kit/kit.mjs concord workspace)') + '.',
    '- Tarefa ativa no fluxo: ' + (found.activeTask ? 'sim (node .agent-kit/kit.mjs flow status)' : 'não') + '.',
    '',
    '## Skills do kit e a origem delas',
    '',
    '```text',
    upstreamText,
    '```',
    '',
    ...sections.flatMap((name) => ['## ' + name, '', guide[name], '', placeholder, '']),
  ].join('\n');
}

// Cada seção precisa de texto de verdade: sem o marcador e com pelo menos uma linha de conteúdo.
export function missingSections(raw) {
  // Título com espaço no fim, quebra de linha do Windows ou acento decomposto não pode virar "falta preencher".
  const text = raw.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').normalize('NFC');
  return sections.filter((name) => {
    const start = text.indexOf('\n## ' + name + '\n');
    if (start < 0) return true;
    const rest = text.slice(start + name.length + 5);
    const next = rest.search(/\n## /);
    const body = (next < 0 ? rest : rest.slice(0, next)).split('\n').filter((line) => line.trim() !== guide[name]).join('\n');
    return body.includes(placeholder) || body.replace(/\s+/g, ' ').trim().length < 40;
  });
}

// Cria a pasta e recusa se ela, ou .agent-flow, for link: a nota e o registro não podem cair fora do projeto.
function realFolder(folder, dir) {
  // Antes de criar qualquer pasta: com .agent-flow (ou docs) sendo link, o mkdir já gravaria fora do projeto.
  const top = path.relative(dir, folder).split(path.sep)[0];
  if (lstatSync(path.join(dir, top), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw Error(top + ' é um link; o kit não grava através dele.');
  }
  mkdirSync(folder, { recursive: true });
  for (const item of [path.join(dir, top), folder]) {
    if (lstatSync(item).isSymbolicLink()) throw Error(path.relative(dir, item).split(path.sep).join('/') + ' é um link; o kit não grava através dele.');
  }
}

function start(dir, offline) {
  const done = record(dir);
  if (done?.shared) {
    console.log(recordStatus(done, true));
    return;
  }
  if (done) console.log(recordStatus(done));
  const file = note(dir);
  if (!existsSync(file)) {
    const upstreamText = offline ? 'Não consultada (onboard --offline). Rode node .agent-kit/kit.mjs skills upstream quando houver rede.'
      : formatUpstream(upstream(dir));
    realFolder(path.dirname(file), dir);
    writeFileSync(file, render(facts(dir), upstreamText), { flag: 'wx' });
    console.log('Nota criada: .agent-flow/notes/primeira-execucao.md, com os fatos do projeto e a situação das skills na origem.');
  } else console.log('A nota .agent-flow/notes/primeira-execucao.md já existe; continue por ela.');
  console.log('Próximo: leia o projeto, rode node .agent-kit/kit.mjs doctor e os testes, preencha Análise, Verificação e Estratégia'
    + ' na nota, mostre o resumo ao usuário e registre com node .agent-kit/kit.mjs onboard done. Só então siga com o pedido.');
}

function finish(dir) {
  if (record(dir)?.shared) {
    console.log('Primeira execução já registrada.');
    return;
  }
  let text;
  try { text = readFileSync(note(dir), 'utf8').replace(/\r\n/g, '\n'); } catch {
    throw Error('Nota ausente. Rode node .agent-kit/kit.mjs onboard antes.');
  }
  const missing = missingSections(text);
  if (missing.length) {
    throw Error('Falta preencher na nota .agent-flow/notes/primeira-execucao.md: ' + missing.join(', ')
      + '. Troque cada ' + placeholder + ' pelo que você conferiu no projeto.');
  }
  // Mesmo cuidado do cache de versão: pasta que é link é recusada e o arquivo final é trocado, nunca seguido.
  realFolder(path.dirname(marker(dir)), dir);
  // Grava num temporário e troca: se o .md for um link versionado, ele é substituído, nunca seguido.
  const tmp = published(dir) + '.' + process.pid + '.tmp';
  try { writeFileSync(tmp, text, { flag: 'wx' }); renameSync(tmp, published(dir)); } finally { rmSync(tmp, { force: true }); }
  writeCache(dir, { at: new Date().toISOString(), kit: KIT.version, note: createHash('sha256').update(text).digest('hex') }, marker(dir));
  console.log('Primeira execução registrada em docs/primeira-execucao.md e docs/primeira-execucao.json: faça o commit dos dois'
    + ' para que os outros clones e worktrees não repitam. Siga com o pedido: node .agent-kit/kit.mjs flow new <feature|fix|maintenance> "<objetivo>".');
  const pending = uncommitted(dir);
  if (pending.length) {
    console.log('Atenção: ' + pending.length + ' arquivo(s) da instalação do kit e do projeto ainda sem commit (' + pending.slice(0, 3).join(', ')
      + (pending.length > 3 ? ' e mais ' + (pending.length - 3) : '') + '). O advance validate conta o que não foi commitado como mudança de produto:'
      + ' faça o commit da instalação antes da primeira tarefa, com node .agent-kit/kit.mjs git commit "chore: instala o kit" -- <arquivos de git status --porcelain -uall>'
      + ' (o kit commita arquivo a arquivo, sem pasta nem curinga). Confira a lista antes de commitar: ela inclui tudo que o Git mostra sem commit, não só a instalação. Sem user.name e user.email no Git o commit falha; o doctor confere.');
  }
}

// Arquivos novos ou alterados no Git (um por linha, com as pastas expandidas), fora a nota e o registro da primeira execução,
// que já têm o próprio aviso de commit.
export function uncommitted(dir = root) {
  const status = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (status.status !== 0) return [];
  // -z: nomes sem aspas; num renome ou cópia o item seguinte é a origem e não conta.
  const files = [];
  const items = status.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < items.length; i += 1) {
    files.push(items[i].slice(3));
    if (/[RC]/.test(items[i].slice(0, 2))) i += 1;
  }
  return files
    .filter((file) => !['docs/primeira-execucao.md', 'docs/primeira-execucao.json'].includes(file));
}

function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--offline')) start(root, args[0] === '--offline');
  else if (args.length === 1 && args[0] === 'done') finish(root);
  else if (args.length === 1 && args[0] === 'status') {
    const done = record(root);
    console.log(done ? recordStatus(done) : onboardingNotice(root));
  } else throw Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error('Onboard: ' + error.message);
    process.exitCode = 1;
  }
}
