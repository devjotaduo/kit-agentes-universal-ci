import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  if (result.status !== 0) throw new ConcordError('MCP Concord indisponível no Codex. Execute bootstrap.mjs concord e confirme a configuração.');
  let config;
  try { config = JSON.parse(result.stdout); } catch { throw new ConcordError('O Codex não retornou a configuração MCP esperada.'); }
  return resolveConcord(config, root);
}

function gitProjectRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'],
    { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) throw new ConcordError('Inicialize o Git na raiz do projeto antes de usar o Concord.');
  return realpathSync(result.stdout.trim());
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
    throw new ConcordError('Workspace diferente do projeto atual. Use concord.mjs workspace para confirmar o destino.');
  }
  return workspace;
}

export function projectConcordLaunch(root, portable = process.env.AGENT_FLOW_CONCORD_TRANSPORT === 'portable') {
  const project = realpathSync(root);
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
    return new ConcordError('Concord recusou os dados da operação. Confira o workspace e a referência da mensagem.', false, 'protocol');
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
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-flow', version: '1.0.0' },
    });
    send('notifications/initialized');
    return await operation(async (name, args) => {
      if (launch.disabledTools?.includes(name) || (launch.enabledTools && !launch.enabledTools.includes(name))) {
        throw new ConcordError('Ferramenta Concord desabilitada no Codex: ' + name);
      }
      const result = await request('tools/call', { name, arguments: args });
      if (!result || result.isError) {
        throw remoteError(result?.structuredContent?.error_code, result?.content?.[0]?.text);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (!['check', 'workspace'].includes(command) || process.argv.length !== 3) throw Error('Uso: node concord.mjs check|workspace');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    if (command === 'workspace') {
      const workspace = await withProjectConcord(root, async (_call, workspace) => workspace);
      console.log(JSON.stringify({ workspace_id: workspace }));
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

export async function verifyFronts(call, workspace, parent, children) {
  const inspect = (task_id) => call('inspect_work', { workspace_id: workspace, task_id });
  const [root, ...fronts] = await Promise.all([parent, ...children].map(inspect));
  if (root.task?.taskId !== parent || root.workspace_id !== workspace) throw Error('Tarefa pai ou workspace não confirmado.');
  const titles = new Set();
  const scopes = [];
  const result = fronts.map((front, index) => {
    const task = front.task;
    if (front.workspace_id !== workspace || task?.taskId !== children[index]
      || task.parentTaskId !== parent || (task.parentWorkspaceId && task.parentWorkspaceId !== workspace)
      || !['complete', 'closed', 'review_ready', 'review-ready'].includes(task.status)
      || !(front.latest_handoff?.whatChanged || front.latest_review)) {
      throw Error('Frente sem vínculo ou resultado confirmado: ' + children[index]);
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
    return { task: task.taskId, version: task.version };
  });
  return { workspace, parent, children: result, verifiedAt: new Date().toISOString() };
}

// A tarefa precisa pertencer ao pedido. A posse ativa é exigida, salvo quando ela não pode ser assumida
// (arquivo retido por agente ausente, tarefa já entregue): aí vale o motivo registrado em `unclaimed`.
export function taskOwnership(result, parent, taskId, unclaimed) {
  const task = result.task;
  const linked = result.workspace_id === parent.workspace && task?.taskId === taskId
    && (taskId === parent.parent || task.parentTaskId === parent.parent
      && (!task.parentWorkspaceId || task.parentWorkspaceId === parent.workspace));
  if (!linked) throw Error('A tarefa Concord não pertence a este pedido.');
  const owned = task.status === 'active' && Boolean(task.agentId || task.assignedAgentId)
    && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) > Date.now());
  if (!owned && !unclaimed) {
    throw Error('A tarefa Concord não confirma uma posse ativa para esta edição. Se a posse não pode ser assumida,'
      + ' registre o fato no Concord (update_work, kind "finding") e repita com --unclaimed "<motivo>".');
  }
  // O motivo cobre posse vencida e tarefa entregue; tarefa cancelada ou em outro estado não edita.
  if (!owned && !['active', 'assigned', 'review_ready', 'review-ready', 'complete', 'closed'].includes(task.status)) {
    throw Error('Tarefa Concord em estado ' + String(task.status) + ' não aceita escopo de edição.');
  }
  return owned;
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
