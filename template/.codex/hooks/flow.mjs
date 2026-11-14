import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLiveOwner, liveStatus } from './live.mjs';
import { idleHolds, requireProjectWorkspace, taskOwnership, verifyFronts, withProjectConcord } from './concord.mjs';
import { appendFileSync } from 'node:fs';
import { captureSnapshot, evidenceOnlySince, projectPath, publicationFiles, realPath, validateInitialCommit, validatePatchPath } from './snapshot.mjs';

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

// No Windows o mesmo arquivo tem mais de um nome: o curto (PASTA-~1) e outra caixa de letras. A guarda decide
// pelo caminho real, senão .agent-flow escrito como AGENT-~1 escaparia das regras por texto.
// Sem link nem junção no caminho, o caminho real é o mesmo arquivo; com link, fica como veio e é recusado adiante.
function expandShortNames(absolute) {
  let existing = absolute;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  for (let at = existing; ; at = path.dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) return absolute;
    if (path.dirname(at) === at) break;
  }
  return path.join(realPath(existing), ...rest);
}

function localPath(absolute) {
  const rel = path.relative(root, process.platform === 'win32' ? expandShortNames(absolute) : absolute);
  requireThat(inside(rel), 'Caminho deve ficar dentro do projeto.');
  return rel.split(path.sep).join('/');
}

function scopePaths(files) {
  return files.map((file) => {
    const dir = file.endsWith('/**');
    const name = dir ? file.slice(0, -3) : file;
    requireThat(!/[*?[\]{}]/.test(name), 'Use arquivos exatos ou diretórios com /**.');
    projectPath(root, name);
    return dir ? name + '/**' : name;
  });
}

function covers(scope, file) {
  if (scope === file) return true;
  return scope.endsWith('/**') && file.startsWith(scope.slice(0, -2));
}

// Caminho sem o sufixo de pasta, para comparar um escopo com o que outra tarefa declarou no Concord.
const barePath = (file) => file.replaceAll('\\', '/').replace(/\/\*\*?$/, '').replace(/\/$/, '');
export const heldBy = (holds, file) => holds.some((hold) => barePath(file) === barePath(hold)
  || barePath(file).startsWith(barePath(hold) + '/'));

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
  const absolute = realPath(path.resolve(root, input));
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

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function hook(input, state, client) {
  const event = input.hook_event_name;
  if (event === 'SessionStart') {
    const label = state ? state.kind + ' em ' + state.stage + (state.ui ? ' (UI)' : '') : 'sem tarefa ativa';
    const approval = approvalState(state);
    const approved = approval === 'valid' ? ' Plano aceito: o orquestrador decide e segue até ready sem pedir nova aprovação,'
      + ' salvo os limites de docs/orquestracao.md.'
      : approval === 'changed' ? ' O plano mudou depois do aceite: mostre a versão nova ao usuário e registre outro approve antes de seguir.'
        : '';
    return { hookSpecificOutput: { hookEventName: event,
      additionalContext: 'Agent Flow: ' + label + '.' + approved
        + (sessionId(input) ? ' Sessão: ' + sessionId(input) + '.' : '') + ' Para mudanças, consulte docs/agent-flow.md.' } };
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
          return deny('Pedido encerrado ou posse expirada. Retome a coordenação antes de editar.');
        }
      }
      scope = scopeForHook(state, input, report);
      verify(state, { approval: false });
    } catch (error) {
      return deny(error.message);
    }
  }

  const args = input.tool_input;
  let targets = [client === 'claude'
    ? args?.[input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path']
    : args?.path];
  if (client === 'codex') {
    targets = typeof args?.command === 'string'
      ? [...args.command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)\r?$/gm)].map((match) => match[1])
      : [];
  }
  if (client === 'hermes' && input.tool_name === 'patch' && args?.mode === 'patch') {
    const patch = args.patch;
    if (typeof patch !== 'string') return deny('Não foi possível ler os destinos do patch Hermes.');
    const files = [...patch.matchAll(/^\*\*\*[^\S\r\n]*(?:Add|Update|Delete)[^\S\r\n]+File:([^\r\n]+)/gm)];
    const moves = [...patch.matchAll(/^\*\*\*[^\S\r\n]*Move[^\S\r\n]+File:([^\r\n]+?)->([^\r\n]+)/gm)];
    targets = [...files, ...moves].flatMap((match) => match.slice(1).map((target) => target.trim()));
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
  for (const target of targets) {
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
    } catch {
      return deny('Agent Flow: destino da edição inválido ou fora do projeto.');
    }
  }
  return {};
}

async function cli([cmd, ...args]) {
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log('Agent Flow: new, status, link-live, record-parallel, approve, scope, publish-selection, advance, reopen, check, close, cancel.');
    return;
  }
  if (cmd === 'hook') {
    const client = args[0] ?? 'codex';
    requireThat(args.length <= 1 && ['codex', 'claude', 'hermes'].includes(client), 'Adaptador de hook inválido.');
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
      && (ui === undefined || ui === '--ui'), 'Uso: new <feature|fix|maintenance> "<objetivo>" [--ui]');
    requireThat(!state, 'Já existe tarefa ativa. Use status, close ou cancel.');
    mkdirSync(stateDir, { recursive: true });
    const initial = { version: 1, id: randomUUID(), kind, goal: goal.trim(), ui: ui === '--ui',
      stage: 'discover', evidence: {} };
    writeFileSync(stateFile, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' });
    console.log('Tarefa iniciada: discover.');
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
    const rebind = previous?.state === 'blocked' && report.lease;
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
  const live = state.liveRequest && ['record-parallel', 'approve', 'scope', 'publish-selection', 'advance', 'reopen', 'check', 'publication-plan'].includes(cmd)
    ? (readOnly ? liveStatus(state.liveRequest) : assertLiveOwner(state.liveRequest)) : null;
  requireThat(!live || (!live.closed && live.timeout !== 'hard-deadline') || (readOnly && live.state === 'done'),
    'Pedido encerrado ou com prazo esgotado. Retome a coordenação.');
  if (cmd === 'record-parallel') {
    const workspaceFlag = args.indexOf('--workspace');
    const workspace = workspaceFlag >= 0 ? args[workspaceFlag + 1] : null;
    requireThat(workspaceFlag < 0 || workspaceFlag === args.length - 2 && workspace, 'Informe --workspace <workspace>.');
    const [phase, parent, ...children] = workspace ? args.slice(0, workspaceFlag) : args;
    requireThat(['discover', 'review'].includes(phase) && phase === state.stage
      && [2, 3].includes(children.length) && new Set([parent, ...children]).size === children.length + 1
      && [parent, ...children].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(id)),
    'Uso na fase atual: record-parallel <discover|review> <tarefa-pai> <frente-1> <frente-2> [frente-3]');
    requireThat(!state.parallel?.discover || state.parallel.discover.parent === parent,
      'Use a mesma tarefa principal registrada na descoberta.');
    requireThat(phase !== 'review' || !children.some((id) => state.parallel?.discover?.children.includes(id)),
      'A revisão precisa de frentes distintas das registradas na descoberta.');
    requireThat(!live || workspace, 'Pedido vinculado exige verificação pelo Concord. Informe --workspace <workspace>.');
    if (live?.workspace || live?.route?.workspace) requireProjectWorkspace(workspace, live.workspace ?? live.route.workspace);
    requireThat(!state.parallel?.discover?.verification || state.parallel.discover.verification.workspace === workspace,
      'Use o mesmo workspace da descoberta.');
    const verification = workspace && await withProjectConcord(root,
      (call) => verifyFronts(call, workspace, parent, children), workspace);
    if (live?.lease) assertLiveOwner(state.liveRequest);
    state.parallel ??= {};
    state.parallel[phase] = { parent, children, ...(verification && { verification }) };
    save(stateFile, state);
    console.log('Referências do Concord registradas: ' + phase + '.');
    return;
  }
  if (cmd === 'scope') {
    const separator = args.indexOf('--');
    requireThat(separator >= 0 && separator < args.length - 1 && state.stage === 'implement',
      'Uso em implement: scope [--session <sessão>] [--task <tarefa-Concord>] [--unclaimed "<motivo>"] -- <arquivos>');
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
      requireThat(value?.trim() && ['--session', '--task', '--unclaimed'].includes(option), 'Opção inválida de escopo.');
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
        return { task: result.task, owned: taskOwnership(result, parent, taskId, unclaimed),
          holds: unclaimed ? await idleHolds(call, parent.workspace, taskId) : [] };
      }, parent.workspace);
      const permitted = scopePaths(task.expectedFiles ?? []);
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
    } else console.log('Escopo registrado para a sessão.');
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
    requireThat(args.length === 2 && plan && record?.trim(), 'Uso: approve <plano.md> "<onde e como o usuário aceitou>"');
    const entry = evidence(plan);
    requireThat(planPlace(entry.file), 'Guarde o plano em docs/work/ ou em .agent-flow/notes/.');
    requireThat(!Object.values(state.evidence).flat().some((item) => item.file === entry.file),
      'Use para o plano um arquivo distinto das evidências das etapas.');
    // Aceite novo depois da validação: o que foi validado e revisado era do plano anterior e volta para implement.
    const replan = ['validate', 'review', 'ready'].includes(state.stage);
    if (replan) {
      for (const stage of delivery) delete state.evidence[stage];
      if (state.parallel) delete state.parallel.review;
      delete state.snapshot;
      state.stage = 'implement';
      state.reopenReason = 'Novo aceite do plano';
    }
    state.approval = { plan: entry, record: record.trim(), at: new Date().toISOString(),
      ...(state.approval && { previous: { plan: state.approval.plan.file, at: state.approval.at } }) };
    if (live?.lease) assertLiveOwner(state.liveRequest);
    save(stateFile, state);
    console.log('Aceite do plano registrado.' + (replan ? ' A tarefa voltou para implement: valide e revise de novo.' : '')
      + ' O orquestrador segue até ready dentro do plano.');
    return;
  }
  if (cmd === 'advance') {
    const [current, ...files] = args;
    requireThat(current === state.stage && current !== 'ready', 'Etapa esperada: ' + state.stage + '.');
    const needed = state.ui && ['discover', 'validate'].includes(current) ? 2 : 1;
    requireThat(files.length === needed, current + ' requer ' + needed + ' arquivo(s) de evidência.');
    requireThat(!['discover', 'review'].includes(current) || state.parallel?.[current]?.children?.length >= 2,
      'Registre as frentes independentes do Concord com record-parallel antes de avançar.');
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
    if (current === 'validate') state.snapshot = captureSnapshot(root, state.publicationSelection ?? []);
    if (current === 'review') verifySnapshot(state);
    state.evidence[current] = entries;
    const stages = route(state.kind);
    state.stage = stages[stages.indexOf(current) + 1];
    save(stateFile, state);
    console.log(current + ' registrado. Próxima etapa: ' + state.stage + '.');
    return;
  }
  if (cmd === 'reopen') {
    requireThat(args.length === 1 && args[0].trim(), 'Uso: reopen "<motivo>"');
    requireThat(['validate', 'review', 'ready'].includes(state.stage), 'Só reabra após implement.');
    for (const stage of delivery) delete state.evidence[stage];
    if (state.parallel) delete state.parallel.review;
    delete state.snapshot;
    state.stage = 'implement';
    state.reopenReason = args[0].trim();
    // Reabrir não depende do aceite: com o plano mudado, a próxima edição pede o approve novo.
    verify(state, { approval: false });
    save(stateFile, state);
    console.log('Implementação reaberta; valide e revise novamente.');
    return;
  }
  if (['check', 'close'].includes(cmd) && !args.length || cmd === 'publication-plan' && args.length <= 1) {
    requireThat(state.stage === 'ready', 'Tarefa em ' + state.stage + '; ainda não está pronta.');
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
      'Registre a resposta final no Agent Live antes de arquivar.');
  }
  mkdirSync(archive, { recursive: true });
  const archived = { ...state, outcome: cmd === 'close' ? 'closed' : 'canceled',
    reason: args[0], archivedAt: new Date().toISOString() };
  save(path.join(archive, randomUUID() + '.json'), archived);
  unlinkSync(stateFile);
  console.log('Tarefa arquivada: ' + archived.outcome + '.');
}

try {
  await cli(process.argv.slice(2));
} catch (error) {
  console.error('Agent Flow: ' + error.message);
  process.exitCode = 1;
}
