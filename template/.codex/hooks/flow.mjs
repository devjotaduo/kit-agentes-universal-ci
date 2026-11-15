import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLiveOwner, liveStatus } from './live.mjs';
import { callerAgentId, heldBy, idleHolds, requireProjectWorkspace, taskOwnership, verifyFronts, withProjectConcord } from './concord.mjs';
import { appendFileSync } from 'node:fs';
import { captureSnapshot, evidenceOnlySince, missingHere, projectPath, publicationFiles, realPath, uncommittedProduct, uncommittedWork, validateInitialCommit, validatePatchPath, worktrees } from './snapshot.mjs';

const root = realPath(fileURLToPath(new URL('../../', import.meta.url)));
const stateDir = path.join(root, '.agent-flow');
const stateFile = path.join(stateDir, 'active.json');
const discovery = ['discover', 'specify', 'slice'];
const delivery = ['implement', 'validate', 'review', 'ready'];
const kinds = ['feature', 'fix', 'maintenance'];
const route = (kind) => [...(kind === 'feature' ? discovery : ['discover']), ...delivery];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function load() {
  let raw;
  try {
    raw = readFileSync(stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(raw);
  requireThat(state?.version === 1 && kinds.includes(state.kind)
    && route(state.kind).includes(state.stage) && typeof state.ui === 'boolean'
    && state.evidence && typeof state.evidence === 'object', 'Estado inválido: .agent-flow/active.json');
  return state;
}

function save(file, state) {
  const tmp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

const inside = (rel) => Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);

// O ancestral que existe e o resto do caminho; um link sem destino conta como existente e falha adiante.
function splitExisting(absolute) {
  let existing = absolute;
  const rest = [];
  for (;;) {
    try { lstatSync(existing); return { existing, rest }; } catch { /* sobe um nível */ }
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
}

// Caminho real do destino, que pode ainda não existir: links, junções e nomes curtos resolvidos no ancestral que existe.
function realTarget(absolute) {
  const found = splitExisting(absolute);
  if (!found) return absolute;
  let real;
  try { real = realPath(found.existing); } catch {
    throw new Error('Não foi possível resolver o caminho real do destino (link ou junção sem destino?).');
  }
  return path.join(real, ...found.rest);
}

// No Windows o mesmo arquivo tem mais de um nome: o curto (PASTA-~1) e outra caixa de letras. A guarda decide
// pelo caminho real, senão .agent-flow escrito como AGENT-~1 escaparia das regras por texto.
// Sem link nem junção no caminho, o caminho real é o mesmo arquivo. Com link, só o trecho antes do primeiro link
// é expandido e o resto fica como veio: um link dentro do projeto continua dentro dele e é recusado adiante.
function expandShortNames(absolute) {
  const found = splitExisting(absolute);
  if (!found) return absolute;
  let link;
  for (let at = found.existing; ; at = path.dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) link = at;
    if (path.dirname(at) === at) break;
  }
  if (!link) return realTarget(absolute);
  const parent = path.dirname(link);
  return path.join(realPath(parent), path.relative(parent, absolute));
}

const fromRoot = (absolute) => path.relative(root, process.platform === 'win32' ? expandShortNames(absolute) : absolute);

function localPath(absolute) {
  const rel = fromRoot(absolute);
  requireThat(inside(rel), 'Caminho deve ficar dentro do projeto.');
  return rel.split(path.sep).join('/');
}

// Pasta de memória do Claude Code para um projeto: o caminho com tudo que não é letra ou dígito trocado por -.
// shortcut: o Claude Code encurta nomes longos (cerca de 200 caracteres) com um hash; projetos assim ficam sem memória aceita.
const claudeMemory = (dir) => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'projects', realTarget(dir).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

// Destino fora da raiz: só a lista fechada (pasta temporária do sistema, onde fica o scratchpad do Claude Code,
// e a memória deste projeto no Claude Code), decidida pelo caminho real. Lança a causa da recusa.
function outsideDestination(absolute, client) {
  const real = realTarget(absolute);
  const within = (dir) => inside(path.relative(realTarget(dir), real));
  requireThat(!within(root), 'O caminho passa por link ou junção fora do projeto e cai dentro dele; use o caminho do projeto.');
  // Um ancestral que cai dentro da raiz com o destino fora dela: o caminho atravessa o projeto e sai por um link dele.
  const found = splitExisting(absolute);
  for (let at = found?.existing; at; at = path.dirname(at) === at ? null : path.dirname(at)) {
    const rel = path.relative(root, realTarget(at));
    requireThat(rel !== '' && !inside(rel), 'O caminho passa por link ou junção dentro do projeto; use o caminho do projeto.');
  }
  // Hardlink: o mesmo arquivo tem outro nome, que pode ser de produto.
  let entry;
  try { entry = lstatSync(real); } catch { /* ainda não existe */ }
  requireThat(!entry || entry.isDirectory() || entry.nlink <= 1,
    'O destino tem mais de um nome (hardlink) e pode ser um arquivo do projeto.');
  let trees;
  try { trees = worktrees(root); } catch (error) {
    throw new Error(error.message + ' Sem a lista, destinos fora do projeto ficam recusados.');
  }
  const tree = trees.find((dir) => path.relative(realTarget(dir), root) !== '' && within(dir));
  requireThat(!tree, 'O destino fica na worktree ' + (tree && realTarget(tree)) + ' do mesmo repositório: abra a sessão nessa worktree.');
  // A memória do Claude Code é a do repositório: numa worktree, a da worktree principal (a primeira da lista).
  const allowed = [os.tmpdir(), ...(client === 'claude' ? [root, ...trees.slice(0, 1)].map(claudeMemory) : [])];
  requireThat(allowed.some(within), 'Caminho deve ficar dentro do projeto.');
}

function scopePaths(files, source) {
  return files.map((file) => {
    const dir = file.endsWith('/**');
    const name = dir ? file.slice(0, -3) : file;
    requireThat(!/[*?[\]{}]/.test(name), 'Use arquivos exatos ou diretórios com /**.' + (source
      ? ' O padrão ' + JSON.stringify(file) + ' está em ' + source + '; registre os arquivos certos numa tarefa com start_work.' : ''));
    projectPath(root, name);
    return dir ? name + '/**' : name;
  });
}

function covers(scope, file) {
  if (scope === file) return true;
  return scope.endsWith('/**') && file.startsWith(scope.slice(0, -2));
}

export { heldBy };

const sessionId = (input) => typeof input.session_id === 'string' && /^[\w.-]{1,200}$/.test(input.session_id)
  ? input.session_id : undefined;

function scopeForHook(state, input, live) {
  const scope = state.scopes?.find((entry) => entry.session === input.session_id);
  if (live || state.scopes?.length) {
    requireThat(scope && scope.request === (state.liveRequest ?? null)
      && scope.generation === (live?.lease?.generation ?? null)
      && (!scope.concordLeaseExpiresAt || Date.parse(scope.concordLeaseExpiresAt) > Date.now()),
    'Declare o escopo desta sessão e confira a posse antes de editar.'
      + (sessionId(input) ? ' Use node .agent-kit/kit.mjs flow scope --session ' + sessionId(input)
        + (live ? ' --task <tarefa-Concord>' : '') + ' -- <arquivos>.' : ''));
  }
  return scope;
}

function verifySnapshot(state, { publishedHead, staged = false } = {}) {
  const expected = state.snapshot;
  requireThat(expected, 'Falta snapshot revisado. Reabra e repita validação e revisão.');
  const current = captureSnapshot(root, state.publicationSelection ?? [], { useTree: expected.publication?.tree });
  requireThat(current.files === expected.files, 'O conteúdo do projeto mudou após a validação. Reabra a tarefa.');
  if (publishedHead || staged) {
    requireThat(current.head === (publishedHead ?? null) && expected.head === null && expected.publication,
      'O commit inicial não corresponde à transação revisada.');
  } else {
    // Depois da revisão só evidência pode ser preparada ou commitada. Snapshot sem productIndex (kit até 0.7.3)
    // continua exigindo o mesmo commit e o mesmo índice.
    requireThat(expected.productIndex === undefined
      ? current.head === expected.head && current.index === expected.index
      : current.productIndex === expected.productIndex
        && (current.head === expected.head || current.head !== null && evidenceOnlySince(root, expected.head)),
      'O HEAD ou o índice Git mudou após a validação. Reabra a tarefa.');
  }
  return expected;
}

function evidence(input) {
  const wanted = path.resolve(root, input);
  // A mensagem só é montada na falha: consultar as worktrees custa um processo git, e evidence roda em todo hook.
  if (!existsSync(wanted)) throw new Error(missingHere(root, path.relative(root, wanted).split(path.sep).join('/'), 'Evidência ' + input));
  const absolute = realPath(wanted);
  const file = localPath(absolute);
  requireThat(/\.md$/i.test(file) && statSync(absolute).isFile(), 'Use um arquivo Markdown do projeto.');
  const content = readFileSync(absolute, 'utf8');
  requireThat(content.trim(), 'Evidência vazia: ' + file);
  return { file, hash: createHash('sha256').update(content).digest('hex') };
}

// O plano fica em docs/work/ (versionado) ou em .agent-flow/notes/ (local); as decisões vão para a nota local
// .agent-flow/notes/decisoes.md e para o Concord, nunca para o plano.
const planPlace = (file) => /^(?:docs\/work|\.agent-flow\/notes)\/[^/]+\.md$/i.test(file);

// O aceite do plano vale enquanto o mesmo arquivo, no mesmo caminho, não mudar.
function verifyApproval(state) {
  requireThat(state.approval?.plan, 'Falta o aceite do plano. Mostre o plano ao usuário e registre com approve.');
  let actual;
  try { actual = evidence(state.approval.plan.file); } catch { /* reported below */ }
  requireThat(actual?.hash === state.approval.plan.hash && actual.file === state.approval.plan.file,
    'O plano mudou depois do aceite: ' + state.approval.plan.file + '. Mostre a versão nova e registre outro approve.');
}

function approvalState(state) {
  if (!state?.approval) return 'missing';
  try { verifyApproval(state); return 'valid'; } catch { return 'changed'; }
}

function verify(state, { approval = true } = {}) {
  if (approval && delivery.includes(state.stage)) verifyApproval(state);
  for (const stage of route(state.kind).slice(0, route(state.kind).indexOf(state.stage))) {
    const entries = state.evidence[stage];
    const required = state.ui && ['discover', 'validate'].includes(stage) ? 2 : 1;
    requireThat(Array.isArray(entries) && entries.length === required, 'Falta evidência de ' + stage + '.');
    for (const entry of entries) {
      let actual;
      try { actual = evidence(entry.file); } catch { /* report with phase */ }
      requireThat(actual?.hash === entry.hash && actual.file === entry.file,
        'Evidência ausente ou alterada em ' + stage + ': ' + entry.file);
    }
  }
}

// O próximo comando de cada etapa, para o agente não precisar procurar na doc.
function nextStep(state) {
  const flow = 'node .agent-kit/kit.mjs flow ';
  const workspace = state.liveRequest ? ' --workspace <workspace-Concord>' : ' [--workspace <workspace-Concord>]';
  const evidence = state.ui && ['discover', 'validate'].includes(state.stage) ? '<evidência-1.md> <evidência-2.md>' : '<evidência.md>';
  // O advance que leva a implement exige o aceite do plano.
  const stages = route(state.kind);
  const approve = stages[stages.indexOf(state.stage) + 1] === 'implement' && !state.approval
    ? 'escreva o plano em docs/work/<nome>.md (ou .agent-flow/notes/<nome>.md), '
      + flow + 'approve <plano.md> "<onde e como o usuário aceitou>", ' : '';
  const advance = flow + 'advance ' + state.stage + ' ' + evidence + '.';
  // Depois de um reopen a revisão não aceita o registro sem conferência; o declarativo só sem Concord e sem Live.
  const known = state.reopenedAt && ['validate', 'review'].includes(state.stage) ? cachedWorkspace() : undefined;
  const afterReopen = state.reopenedAt && ['validate', 'review'].includes(state.stage)
    ? ' Depois do reopen, a revisão precisa de --workspace ' + (known ?? '<workspace-Concord>')
      + (known || state.liveRequest ? '' : ' ou, sem Concord e sem pedido Live, de --declarativo "<motivo>"') + '.'
    : '';
  if (state.stage === 'discover' || state.stage === 'review') {
    return 'Próximo: ' + flow + 'record-parallel ' + state.stage + ' <tarefa-pai> <frente-1> <frente-2>'
      + (afterReopen ? ' --workspace ' + (known ?? '<workspace-Concord>') : workspace)
      + ', ' + approve + 'depois ' + advance + afterReopen;
  }
  if (state.stage === 'implement') return 'Próximo: ' + flow + 'scope ' + (state.liveRequest ? '--task <tarefa-Concord>' : '[--task <tarefa-Concord>]')
    + ' -- <arquivos>, editar, ' + advance;
  if (state.stage === 'validate') return 'Próximo: commite a implementação com node .agent-kit/kit.mjs git commit'
    + ' "<mensagem>" -- <arquivos>, depois ' + advance + afterReopen;
  if (state.stage === 'ready') return 'Próximo: ' + flow + 'check, depois ' + flow + 'close.';
  return 'Próximo: ' + approve + advance;
}

// O que chegou num erro de uso: o executor pode ter partido um argumento com espaços em vários.
// Só a contagem e o primeiro argumento (a fase ou o tipo): o resto pode ser texto livre, até um segredo colado por engano.
// A contagem já mostra quando o executor partiu um texto entre aspas em vários argumentos.
function received(args) {
  const first = args.length ? String(args[0]) : '';
  return ' Chegaram ' + args.length + ' argumento(s)'
    + (args.length ? ', o primeiro ' + JSON.stringify(first.length > 20 ? first.slice(0, 20) + '…' : first) : '') + '.';
}

// A revisão apagada por reopen ou aceite novo; um registro declarativo depois precisa ser outra revisão.
function rememberReview(state) {
  if (state.parallel?.review || state.evidence.review) {
    // Acumula: uma frente ou nota de qualquer rodada anterior não volta como revisão nova.
    state.previousReview = {
      children: [...new Set([...(state.previousReview?.children ?? []), ...(state.parallel?.review?.children ?? [])])],
      hashes: [...new Set([...(state.previousReview?.hashes ?? []), ...(state.evidence.review ?? []).map((entry) => entry.hash)])],
    };
  }
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Workspace gravado por `concord workspace`; ausente, inválido ou general não aparece.
function cachedWorkspace() {
  try {
    const { workspace_id: id } = JSON.parse(readFileSync(path.join(stateDir, 'concord-workspace.json'), 'utf8'));
    // Só o formato de um remoto (host/dono/repo): o texto entra no contexto do agente.
    return typeof id === 'string' && id.length <= 200 && /^[\w.-]+(?:\/[\w.-]+){1,3}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

function hook(input, state, adapter) {
  // O Antigravity usa o formato do Claude Code, mas a memória do Claude Code não é dele.
  const client = adapter === 'antigravity' ? 'claude' : adapter;
  const event = input.hook_event_name;
  if (event === 'SessionStart') {
    const workspace = cachedWorkspace();
    const label = state ? state.kind + ' em ' + state.stage + (state.ui ? ' (UI)' : '') : 'sem tarefa ativa';
    const approval = approvalState(state);
    const approved = approval === 'valid' ? ' Plano aceito: o orquestrador decide e segue até ready sem pedir nova aprovação,'
      + ' salvo os limites de docs/orquestracao.md.'
      : approval === 'changed' ? ' O plano mudou depois do aceite: mostre a versão nova ao usuário e registre outro approve antes de seguir.'
        : '';
    return { hookSpecificOutput: { hookEventName: event,
      additionalContext: 'Agent Flow: ' + label + '.' + approved
        + (sessionId(input) ? ' Sessão: ' + sessionId(input) + '.' : '')
        + (workspace ? ' Workspace Concord: ' + workspace + '.' : '')
        + ' Para mudanças, consulte docs/agent-flow.md; para chamadas ao Concord, docs/concord-chamadas.md.' } };
  }
  if (!state) return {};
  if (event === 'Stop') {
    // Plano mudado vem antes de tudo, inclusive do pedido ao vivo: nada deve seguir sem o aceite novo.
    if (approvalState(state) === 'changed') {
      return { systemMessage: 'Agent Flow: o plano mudou depois do aceite. Pare, mostre a versão nova ao usuário e registre outro approve.' };
    }
    if (state.liveRequest) {
      try {
        const report = liveStatus(state.liveRequest);
        if (!report.closed) return {
          systemMessage: 'Agent Live: pedido ' + report.request + ' ainda aberto'
            + (report.timeout ? ' e com tempo esgotado' : '')
            + '. Informe o estado ao solicitante e registre um desfecho, ou deixe a espera explícita.',
        };
        if (report.channel === 'concord' && report.delivery.state === 'pending') return {
          systemMessage: 'Agent Live: resposta final do pedido ' + report.request + ' ainda pendente no Concord.',
        };
      } catch {
        return { systemMessage: 'Agent Live: verifique o registro do pedido ' + state.liveRequest + '.' };
      }
    }
    const approval = approvalState(state);
    if (state.stage === 'ready') return {};
    return { systemMessage: approval === 'valid'
      ? 'Agent Flow: plano aceito e tarefa em ' + state.stage + '. Continue até ready decidindo dentro do plano;'
        + ' pare só num limite de docs/orquestracao.md e diga qual.'
      : 'Agent Flow: tarefa ainda em ' + state.stage + '. Ao encerrar, informe a pendência.' };
  }
  const tools = client === 'claude' ? ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
    : client === 'hermes' ? ['write_file', 'patch'] : ['apply_patch'];
  if (event !== 'PreToolUse' || !tools.includes(input.tool_name)) return {};
  const args = input.tool_input;
  let targets = [client === 'claude'
    ? args?.[input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path']
    : args?.path];
  // O Codex faz trim() do Rust na linha do cabeçalho: corta os brancos Unicode (White_Space, com U+0085 e sem U+FEFF)
  // das pontas da linha e grava o resto depois do prefixo como veio, inclusive espaços à esquerda do caminho.
  // O parser local do Hermes não aceita brancos antes de *** (a guarda aceita, o que só a deixa mais restrita).
  // Toda linha com forma de cabeçalho (***, uma palavra e :) precisa ser entendida, senão seria um destino sem regra;
  // *** sozinho ou colado no texto, como em Markdown, não é cabeçalho.
  const rustBlank = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  const rustTrim = (line) => line.replace(new RegExp('^' + rustBlank + '+|' + rustBlank + '+$', 'g'), '');
  const shape = /^[\s\u0085]*\*\*\*[\s\u0085]*[A-Za-z][A-Za-z ]*:/;
  const unknown = deny('Agent Flow: o patch tem um cabeçalho *** que a guarda não reconhece.');
  if (client === 'codex') {
    const header = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/;
    targets = [];
    for (const line of typeof args?.command === 'string' ? args.command.split('\n') : []) {
      const match = rustTrim(line).match(header);
      if (match) targets.push(match[1]);
      else if (shape.test(line)) return unknown;
    }
  }
  if (client === 'hermes' && input.tool_name === 'patch' && args?.mode === 'patch') {
    const patch = args.patch;
    if (typeof patch !== 'string') return deny('Não foi possível ler os destinos do patch Hermes.');
    // O \s do Python 3 em str (o do parser do Hermes e o do strip()): inclui \x1c-\x1f, \x85 e os separadores Unicode.
    const py = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
    const pyTrim = (text) => text.replace(new RegExp('^' + py + '+|' + py + '+$', 'g'), '');
    const star = '^' + py + '*[*]{3}' + py + '*';
    const file = new RegExp(star + '(?:Add|Update|Delete)' + py + '+File:(.*)$', 's');
    const move = new RegExp(star + 'Move' + py + '+File:(.*?)->(.*)$', 's');
    const marker = new RegExp(star + '(?:Begin' + py + '+Patch|End' + py + '+Patch|End' + py + '+of' + py + '+File)' + py + '*$');
    // Linha que começa com *** e traz uma palavra de cabeçalho ou a forma "palavra:" precisa ser entendida;
    // *** sozinho, ***negrito*** ou *** fim *** (Markdown) não.
    const headerLike = new RegExp(star + '(?:(?:Add|Update|Delete|Move|Begin|End)(?![A-Za-z])|[A-Za-z][A-Za-z ]*:)', 'i');
    targets = [];
    for (const line of patch.split('\n')) {
      const match = line.match(move) ?? line.match(file);
      if (match) targets.push(...match.slice(1).map(pyTrim));
      else if (!marker.test(line) && headerLike.test(line)) return unknown;
    }
  }
  if (!targets.length || targets.some((target) => typeof target !== 'string' || !target.trim())) {
    return deny('Não foi possível ler os destinos da edição.');
  }
  // Hermes resolves relative paths against the session's terminal directory,
  // while its hook payload reports the process directory.
  if (client === 'hermes' && targets.some((target) => !path.isAbsolute(target)
    || (process.platform === 'win32' && path.parse(target).root.length === 1))) {
    return deny('Use caminhos absolutos do projeto nas ferramentas de edição do Hermes.');
  }
  const cwd = path.resolve(input.cwd ?? root, client === 'codex' ? args?.workdir ?? '.' : '.');
  const deniedTarget = (target, error) => deny('Agent Flow: destino recusado: ' + target + '. ' + error.message
    + ' Raiz considerada: ' + root + '.');
  // Destinos fora da raiz que estão na lista fechada não são produto: passam sem as regras de etapa e escopo.
  const project = [];
  for (const target of targets) {
    try {
      const absolute = path.resolve(cwd, target);
      if (inside(fromRoot(absolute))) project.push(target);
      else outsideDestination(absolute, adapter);
    } catch (error) {
      return deniedTarget(target, error);
    }
  }
  if (!project.length) return {};
  let scope;
  // Com o aceite inválido (plano mudado ou apagado), só o plano e as notas locais podem ser editados,
  // para dar como refazer o plano e registrar o aceite novo.
  const approvalBroken = delivery.includes(state.stage) && approvalState(state) !== 'valid';
  const planFile = state.approval?.plan?.file;
  if (state.stage === 'implement') {
    try {
      let report;
      if (state.liveRequest) {
        report = liveStatus(state.liveRequest);
        if (report.closed || report.lease?.expired || report.timeout === 'hard-deadline') {
          return deny('Pedido ' + report.request + (report.closed ? ' encerrado (' + report.state + ')'
            : report.timeout === 'hard-deadline' ? ' com o prazo total vencido' : ' com a posse expirada')
            + '. Retome a coordenação antes de editar: node .agent-kit/kit.mjs live status ' + report.request + '.');
        }
      }
      scope = scopeForHook(state, input, report);
      verify(state, { approval: false });
    } catch (error) {
      return deny(error.message);
    }
  }

  for (const target of project) {
    try {
      const file = localPath(path.resolve(cwd, target));
      validatePatchPath(root, file);
      const note = file.startsWith('.agent-flow/notes/');
      if (approvalBroken && file !== planFile && !note) {
        return deny('O plano mudou ou sumiu depois do aceite. Refaça o plano, mostre ao usuário e registre outro approve antes de editar.');
      }
      if (approvalBroken && file === planFile) continue;
      if (state.stage === 'implement') {
        if (file.toLowerCase().startsWith('.agent-flow/') && !note && file !== '.agent-flow/.gitignore') {
          return deny('Estado local deve ser atualizado pelos comandos do Agent Flow.');
        }
        // Notas locais (evidências e a nota de decisões) não entram no escopo de produto da sessão.
        if (scope && !note && !scope.files.some((allowed) => covers(allowed, file))) {
          return deny('Destino fora do escopo declarado desta sessão: ' + file);
        }
        continue;
      }
      const planning = discovery.includes(state.stage) && (
        file === 'GLOSSARY.md' || file.startsWith('docs/adr/') || file.startsWith('prototypes/')
      );
      if (!note && !planning && !file.startsWith('docs/work/')) {
        return deny('Agent Flow: edição de produto indisponível em ' + state.stage
          + '. Avance com evidência ou use reopen após a implementação.');
      }
    } catch (error) {
      // A causa (link no caminho, nome inválido) vem de localPath e validatePatchPath.
      return deniedTarget(target, error);
    }
  }
  return {};
}

async function cli([cmd, ...args]) {
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log('Agent Flow (node .agent-kit/kit.mjs flow <comando>): new, status, link-live, record-parallel, approve, scope, publish-selection, advance, reopen, check, close, cancel.');
    return;
  }
  if (cmd === 'hook') {
    const client = args[0] ?? 'codex';
    requireThat(args.length <= 1 && ['codex', 'claude', 'hermes', 'antigravity'].includes(client), 'Adaptador de hook inválido.');
    let input;
    let response;
    try {
      input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
      if (client === 'hermes' && input.hook_event_name === 'pre_tool_call') input.hook_event_name = 'PreToolUse';
      response = hook(input, load(), client);
    } catch {
      const reason = 'Agent Flow: leia o erro com status e restaure o estado local.';
      response = !input || input.hook_event_name === 'PreToolUse' ? deny(reason) : { systemMessage: reason };
    }
    if (client === 'hermes') {
      const reason = response.hookSpecificOutput?.permissionDecisionReason;
      response = reason ? { action: 'block', message: reason } : {};
    }
    console.log(JSON.stringify(response));
    return;
  }
  const state = load();
  if (cmd === 'status' && !args.length) {
    console.log(state ? JSON.stringify(state, null, 2) : 'Sem tarefa ativa.');
    return;
  }
  if (cmd === 'new') {
    const [kind, goal, ui] = args;
    requireThat([2, 3].includes(args.length) && kinds.includes(kind) && goal?.trim()
      && (ui === undefined || ui === '--ui'), 'Uso: new <feature|fix|maintenance> "<objetivo>" [--ui].' + received(args));
    requireThat(!state, 'Já existe tarefa ativa. Use status, close ou cancel.');
    mkdirSync(stateDir, { recursive: true });
    const initial = { version: 1, id: randomUUID(), kind, goal: goal.trim(), ui: ui === '--ui',
      stage: 'discover', evidence: {} };
    writeFileSync(stateFile, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' });
    console.log('Tarefa iniciada: discover. ' + nextStep(initial));
    return;
  }
  requireThat(state, 'Sem tarefa ativa. Use new.');
  if (cmd === 'link-live') {
    requireThat(args.length === 1 || args.length === 3 && args[1] === '--checked' && args[2].trim(),
      'Uso: link-live <pedido> [--checked "<verificação de posse e arquivos>"]');
    const report = assertLiveOwner(args[0]);
    const previous = state.liveRequest && liveStatus(state.liveRequest);
    const workspace = report.workspace ?? report.route?.workspace;
    const previousWorkspace = state.parallel?.discover?.verification?.workspace
      ?? previous?.workspace ?? previous?.route?.workspace;
    if (workspace) requireProjectWorkspace(workspace, previousWorkspace);
    // Retomada com pedido novo: o anterior terminou ou, num pedido de chat, passou do prazo total sem encerrar.
    // Um pedido do Concord precisa estar fechado: só assim a resposta ao solicitante fica pendente de entrega.
    const rebind = previous && previous.request !== report.request && report.lease
      && (previous.closed || previous.timeout === 'hard-deadline' && previous.channel !== 'concord');
    requireThat(!(previous?.timeout === 'hard-deadline' && previous.channel === 'concord'),
      'O pedido ' + previous?.request + ' veio do Concord e passou do prazo: feche-o com live event '
        + previous?.request + ' root blocked "<motivo>" antes de vincular outro, para a resposta chegar ao solicitante.');
    requireThat(!report.closed && ((!previous && state.stage === 'discover')
      || previous?.request === report.request || rebind), 'Vínculo inválido. Confira o pedido e a etapa.');
    if (rebind) {
      requireThat(args[2]?.trim(), 'Antes de retomar, confira a posse e o estado dos arquivos das frentes antigas.');
      state.resumedFrom = { request: previous.request, evidence: args[2].trim() };
      delete state.scopes;
    }
    state.liveRequest = report.request;
    save(stateFile, state);
    console.log('Pedido vinculado: ' + report.request);
    return;
  }
  const readOnly = ['check', 'publication-plan'].includes(cmd);
  const settled = (report) => report.closed || report.timeout === 'hard-deadline';
  let live = null;
  if (state.liveRequest && ['record-parallel', 'approve', 'scope', 'publish-selection', 'advance', 'reopen', 'check', 'publication-plan'].includes(cmd)) {
    const status = liveStatus(state.liveRequest);
    // Reabrir com o pedido já encerrado só volta a etapa; o passo seguinte exige outro pedido vinculado.
    live = readOnly || cmd === 'reopen' && settled(status) ? status : assertLiveOwner(state.liveRequest);
  }
  requireThat(!live || !settled(live) || (readOnly && live.state === 'done') || cmd === 'reopen',
    'Pedido encerrado ou com prazo esgotado. Abra outro pedido, assuma com claim e vincule com'
      + ' link-live <novo-pedido> --checked "<verificação>".');
  if (cmd === 'record-parallel') {
    const workspaceFlag = args.indexOf('--workspace');
    const declarativeFlag = args.indexOf('--declarativo');
    requireThat(workspaceFlag < 0 || declarativeFlag < 0, 'Use --workspace ou --declarativo, não os dois.');
    const workspace = workspaceFlag >= 0 ? args[workspaceFlag + 1] : null;
    // Numa linha só: o motivo vai para a nota de decisões.
    const declarative = declarativeFlag >= 0 ? args[declarativeFlag + 1]?.replace(/\s+/g, ' ').trim() : null;
    requireThat(workspaceFlag < 0 || workspaceFlag === args.length - 2 && workspace, 'Informe --workspace <workspace> no fim.' + received(args));
    requireThat(declarativeFlag < 0 || declarativeFlag === args.length - 2 && declarative, 'Informe --declarativo "<motivo>" no fim.' + received(args));
    const [phase, parent, ...children] = workspace || declarative ? args.slice(0, -2) : args;
    const idRule = /^[a-zA-Z0-9_.:-]+$/;
    const badId = [parent, ...children].find((id) => typeof id === 'string' && !idRule.test(id));
    requireThat(badId === undefined, 'Id de frente ou tarefa inválido: ' + JSON.stringify(badId?.length > 20 ? badId.slice(0, 20) + '…' : badId)
      + '. Use só letras sem acento, dígitos e _ . : - (sem barra nem espaço), por exemplo frente-a ou a:b.');
    requireThat(['discover', 'review'].includes(phase) && phase === state.stage
      && [2, 3].includes(children.length) && new Set([parent, ...children]).size === children.length + 1
      && [parent, ...children].every((id) => typeof id === 'string' && idRule.test(id)),
    'Uso na fase atual: record-parallel <discover|review> <tarefa-pai> <frente-1> <frente-2> [frente-3]'
      + ' [--workspace <workspace> | --declarativo "<motivo>"].' + received(args));
    requireThat(!state.parallel?.discover || state.parallel.discover.parent === parent,
      'Use a mesma tarefa principal registrada na descoberta.');
    requireThat(phase !== 'review' || !children.some((id) => state.parallel?.discover?.children.includes(id)),
      'A revisão precisa de frentes distintas das registradas na descoberta.');
    requireThat(!live || workspace, 'Pedido vinculado exige verificação pelo Concord. Informe --workspace <workspace>.');
    // Depois de um reopen a revisão vale só se entregue depois da validação da versão corrigida, e isso só o
    // Concord confere. Na primeira rodada a referência fica de fora, como antes.
    const reviewAfter = phase === 'review' && state.reopenedAt
      ? [state.reopenedAt, state.validatedAt].filter(Boolean).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
      : undefined;
    // Sem Concord a revisão depois do reopen pode ser só declarada, com o motivo anotado; com pedido Live, não.
    const known = cachedWorkspace();
    requireThat(!declarative || reviewAfter, '--declarativo só vale na revisão depois de um reopen; nos outros casos, omita --workspace.');
    requireThat(!declarative || !known, 'Este projeto usa o Concord (workspace ' + known + ' gravado por concord workspace):'
      + ' use --workspace ' + known + ' no lugar de --declarativo.');
    requireThat(!declarative || !children.some((id) => state.previousReview?.children.includes(id)),
      'O registro declarativo precisa de frentes novas, distintas das da revisão anterior ao reopen.');
    requireThat(!reviewAfter || workspace || declarative, 'Depois de um reopen a revisão precisa ser conferida no Concord. Use node .agent-kit/kit.mjs flow'
      + ' record-parallel review ' + [parent, ...children].join(' ') + ' --workspace ' + (known ?? '<workspace-Concord>') + '.'
      + (known ? '' : ' Sem Concord e sem pedido Live, registre sem conferência com --declarativo "<motivo>" no lugar de --workspace;'
        + ' o motivo vai para .agent-flow/notes/decisoes.md.'));
    if (live?.workspace || live?.route?.workspace) requireProjectWorkspace(workspace, live.workspace ?? live.route.workspace);
    requireThat(!state.parallel?.discover?.verification || state.parallel.discover.verification.workspace === workspace,
      'Use o mesmo workspace da descoberta.');
    const verification = workspace && await withProjectConcord(root,
      (call) => verifyFronts(call, workspace, parent, children, reviewAfter), workspace);
    if (live?.lease) assertLiveOwner(state.liveRequest);
    state.parallel ??= {};
    state.parallel[phase] = { parent, children, ...(verification && { verification }), ...(declarative && { declarative }) };
    // A nota antes do estado: uma falha não deixa registro declarativo sem o motivo anotado.
    if (declarative) {
      const notes = path.join(root, '.agent-flow', 'notes');
      mkdirSync(notes, { recursive: true });
      appendFileSync(path.join(notes, 'decisoes.md'), '- ' + new Date().toISOString() + ' revisão depois do reopen registrada sem'
        + ' conferência no Concord (tarefa ' + parent + ', frentes ' + children.join(', ') + '): ' + declarative + '.\n');
    }
    save(stateFile, state);
    if (declarative) {
      console.log('Revisão registrada sem conferência no Concord (registro declarativo): a revisão não foi conferida.'
        + ' Motivo anotado em .agent-flow/notes/decisoes.md.');
      return;
    }
    // Sem --workspace nada foi consultado: a saída diz isso em vez de parecer conferência.
    console.log(verification ? 'Frentes conferidas no Concord e registradas: ' + phase + '.'
      : 'Frentes registradas sem consulta ao Concord (registro declarativo): ' + phase + '. Sem Concord, este registro'
        + ' é o caminho esperado: os ids são nomes livres das frentes que o orquestrador acompanha. Com Concord, repita com'
        + ' --workspace ' + (cachedWorkspace() ?? '<workspace-Concord>') + ' para conferir vínculo, resultado e escopos.');
    return;
  }
  if (cmd === 'scope') {
    requireThat(state.stage === 'implement', 'scope só vale em implement; a tarefa está em ' + state.stage + '. ' + nextStep(state));
    const separator = args.indexOf('--');
    requireThat(separator >= 0 && separator < args.length - 1,
      'Uso em implement: scope [--session <sessão>] [--task <tarefa-Concord>] [--unclaimed "<motivo>"] -- <arquivos>.' + received(args));
    // Codex antes do Claude: um `codex exec` lançado pelo Claude herda CLAUDE_CODE_SESSION_ID da sessão que o lançou.
    // Subagentes do Claude parecem herdar o id da sessão principal (não conferido no hook): dividiriam o escopo com ela.
    let session = process.env.AGENT_FLOW_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID
      || process.env.CLAUDE_CODE_SESSION_ID;
    let taskId;
    let unclaimed;
    let concordLeaseExpiresAt;
    const options = args.slice(0, separator);
    while (options.length) {
      const [option, value] = options.splice(0, 2);
      requireThat(value?.trim() && ['--session', '--task', '--unclaimed'].includes(option), 'Opção inválida de escopo.' + received(args));
      if (option === '--session') session = value;
      else if (option === '--task') taskId = value;
      else unclaimed = value.trim();
    }
    requireThat(session, 'Identidade da sessão indisponível. Informe --session com o ID que o início da sessão ou a guarda mostram.');
    // Um id que o hook nunca recebe (caminho de scratchpad, por exemplo) gravaria um escopo que nunca vale.
    requireThat(sessionId({ session_id: session }), 'ID de sessão inválido: use o que o início da sessão ou a guarda mostram.');
    const files = scopePaths(args.slice(separator + 1));
    let outside = [];
    if (live) {
      const parent = state.parallel?.discover?.verification;
      requireThat(parent && taskId, 'Informe a tarefa Concord ativa responsável pela edição.');
      const { task, owned, holds } = await withProjectConcord(root, async (call) => {
        const result = await call('inspect_work', { workspace_id: parent.workspace, task_id: taskId });
        return { task: result.task, owned: taskOwnership(result, parent, taskId, unclaimed, callerAgentId()),
          holds: unclaimed ? await idleHolds(call, parent.workspace, taskId) : [] };
      }, parent.workspace);
      const permitted = scopePaths(task.expectedFiles ?? [], 'expected_files da tarefa ' + JSON.stringify(taskId) + ' no Concord');
      outside = files.filter((file) => !permitted.some((allowed) => covers(allowed, file)));
      requireThat(!outside.length || unclaimed,
        'O escopo solicitado excede os arquivos registrados no Concord. Se outra tarefa retém os arquivos e o dono'
        + ' não responde, registre o fato no Concord e repita com --unclaimed "<motivo>".');
      // O motivo só libera o que o Concord não deixa registrar: arquivo de tarefa parada ou aguardando revisão.
      requireThat(outside.every((file) => heldBy(holds, file)),
        'Com --unclaimed, os arquivos fora da tarefa precisam estar retidos por uma tarefa parada ou aguardando'
        + ' revisão. Registre os demais na sua tarefa com start_work.');
      requireThat(assertLiveOwner(state.liveRequest).lease?.generation === live.lease?.generation,
        'A posse mudou enquanto o Concord era consultado.');
      const lease = owned && task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : Infinity;
      // Sem posse confirmada o escopo vale uma hora; depois disso, repita o comando.
      concordLeaseExpiresAt = unclaimed ? new Date(Math.min(lease, Date.now() + 3600000)).toISOString() : task.leaseExpiresAt;
    }
    state.scopes = (state.scopes ?? []).filter((entry) => entry.session !== session);
    state.scopes.push({ session, taskId, files, concordLeaseExpiresAt, ...(unclaimed && { unclaimed, outside }),
      request: state.liveRequest ?? null, generation: live?.lease?.generation ?? null });
    save(stateFile, state);
    if (unclaimed) {
      // O escopo some quando o pedido é revinculado; a nota de decisões leva o motivo até a revisão.
      const notes = path.join(root, '.agent-flow', 'notes');
      mkdirSync(notes, { recursive: true });
      appendFileSync(path.join(notes, 'decisoes.md'), '- ' + new Date().toISOString() + ' escopo sem posse confirmada (tarefa '
        + String(taskId) + '): ' + unclaimed + '. Arquivos fora da tarefa: ' + (outside.join(', ') || 'nenhum') + '.\n');
      console.log('Escopo registrado sem posse confirmada, por uma hora. Motivo anotado em .agent-flow/notes/decisoes.md.');
    } else console.log('Escopo registrado para a sessão.' + (taskId && !live ? ' Sem pedido Live vinculado, --task '
      + JSON.stringify(taskId) + ' não foi conferido no Concord; só um pedido vinculado (live open, live claim e flow link-live, em docs/comunicacao.md) confere a posse.' : ''));
    return;
  }
  if (cmd === 'publish-selection') {
    requireThat(['implement', 'validate'].includes(state.stage) && args[0] === '--',
      'Uso antes de avançar validate: publish-selection -- <arquivos>');
    state.publicationSelection = publicationFiles(root, args.slice(1));
    save(stateFile, state);
    console.log('Seleção registrada para validação e revisão.');
    return;
  }
  if (cmd === 'approve') {
    const [plan, record] = args;
    requireThat(args.length === 2 && plan && record?.trim(), 'Uso: approve <plano.md> "<onde e como o usuário aceitou>".' + received(args));
    const entry = evidence(plan);
    requireThat(planPlace(entry.file), 'Guarde o plano em docs/work/ ou em .agent-flow/notes/.');
    requireThat(!Object.values(state.evidence).flat().some((item) => item.file === entry.file),
      'Use para o plano um arquivo distinto das evidências das etapas.');
    // Aceite novo depois da validação: o que foi validado e revisado era do plano anterior e volta para implement.
    const replan = ['validate', 'review', 'ready'].includes(state.stage);
    if (replan) {
      rememberReview(state);
      for (const stage of delivery) delete state.evidence[stage];
      if (state.parallel) delete state.parallel.review;
      delete state.snapshot;
      state.stage = 'implement';
      state.reopenReason = 'Novo aceite do plano';
      state.reopenedAt = new Date().toISOString();
    }
    state.approval = { plan: entry, record: record.trim(), at: new Date().toISOString(),
      ...(state.approval && { previous: { plan: state.approval.plan.file, at: state.approval.at } }) };
    if (live?.lease) assertLiveOwner(state.liveRequest);
    save(stateFile, state);
    console.log('Aceite do plano registrado.' + (replan ? ' A tarefa voltou para implement: valide e revise de novo.' : '')
      + ' O orquestrador segue até ready dentro do plano e termina a entrega com flow check e flow close.');
    return;
  }
  if (cmd === 'advance') {
    const [current, ...files] = args;
    requireThat(current === state.stage && current !== 'ready', 'Etapa esperada: ' + state.stage + '.');
    const needed = state.ui && ['discover', 'validate'].includes(current) ? 2 : 1;
    requireThat(files.length === needed, current + ' requer ' + needed + ' arquivo(s) de evidência.');
    requireThat(!['discover', 'review'].includes(current) || state.parallel?.[current]?.children?.length >= 2,
      'Registre as frentes independentes desta etapa com record-parallel antes de avançar: com Concord, os ids das'
        + ' tarefas e --workspace; sem Concord, nomes livres das frentes que o orquestrador acompanha. ' + nextStep(state));
    requireThat(!live || !['discover', 'review'].includes(current) || state.parallel?.[current]?.verification,
      'Confirme as frentes no Concord antes de avançar.');
    verify(state);
    const entries = files.map(evidence);
    const used = new Set([...Object.values(state.evidence).flat().map((entry) => entry.file), state.approval?.plan.file]);
    for (const entry of entries) {
      requireThat(!used.has(entry.file), 'Use um arquivo distinto para cada evidência: ' + entry.file);
      used.add(entry.file);
    }
    const order = route(state.kind);
    if (order[order.indexOf(current) + 1] === 'implement') verifyApproval(state);
    if (current === 'validate') {
      // A publicação inicial (publish-selection) faz o primeiro commit depois da revisão; o resto valida o que já está commitado.
      // Com HEAD a trava vale mesmo com seleção: publication-plan só aceita snapshot sem HEAD.
      const snapshot = captureSnapshot(root, state.publicationSelection ?? []);
      const pending = state.publicationSelection?.length && snapshot.head === null ? null : uncommittedProduct(root);
      requireThat(!pending?.length, 'Há mudança de produto não commitada: ' + pending?.slice(0, 5).join(', ')
        + (pending?.length > 5 ? ' e mais ' + (pending.length - 5) : '') + '. Valide o que está commitado: rode'
        + ' node .agent-kit/kit.mjs git commit "<mensagem>" -- <arquivos> e repita advance validate.'
        + ' Para o primeiro commit de um projeto novo publicado pelo kit, registre a seleção com publish-selection.');
      state.snapshot = snapshot;
      state.validatedAt = new Date().toISOString();
    }
    if (current === 'review') verifySnapshot(state);
    requireThat(current !== 'review' || !state.parallel.review.declarative
      || !entries.some((entry) => state.previousReview?.hashes.includes(entry.hash)),
    'A evidência da revisão é a mesma da rodada anterior ao reopen: registre a revisão da versão corrigida.');
    state.evidence[current] = entries;
    const stages = route(state.kind);
    state.stage = stages[stages.indexOf(current) + 1];
    save(stateFile, state);
    console.log(current + ' registrado. Próxima etapa: ' + state.stage + '. ' + nextStep(state));
    return;
  }
  if (cmd === 'reopen') {
    requireThat(args.length === 1 && args[0].trim(), 'Uso: reopen "<motivo>".' + received(args));
    requireThat(['validate', 'review', 'ready'].includes(state.stage), 'Só reabra após implement.');
    rememberReview(state);
    for (const stage of delivery) delete state.evidence[stage];
    if (state.parallel) delete state.parallel.review;
    delete state.snapshot;
    state.stage = 'implement';
    state.reopenReason = args[0].trim();
    // A revisão seguinte só aceita frentes com resultado registrado no Concord depois deste instante.
    state.reopenedAt = new Date().toISOString();
    // Reabrir não depende do aceite: com o plano mudado, a próxima edição pede o approve novo.
    verify(state, { approval: false });
    save(stateFile, state);
    // O reopen mantém os escopos; quem os apaga é o link-live de um pedido novo, exigido quando o atual já encerrou.
    const rebind = live && settled(live);
    console.log('Implementação reaberta; valide e revise novamente.'
      + (rebind ? ' Abra outro pedido, assuma com claim e vincule com link-live <novo-pedido> --checked "<verificação>";'
        + ' o vínculo novo apaga o escopo das sessões, que precisa ser declarado de novo com scope.'
        : state.scopes?.length ? ' O escopo já declarado das sessões continua registrado; declare de novo com scope se a guarda recusar.' : '')
      + ' ' + nextStep(state));
    return;
  }
  if (['check', 'close'].includes(cmd) && !args.length || cmd === 'publication-plan' && args.length <= 1) {
    requireThat(state.stage === 'ready', 'Tarefa em ' + state.stage + '; ainda não está pronta. ' + nextStep(state));
    verify(state);
    const staged = cmd === 'publication-plan' && args[0] === '--staged';
    let publishedHead = cmd === 'publication-plan' && !staged ? args[0] : undefined;
    if (cmd === 'close' && state.snapshot?.publication) {
      const marker = path.join(stateDir, 'bootstrap.json');
      if (existsSync(marker)) {
        const published = JSON.parse(readFileSync(marker, 'utf8'));
        if (published.published) {
          validateInitialCommit(root, published.head, state.snapshot.publication.tree);
          publishedHead = published.head;
        }
      }
    }
    const snapshot = verifySnapshot(state, { staged, publishedHead });
    if (cmd === 'publication-plan') {
      requireThat(snapshot.publication, 'Registre e revise uma seleção com publish-selection.');
      console.log(JSON.stringify(snapshot.publication));
      return;
    }
    if (cmd === 'check') {
      console.log('Ready: todas as evidências registradas estão presentes e íntegras.');
      return;
    }
  } else {
    requireThat(cmd === 'cancel' && args.length === 1 && args[0].trim(), 'Comando ou argumentos inválidos.');
  }
  const archive = path.join(stateDir, 'archive');
  if (state.liveRequest) {
    const report = liveStatus(state.liveRequest);
    requireThat(cmd === 'close' ? report.state === 'done' : report.closed,
      'Registre a resposta final no Agent Live antes de arquivar. ' + (report.closed
        ? 'O pedido foi encerrado sem done: arquive com cancel "<motivo>".'
        : 'Próximo: node .agent-kit/kit.mjs live event ' + state.liveRequest
          + (cmd === 'close' ? ' root done "<resposta>"' : ' root blocked "<motivo>"') + ', depois repita ' + cmd + '.'));
  }
  mkdirSync(archive, { recursive: true });
  const archived = { ...state, outcome: cmd === 'close' ? 'closed' : 'canceled',
    reason: args[0], archivedAt: new Date().toISOString() };
  save(path.join(archive, randomUUID() + '.json'), archived);
  unlinkSync(stateFile);
  console.log('Tarefa arquivada: ' + archived.outcome + '.');
  if (cmd !== 'close') return;
  let work = [];
  try { work = uncommittedWork(root); } catch { /* só aviso: falha do Git não muda o arquivamento */ }
  if (work.length) {
    console.log('Aviso: evidência em Markdown não commitada em docs/work/: ' + work.slice(0, 5).join(', ')
      + (work.length > 5 ? ' e mais ' + (work.length - 5) : '') + '. Se for para guardar, commite com'
      + ' node .agent-kit/kit.mjs git commit "<mensagem>" -- <arquivos>.');
  }
}

try {
  await cli(process.argv.slice(2));
} catch (error) {
  console.error('Agent Flow: ' + error.message);
  process.exitCode = 1;
}
