// Primeira execução num projeto: levanta os fatos, confere a origem das skills e pede ao agente análise,
// verificação e estratégia antes do primeiro pedido. O registro fica local, em .agent-flow/.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatUpstream, upstream } from './skills.mjs';
import { KIT } from './update.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const marker = (dir) => path.join(dir, '.agent-flow', 'onboarding.json');
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

export function onboarded(dir = root) {
  try { return JSON.parse(readFileSync(marker(dir), 'utf8')); } catch { return null; }
}

// Aviso que o início da sessão e o flow new mostram enquanto o projeto não passou pela primeira execução.
export function onboardingNotice(dir = root) {
  return onboarded(dir) ? '' : 'Primeira execução do kit neste projeto: antes do pedido, rode node .agent-kit/kit.mjs onboard,'
    + ' preencha a nota que ele cria (análise, verificação e estratégia) e registre com node .agent-kit/kit.mjs onboard done.';
}

const git = (dir, ...args) => {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};

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
    '- Concord: ' + (found.workspace ? 'workspace ' + found.workspace : 'workspace ainda não consultado (node .agent-kit/kit.mjs concord workspace)') + '.',
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
export function missingSections(text) {
  return sections.filter((name) => {
    const start = text.indexOf('\n## ' + name + '\n');
    if (start < 0) return true;
    const rest = text.slice(start + name.length + 5);
    const next = rest.search(/\n## /);
    const body = (next < 0 ? rest : rest.slice(0, next)).split('\n').filter((line) => line.trim() !== guide[name]).join('\n');
    return body.includes(placeholder) || body.replace(/\s+/g, ' ').trim().length < 40;
  });
}

function start(dir, offline) {
  const done = onboarded(dir);
  if (done) {
    console.log('Primeira execução já registrada em ' + done.at.slice(0, 10) + ' (kit ' + done.kit + '). Nota: .agent-flow/notes/primeira-execucao.md.');
    return;
  }
  const file = note(dir);
  if (!existsSync(file)) {
    const upstreamText = offline ? 'Não consultada (onboard --offline). Rode node .agent-kit/kit.mjs skills upstream quando houver rede.'
      : formatUpstream(upstream(dir));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, render(facts(dir), upstreamText), { flag: 'wx' });
    console.log('Nota criada: .agent-flow/notes/primeira-execucao.md, com os fatos do projeto e a situação das skills na origem.');
  } else console.log('A nota .agent-flow/notes/primeira-execucao.md já existe; continue por ela.');
  console.log('Próximo: leia o projeto, rode node .agent-kit/kit.mjs doctor e os testes, preencha Análise, Verificação e Estratégia'
    + ' na nota, mostre o resumo ao usuário e registre com node .agent-kit/kit.mjs onboard done. Só então siga com o pedido.');
}

function finish(dir) {
  if (onboarded(dir)) {
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
  mkdirSync(path.dirname(marker(dir)), { recursive: true });
  writeFileSync(marker(dir), JSON.stringify({ at: new Date().toISOString(), kit: KIT.version,
    note: createHash('sha256').update(text).digest('hex') }, null, 2) + '\n');
  console.log('Primeira execução registrada. Siga com o pedido: node .agent-kit/kit.mjs flow new <feature|fix|maintenance> "<objetivo>".');
}

function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--offline')) start(root, args[0] === '--offline');
  else if (args.length === 1 && args[0] === 'done') finish(root);
  else if (args.length === 1 && args[0] === 'status') {
    const done = onboarded(root);
    console.log(done ? 'Primeira execução registrada em ' + done.at.slice(0, 10) + ' (kit ' + done.kit + ').' : onboardingNotice(root));
  } else throw Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error('Onboard: ' + error.message);
    process.exitCode = 1;
  }
}
