import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realPath } from './snapshot.mjs';
import { CONCORD, concordUpdateMessage, newer, writeCache } from './update.mjs';

export class ConcordError extends Error {
  constructor(message, retryable = false, code = retryable ? 'transport' : 'configuration') {
    super(message);
    this.name = 'ConcordError';
    this.retryable = retryable;
    this.code = code;
  }
}

function windowsConcord() {
  const npm = spawnSync('cmd.exe', ['/d', '/c', 'npm.cmd', 'root', '-g'],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
  if (npm.status !== 0) throw new ConcordError('Não foi possível localizar o Concord pelo npm. Confira o PATH ou configure o MCP com um executável.');
  const folder = path.join(npm.stdout.trim(), '@concord-ai', 'concord-mcp');
  const pkg = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  return { command: process.execPath, args: [path.resolve(folder, pkg.bin['concord-mcp'])] };
}

export function resolveConcord(config, root) {
  if (config?.enabled !== true) throw new ConcordError('MCP Concord desativado. Confira a configuração do cliente.');
  const transport = config.transport;
  if (transport?.type !== 'stdio' || typeof transport.command !== 'string' || !transport.command.trim()) {
    throw new ConcordError('O Kit requer um MCP Concord stdio. Configure um comando local.');
  }
  const command = transport.command;
  const args = transport.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new ConcordError('Argumentos do MCP Concord inválidos.');
  }
  const cwd = path.resolve(root, transport.cwd ?? '.');
  const npmShim = process.platform === 'win32' && /^concord-mcp(?:\.cmd)?$/i.test(command);
  if (process.platform === 'win32' && /\.(?:bat|cmd|ps1)$/i.test(command) && !npmShim) {
    throw new ConcordError('Configure um executável para o wrapper Concord no Windows, por exemplo node com o caminho do script nos argumentos.');
  }
  const launch = npmShim ? windowsConcord() : { command, args: [] };
  const env = { ...process.env, ...transport.env };
  for (const variable of transport.env_vars ?? []) {
    if (env[variable] === undefined) throw new ConcordError('Uma variável de ambiente exigida pelo MCP Concord está ausente.');
  }
  return {
    command: launch.command, args: [...launch.args, ...args], cwd, env,
    enabledTools: config.enabled_tools, disabledTools: config.disabled_tools,
    description: { transport: 'stdio', command: path.basename(command), arguments: args.length,
      customCwd: Boolean(transport.cwd), environment: Object.keys(transport.env ?? {}).length + (transport.env_vars ?? []).length },
  };
}

function configuredConcord(root, portable = process.env.AGENT_FLOW_CONCORD_TRANSPORT === 'portable') {
  const configPath = process.env.AGENT_FLOW_CONCORD_CONFIG;
  if (configPath) {
    if (!path.isAbsolute(configPath)) throw new ConcordError('AGENT_FLOW_CONCORD_CONFIG deve apontar para um caminho absoluto.');
    let config;
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { throw new ConcordError('Não foi possível ler a configuração stdio do Concord.'); }
    return resolveConcord(config, root);
  }
  if (portable) {
    return resolveConcord({ enabled: true, transport: { type: 'stdio', command: 'concord-mcp' } }, root);
  }
  const result = spawnSync('codex', ['mcp', 'get', 'concord', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) throw new ConcordError('MCP Concord indisponível no Codex. Execute node .agent-kit/kit.mjs --client codex setup e confirme a configuração.');
  let config;
  try { config = JSON.parse(result.stdout); } catch { throw new ConcordError('O Codex não retornou a configuração MCP esperada.'); }
  return resolveConcord(config, root);
}

function gitProjectRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'],
    { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) throw new ConcordError('Inicialize o Git na raiz do projeto antes de usar o Concord.');
  return realPath(result.stdout.trim());
}

function gitMainWorktree(root) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'],
    { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  const first = result.stdout?.split('\0')[0];
  if (result.status !== 0 || !first?.startsWith('worktree ')) {
    throw new ConcordError('Não foi possível identificar a worktree principal do projeto.');
  }
  return gitProjectRoot(first.slice('worktree '.length));
}

export function requireProjectWorkspace(workspace, expected) {
  if (typeof workspace !== 'string' || !workspace.trim() || ['general', '*'].includes(workspace.trim().toLowerCase())) {
    throw new ConcordError('Use o workspace específico do projeto. O workspace general e seletores globais são proibidos.');
  }
  if (expected !== undefined && workspace !== expected) {
    throw new ConcordError('Workspace diferente do projeto atual. Use node .agent-kit/kit.mjs concord workspace para confirmar o destino.');
  }
  return workspace;
}

export function projectConcordLaunch(root, portable = process.env.AGENT_FLOW_CONCORD_TRANSPORT === 'portable') {
  const project = realPath(root);
  if (gitProjectRoot(root) !== project) throw new ConcordError('Execute o kit na raiz do projeto Git.');
  const launch = configuredConcord(root, portable);
  if (gitProjectRoot(launch.cwd) !== project) throw new ConcordError('O cwd configurado do MCP Concord aponta para outro projeto.');
  const primary = gitMainWorktree(root);
  if (launch.description.customCwd && primary !== project) {
    throw new ConcordError('Para compartilhar o workspace entre worktrees, remova o cwd fixo do MCP Concord.');
  }
  if (!launch.description.customCwd) launch.cwd = primary;
  if (portable || process.env.AGENT_FLOW_CONCORD_CONFIG) {
    launch.env.CONCORD_REPO_ROOT = primary;
    launch.env.CONCORD_ALLOWED_ROOTS ??= primary;
  }
  return launch;
}

export async function withProjectConcord(root, operation, expected) {
  if (expected !== undefined) requireProjectWorkspace(expected);
  const launch = projectConcordLaunch(root);
  return withConcord(root, async (call) => {
    const context = await call('inspect_work', {});
    if (context.scope !== 'workspace') throw new ConcordError('O Concord não confirmou o workspace do projeto.');
    const workspace = requireProjectWorkspace(context.workspace_id, expected);
    return operation((name, args) => {
      requireProjectWorkspace(args.workspace_id, workspace);
      return call(name, args);
    }, workspace);
  }, launch);
}

function remoteError(code, detail) {
  const reason = String(code ?? '') + ' ' + String(detail ?? '');
  if (/unauthori[sz]ed|forbidden|permission|authentication|api key|credential|\b40[13]\b/i.test(reason)) {
    return new ConcordError('Concord recusou a identidade ou a permissão. Confira a autenticação e o vínculo com a mensagem.', false, 'unauthorized');
  }
  if ([-32600, -32601, -32602].includes(code)
    || /not.found|does not exist|invalid|unsupported|conflict/i.test(reason)) {
    // O motivo que o Concord deu (campo, tarefa ou workspace recusado), numa linha e curto.
    const cause = String(detail ?? '').replace(/\s+/g, ' ').trim().replace(/received.*$/i, '').slice(0, 160);
    return new ConcordError('Concord recusou os dados da operação' + (cause ? ': ' + cause : ' (sem motivo no retorno)')
      + '. Confira o workspace e a referência da mensagem; se usou --workspace, mantenha-o ao repetir.', false, 'protocol');
  }
  return new ConcordError('O Concord não confirmou a operação. Tente novamente.', true);
}

export async function withConcord(cwd, operation, launch = configuredConcord(cwd)) {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd ?? cwd, env: launch.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let sequence = 0;
  let failed;
  const pending = new Map();
  function fail(error) {
    failed = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  child.on('error', (error) => fail(new ConcordError('Não foi possível iniciar o comando MCP Concord.',
    !['ENOENT', 'EACCES'].includes(error.code))));
  child.stdin.on('error', () => fail(new ConcordError('O canal MCP Concord foi interrompido.', true)));
  child.on('exit', () => fail(new ConcordError('O processo MCP Concord encerrou.', true)));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(remoteError(message.error.code, message.error.message));
    else request.resolve(message.result);
  });
  function send(method, params, id) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== undefined && { id }) }) + '\n');
  }
  function request(method, params) {
    if (failed) return Promise.reject(failed);
    const id = ++sequence;
    let timer;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new ConcordError('Tempo esgotado ao consultar o MCP Concord.', true, 'timeout'));
      }, 6000);
      send(method, params, id);
    }).finally(() => clearTimeout(timer));
  }
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-flow', version: '1.0.0' },
    });
    const server = initialized?.serverInfo;
    if (server?.name === 'concord-mcp') {
      const version = typeof server.version === 'string' && /^\d+\.\d+\.\d+$/.test(server.version) ? server.version : null;
      if (!version || newer(CONCORD.version, version)) {
        throw new ConcordError(concordUpdateMessage(version ?? 'estável não comprovada na sessão'), false, 'upgrade-required');
      }
    }
    send('notifications/initialized');
    // Uma chamada por vez: concord-mcp 0.22 trava ~10 s e falha ("Failed query") com chamadas simultâneas no mesmo
    // processo, e o tempo limite de 6 s só começa quando a chamada sai da fila.
    let queue = Promise.resolve();
    return await operation(async (name, args) => {
      if (launch.disabledTools?.includes(name) || (launch.enabledTools && !launch.enabledTools.includes(name))) {
        throw new ConcordError('Ferramenta Concord desabilitada no Codex: ' + name);
      }
      const turn = queue.then(() => request('tools/call', { name, arguments: args }));
      queue = turn.catch(() => {});
      const result = await turn;
      if (!result || result.isError) {
        throw remoteError(result?.structuredContent?.error_code, result?.content?.[0]?.text);
      }
      const latest = result.structuredContent?.update_available?.latest_version;
      if (name === 'inspect_work' && server?.name === 'concord-mcp' && newer(latest, server.version)) {
        throw new ConcordError(concordUpdateMessage(server.version, latest), false, 'upgrade-required');
      }
      if (result.structuredContent) return result.structuredContent;
      const content = result.content?.find((item) => item.type === 'text')?.text;
      try { return JSON.parse(content); } catch { throw new ConcordError('O MCP não retornou evidência estruturada.'); }
    }, async () => (await request('tools/list', {}))?.tools ?? []);
  } finally {
    lines.close();
    child.stdin.end();
    // Closing stdin lets a stdio bridge wait for its backend to exit.
    let shutdown;
    await Promise.race([closed, new Promise((resolve) => {
      shutdown = setTimeout(() => {
        child.kill();
        child.stdout.destroy();
        resolve();
      }, 1000);
    })]);
    clearTimeout(shutdown);
  }
}

// PRs deste repositório, mesclados na branch padrão, cuja branch é a da tarefa. Sem resposta do GitHub nada é fechado.
function mergedPullRequests(root, branch) {
  const gh = (args) => {
    const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (result.status !== 0) {
      throw new ConcordError('O GitHub não respondeu (' + (result.error?.code ?? result.stderr?.trim().split('\n')[0] ?? 'gh falhou')
        + '). Nada foi fechado.');
    }
    return JSON.parse(result.stdout);
  };
  // O mesmo repositório para os PRs e para a branch: o `{owner}/{repo}` do gh api pode resolver outro remoto.
  const repo = gh(['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner']);
  const base = repo.defaultBranchRef?.name;
  // PR mesclado em outra branch (empilhado) ainda não chegou à principal; PR de fork não é a entrega desta tarefa.
  if (!base || !repo.nameWithOwner || branch === base || !/^[\w.][\w./-]*$/.test(branch)) return [];
  const pulls = gh(['pr', 'list', '--state', 'merged', '--head', branch, '--base', base, '--limit', '30',
    '--json', 'url,mergedAt,isCrossRepository,headRefOid']).filter((pr) => pr.isCrossRepository === false);
  if (!pulls.length) return pulls;
  // A branch no mesmo repositório que o gh consulta (o origin pode ser um fork). 404 é branch apagada.
  const remote = spawnSync('gh', ['api', 'repos/' + repo.nameWithOwner + '/git/ref/heads/' + branch, '--jq', '.object.sha'],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (remote.status !== 0 && !/HTTP 404/.test(remote.stderr ?? '')) {
    throw new ConcordError('O GitHub não respondeu ao conferir a branch ' + branch + ' ('
      + (remote.error?.code ?? remote.stderr?.trim().split('\n')[0] ?? 'gh falhou') + '). Nada foi fechado.');
  }
  // A branch local, se existir: commits ainda não enviados também são trabalho depois do merge.
  const local = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch],
    { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (local.status !== 0 && local.status !== 1) {
    throw new ConcordError('Não foi possível conferir a branch local ' + branch + '. Nada foi fechado.');
  }
  return markCurrent(pulls, remote.status === 0 ? remote.stdout.trim() : '', local.status === 0 ? local.stdout.trim() : '');
}

// A tarefa pode ter sido atualizada depois do merge (nota, ida a review_ready). O PR mais recente ainda é a entrega
// dela quando há uma ref que confirma o commit do PR e nenhuma aponta para outro commit. Sem ref, a data
// de criação sozinha não distingue uma atualização de estado de um novo trabalho na branch reutilizada.
export function markCurrent(pulls, remote, local) {
  const last = pulls.reduce((a, b) => (Date.parse(b.mergedAt) > Date.parse(a.mergedAt) ? b : a), pulls[0]);
  const heads = [remote, local].filter(Boolean);
  if (last) last.current = heads.length > 0 && heads.every((head) => head === last.headRefOid);
  return pulls;
}

// Tarefa entregue continua retendo os arquivos até ser fechada. Depois do merge, fecha as do próprio agente
// e aponta as dos outros: só o dono muda o ciclo de vida da tarefa.
export async function closeMerged(call, workspace, agent, merged, dryRun) {
  const view = await call('inspect_work', { workspace_id: workspace });
  const present = new Set((view.presence ?? []).filter((item) => item?.present).map((item) => item.agentId));
  const found = [];
  // Primeiro confere tudo no GitHub: uma falha ali interrompe antes de qualquer fechamento.
  for (const entry of (view.review_ready ?? []).filter(Boolean)) {
    const { task } = await call('inspect_work', { workspace_id: workspace, task_id: entry.taskId });
    // Vale o PR mesclado depois da última atualização da tarefa, ou o PR `current` (a branch não andou depois dele)
    // mesclado depois de a tarefa nascer: PR anterior à tarefa é de outro trabalho na mesma branch.
    // Data ausente ou inválida mantém a tarefa.
    const [ready, created] = [task?.updatedAt ?? task?.createdAt, task?.createdAt].map((date) => Date.parse(date));
    const pr = task?.branch ? merged(task.branch).find((item) => Date.parse(item.mergedAt) >= ready
      || (item.current && Date.parse(item.mergedAt) >= created)) : null;
    found.push({ id: entry.taskId, task, pr });
  }
  const out = [];
  for (const { id, task, pr } of found) {
    if (!pr) {
      out.push({ task: id, action: 'kept', reason: task?.branch ? 'sem PR mesclado na branch principal depois da entrega' : 'tarefa sem branch registrada' });
    } else if (task.agentId !== agent) {
      // Com a presença do dono e os arquivos retidos, para o usuário decidir sem abrir tarefa por tarefa.
      out.push({ task: id, action: 'owner', owner: task.agentId, present: present.has(task.agentId),
        files: task.expectedFiles ?? [], pr: pr.url });
    } else {
      try {
        if (!dryRun) {
          await call('finish_work', { workspace_id: workspace, agent_id: agent, task_id: id,
            expected_version: task.version, outcome: 'complete', what_changed: 'PR mesclado: ' + pr.url, reason: 'PR mesclado: ' + pr.url });
        }
        out.push({ task: id, action: dryRun ? 'would-close' : 'closed', pr: pr.url });
      } catch (error) {
        // Uma recusa não esconde o que já foi fechado nem impede as demais.
        out.push({ task: id, action: 'error', reason: error.message, pr: pr.url });
      }
    }
  }
  return out;
}

function verifyReview(front, task, reference, authors) {
  const delivery = front.latest_handoff;
  // O handoff terminal não atribui fromAgentId. A identidade vem do evento de
  // fechamento gravado pelo Concord na mesma transação, na versão atual da tarefa.
  const closer = front.ownership_history?.find((entry) => entry.transition === 'close'
    && entry.taskId === task.taskId && entry.toVersion === task.version);
  const reviewer = closer?.actorAgentId;
  if (!reviewer || reviewer !== closer.fromAgentId || reviewer !== task.agentId
    || !['complete', 'closed'].includes(task.status) || closer.toStatus !== task.status
    || delivery?.taskId !== task.taskId || delivery.status !== task.status || delivery.deliveryStatus !== 'recorded'
    || closer.reason !== delivery.whatChanged || !(Date.parse(delivery.createdAt) <= Date.parse(closer.createdAt))) {
    throw Error('Frente ' + task.taskId + ' sem identidade de revisor comprovada. Quem revisou deve concluir a frente com finish_work, sem reason personalizado.');
  }
  if (authors.has(reviewer)) throw Error('Frente ' + task.taskId + ' entregue pelo mesmo agente que implementou ou orquestrou a entrega: ' + reviewer
    + '. Abra a revisão em outra sessão com identidade própria no Concord, seguindo docs/orquestracao.md.');
  const refs = delivery.guardrailsChecked?.filter((entry) => typeof entry === 'string' && entry.startsWith('agent-flow-reviewed-snapshot:')) ?? [];
  if (refs.length !== 1 || refs[0] !== reference) {
    throw Error('Frente ' + task.taskId + ' não comprova a revisão do conteúdo validado. Use flow review-reference e registre a referência em guardrails_checked.');
  }
  // O MCP local 0.22.0 expõe review; o esquema do conector Codex expõe reviewer.
  if (!['review', 'reviewer'].includes(delivery.reportedOutcome?.source) || delivery.reportedOutcome.acceptance !== 'accepted') {
    throw Error('Frente ' + task.taskId + ' sem parecer de revisão aceito. Use reported_outcome com source review (reviewer quando o cliente usar esse nome) e acceptance accepted.');
  }
  return reviewer;
}

// A revisão conferida também exige a identidade efetiva, o conteúdo validado e o parecer.
export async function verifyFronts(call, workspace, parent, children, after, review) {
  const inspect = (task_id) => call('inspect_work', { workspace_id: workspace, task_id });
  const [root, ...fronts] = await Promise.all([parent, ...children].map(inspect));
  if (root.task?.taskId !== parent || root.workspace_id !== workspace) throw Error('Tarefa pai ou workspace não confirmado.');
  const owner = root.task.agentId;
  if (review && !owner) throw Error('Falta identidade do agente da tarefa principal no Concord; confirme a posse antes da revisão.');
  const authors = new Set([owner, ...(review?.authors ?? [])]);
  const titles = new Set();
  const scopes = [];
  const result = fronts.map((front, index) => {
    const task = front.task;
    if (front.workspace_id !== workspace || task?.taskId !== children[index]
      || task.parentTaskId !== parent || (task.parentWorkspaceId && task.parentWorkspaceId !== workspace)
      || !['complete', 'closed', 'review_ready', 'review-ready'].includes(task.status)
      || !(front.latest_handoff?.whatChanged || front.latest_review)) {
      throw Error('Frente sem vínculo ou resultado confirmado: ' + children[index] + '. A frente precisa ter parent_task_id '
        + JSON.stringify(parent) + ' neste workspace e estar fechada com finish_work (review_ready ou complete, com what_changed).');
    }
    if (after) {
      // Vale a data da entrega (handoff com whatChanged): o updatedAt muda com qualquer update_work, e um
      // latest_review novo pode ter sido registrado sobre trabalho antigo. Sem tolerância de relógio.
      const done = front.latest_handoff?.whatChanged ? Date.parse(front.latest_handoff.createdAt) : NaN;
      if (!(done >= Date.parse(after))) {
        throw Error('Entrega da frente ' + children[index] + ' anterior à validação da versão corrigida (' + after + ')'
          + ' ou sem data no Concord. Conclua a frente de novo sobre a versão validada ou registre outra.');
      }
    }
    const title = task.title?.trim().toLowerCase();
    if (!title || titles.has(title)) throw Error('As frentes precisam de objetivos distintos.');
    titles.add(title);
    for (const file of task.expectedFiles ?? []) {
      const declared = file.replaceAll('\\', '/').replace(/\/\*\*?$/, '').replace(/\/$/, '');
      if (scopes.some(({ scope, child }) => child !== task.taskId
        && (scope === declared || scope.startsWith(declared + '/') || declared.startsWith(scope + '/')))) {
        throw Error('Escopos declarados se sobrepõem: ' + file);
      }
      scopes.push({ scope: declared, child: task.taskId });
    }
    const reviewer = review && verifyReview(front, task, review.reference, authors);
    return { task: task.taskId, version: task.version, ...(reviewer && { reviewer }) };
  });
  return { workspace, parent, children: result, verifiedAt: new Date().toISOString(),
    ...(owner && { owner }), ...(review && { reviewReference: review.reference }) };
}

// A tarefa precisa pertencer ao pedido. A posse ativa é exigida, salvo quando ela não pode ser assumida
// (arquivo retido por agente ausente, tarefa já entregue): aí vale o motivo registrado em `unclaimed`.
// Com a identidade de quem chama (`me`, de CONCORD_AGENT_ID), só a tarefa dele conta como posse; sem ela, qualquer dono.
// Guarda de conveniência, não de segurança: o processo não distingue a variável própria da herdada de quem o lançou.
export const callerAgentId = (env = process.env) => env.CONCORD_AGENT_ID?.trim() || undefined;
export function taskOwnership(result, parent, taskId, unclaimed, me) {
  const task = result.task;
  const linked = result.workspace_id === parent.workspace && task?.taskId === taskId
    && (taskId === parent.parent || task.parentTaskId === parent.parent
      && (!task.parentWorkspaceId || task.parentWorkspaceId === parent.workspace));
  if (!linked) throw Error('A tarefa Concord não pertence a este pedido.');
  const owner = task.agentId || task.assignedAgentId;
  const owned = task.status === 'active' && Boolean(owner) && (!me || owner === me)
    && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > Date.now());
  if (!owned && !unclaimed) {
    throw Error('A tarefa Concord não confirma uma posse ativa para esta edição'
      + (me && owner && owner !== me ? ' (dona: ' + owner + ', você: ' + me + ')' : '') + '. Se a posse não pode ser assumida,'
      + ' registre o fato no Concord (update_work, kind "finding") e repita com --unclaimed "<motivo>".');
  }
  // O motivo cobre posse vencida e tarefa entregue; tarefa cancelada ou em outro estado não edita.
  if (!owned && !['active', 'assigned', 'review_ready', 'review-ready', 'complete', 'closed'].includes(task.status)) {
    throw Error('Tarefa Concord em estado ' + String(task.status) + ' não aceita escopo de edição.');
  }
  return owned;
}

// Caminho sem o sufixo de pasta, para comparar um escopo com o que outra tarefa declarou no Concord.
const barePath = (file) => file.replaceAll('\\', '/').replace(/\/\*\*?$/, '').replace(/\/$/, '');
// `ci` compara sem caixa (Windows); o `heldBy`, checagem de segurança, continua exato.
export const holdCovers = (hold, file, ci = false) => {
  const [h, f] = [barePath(hold), barePath(file)].map((p) => (ci ? p.toLowerCase() : p));
  return f === h || f.startsWith(h + '/');
};
export const heldBy = (holds, file) => holds.some((hold) => holdCovers(hold, file));

// Todos os donos dos arquivos de uma vez: tarefas ativas, paradas e aguardando revisão, com a presença do dono.
export async function holdersOf(call, workspace, files, platform = process.platform) {
  const ci = platform === 'win32';
  const view = await call('inspect_work', { workspace_id: workspace });
  const presence = new Map((view.presence ?? []).map((agent) => [agent.agentId, agent]));
  const listed = [['ativa', view.active], ['parada', view.stale_claims], ['aguardando revisão', view.review_ready]]
    .flatMap(([state, list]) => (list ?? []).map((task) => [task?.taskId, state]))
    .filter(([id], index, all) => id && all.findIndex(([other]) => other === id) === index);
  const tasks = await Promise.all(listed.map(async ([task_id, state]) =>
    ({ state, task: (await call('inspect_work', { workspace_id: workspace, task_id })).task ?? {} })));
  return files.map((file) => ({ file, holders: tasks.flatMap(({ state, task }) => {
    // Nos dois sentidos, como o start_work: a reserva contém o arquivo pedido, ou a pasta pedida contém a reserva.
    const hold = (task.expectedFiles ?? []).find((item) => holdCovers(item, file, ci) || holdCovers(file, item, ci));
    if (!hold) return [];
    const owner = task.assignedAgentId ?? task.agentId ?? null;
    const agent = presence.get(owner);
    return [{ task: task.taskId, state, owner, present: Boolean(agent?.present), lastSeen: agent?.lastSeen ?? null,
      ...(holdCovers(file, hold, ci) || { folder: hold }) }];
  }) }));
}

export function formatHolders(result, me) {
  const lines = result.map(({ file, holders }) => file + ': ' + (holders.length ? holders.map((item) =>
    item.task + ' (' + item.state + ') de ' + (item.owner === me ? 'você' : item.owner ?? 'dono desconhecido')
    + (item.owner === me ? '' : item.present ? ', presente' : ', ausente' + (item.lastSeen ? ' desde ' + item.lastSeen : ''))
    + (item.folder ? ', pela reserva da pasta ' + item.folder : '')).join('; ') : 'livre'));
  const others = result.flatMap(({ holders }) => holders).filter((item) => item.owner !== me);
  if (others.some((item) => item.state === 'ativa' && item.present)) {
    lines.push('Dono ativo e presente: combine com ele por update_work prompt antes de reservar.');
  }
  if (others.some((item) => item.state !== 'ativa' || !item.present)) {
    lines.push('Tarefa parada, aguardando revisão ou de dono ausente: registre a sua com os arquivos livres e, num pedido'
      + ' vinculado, use node .agent-kit/kit.mjs flow scope --task <tarefa> --unclaimed "<motivo>" -- <arquivos>.');
  }
  return lines.join('\n');
}

// Arquivos retidos por tarefas que não vão liberá-los agora: posse parada ou entrega aguardando revisão.
export async function idleHolds(call, workspace, own) {
  const view = await call('inspect_work', { workspace_id: workspace });
  const ids = [...(view.stale_claims ?? []), ...(view.review_ready ?? [])]
    .map((task) => task?.taskId).filter((id) => id && id !== own);
  const tasks = await Promise.all(ids.map((task_id) => call('inspect_work', { workspace_id: workspace, task_id })));
  return tasks.flatMap((result) => result.task?.expectedFiles ?? []);
}

export function replyArguments(report, workspace, agent) {
  if (report.channel !== 'concord' || !report.closed || !report.replyKey) throw Error('Pedido sem resposta Concord.');
  return {
    operation: 'reply', workspace_id: workspace, agent_id: agent,
    reply_to_message_id: report.reference, content: report.message, idempotency_key: report.replyKey,
  };
}

// A linha de comando fica no fim: ela roda na avaliação do módulo e usa as constantes declaradas acima.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    const dryRun = command === 'close-merged' && process.argv[3] === '--dry-run';
    const files = command === 'holds' && process.argv[3] === '--' ? process.argv.slice(4) : null;
    if (files ? !files.length : !['check', 'workspace', 'close-merged', 'stale'].includes(command) || process.argv.length !== (dryRun ? 4 : 3)) {
      throw Error('Uso: node .agent-kit/kit.mjs concord check|workspace|close-merged [--dry-run]|stale|holds -- <arquivos>');
    }
    const root = fileURLToPath(new URL('../../', import.meta.url));
    if (files) {
      const result = await withProjectConcord(root, (call, workspace) => holdersOf(call, workspace, files));
      console.log(formatHolders(result, process.env.CONCORD_AGENT_ID?.trim()));
    } else if (command === 'stale' || command === 'close-merged') {
      const agent = process.env.CONCORD_AGENT_ID?.trim();
      if (!agent) throw Error('Configure CONCORD_AGENT_ID com a identidade efetiva desta sessão.');
      const stale = command === 'stale';
      const result = await withProjectConcord(root,
        (call, workspace) => closeMerged(call, workspace, agent, (branch) => mergedPullRequests(root, branch), stale || dryRun));
      console.log(JSON.stringify(stale ? result.filter((item) => item.action === 'owner') : result, null, 2));
      if (result.some((item) => item.action === 'error')) process.exitCode = 1;
    } else if (command === 'workspace') {
      const workspace = await withProjectConcord(root, async (_call, workspace) => workspace);
      console.log(JSON.stringify({ workspace_id: workspace }));
      // O início da sessão só lê este cache: consultar o Concord não cabe no tempo do hook.
      // Sem cache o início da sessão só deixa de mostrar o workspace; o valor acima já saiu.
      try {
        writeCache(root, { workspace_id: workspace, at: new Date().toISOString() },
          path.join(root, '.agent-flow', 'concord-workspace.json'));
      } catch {}
    } else {
      const launch = process.env.AGENT_FLOW_CONCORD_TRANSPORT === 'portable' || process.env.AGENT_FLOW_CONCORD_CONFIG
        ? projectConcordLaunch(root)
        : configuredConcord(root);
      await withConcord(root, async (_call, list) => {
        const tools = await list();
        for (const name of ['inspect_work', 'update_work']) {
          if (!tools.some((tool) => tool.name === name) || launch.disabledTools?.includes(name)
            || (launch.enabledTools && !launch.enabledTools.includes(name))) {
            throw new ConcordError('Ferramenta necessária indisponível: ' + name);
          }
        }
      }, launch);
      console.log(JSON.stringify({ status: 'connected', ...launch.description }));
    }
  } catch (error) {
    console.error('Concord: ' + error.message);
    process.exitCode = 1;
  }
}
