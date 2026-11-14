import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { ConcordError, replyArguments, requireProjectWorkspace, withProjectConcord } from './concord.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(root, '.agent-flow', 'live');
const terminal = new Set(['done', 'blocked', 'canceled']);
const events = new Set(['queued', 'running', 'heartbeat', 'waiting', ...terminal]);
const deliveryRetrySeconds = 600;
const attemptWindowMs = 20000;
function config() {
  const policy = JSON.parse(readFileSync(new URL('../live-policy.json', import.meta.url), 'utf8'));
  ensure(['pollMs', 'heartbeatSeconds', 'silentSeconds', 'hardSeconds'].every((key) => Number.isSafeInteger(policy[key]))
    && policy.pollMs >= 100 && policy.heartbeatSeconds > 0 && policy.silentSeconds > policy.heartbeatSeconds
    && policy.hardSeconds >= policy.silentSeconds
    && (policy.maxHardSeconds === undefined
      || Number.isSafeInteger(policy.maxHardSeconds) && policy.maxHardSeconds >= policy.hardSeconds)
    && (policy.deliveryRetrySeconds === undefined || (
      Number.isSafeInteger(policy.deliveryRetrySeconds) && policy.deliveryRetrySeconds > 0
    )), 'Política de supervisão inválida.');
  return policy;
}

function ensure(ok, why) { if (!ok) throw Error(why); }
function id(value) {
  ensure(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value), 'ID inválido.');
  return value.toLowerCase();
}
function directory(request) { return path.join(base, id(request)); }

class SequenceConflict extends Error {
  constructor() {
    super('O pedido mudou em outra sessão. Consulte o estado e tente novamente.');
  }
}

function append(dir, event) {
  const file = randomUUID();
  const tmp = path.join(dir, file + '.tmp');
  writeFileSync(tmp, JSON.stringify(event) + '\n', { flag: 'wx' });
  try {
    linkSync(tmp, path.join(dir, String(event.seq).padStart(12, '0') + '.json'));
  } catch (error) {
    if (error.code === 'EEXIST') throw new SequenceConflict();
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

function tryAppend(dir, event) {
  try {
    append(dir, event);
    return true;
  } catch (error) {
    if (error instanceof SequenceConflict) return false;
    throw error;
  }
}

function read(dir) {
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map(
    (file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')),
  ).sort((a, b) => a.seq - b.seq);
}

function existingOrigin(initial, candidates) {
  if (initial.channel !== 'concord') return undefined;
  const matches = (candidate, routeWorkspace) => {
    if (candidate?.channel !== 'concord' || candidate.reference !== initial.reference) return false;
    if (initial.workspace === undefined) return candidate.workspace === undefined;
    return initial.workspace === (candidate.workspace ?? routeWorkspace);
  };
  const indexed = candidates.find((candidate) => matches(candidate));
  if (indexed) return indexed;

  // An older installation may already have requests on disk with no registry entry.
  const byRequest = new Map(candidates.map((candidate) => [candidate.request, candidate]));
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = byRequest.get(entry.name);
    if (candidate && (!initial.workspace || candidate.workspace || candidate.reference !== initial.reference)) continue;
    const timeline = read(path.join(base, entry.name));
    const original = timeline[0];
    if (matches(original, timeline.findLast((event) => event.type === 'route')?.workspace)) return original;
  }
  return undefined;
}

function openRequest(initial) {
  const registry = path.join(base, '.open-requests');
  mkdirSync(registry, { recursive: true });
  for (;;) {
    const records = read(registry);
    const candidates = records.map(({ initial: candidate }) => candidate);
    const saved = existingOrigin(initial, candidates) ?? candidates.find((candidate) =>
      candidate.request === initial.request && candidate.channel === initial.channel
      && candidate.reference === initial.reference && candidate.workspace === initial.workspace);
    if (saved) {
      const target = directory(saved.request);
      mkdirSync(target, { recursive: true });
      if (read(target).length === 0 && tryAppend(target, saved) && saved.request === initial.request) return;
      throw Error((initial.channel === 'concord' ? 'Origem Concord já registrada.' : 'Pedido já existe.')
        + ' Use o pedido ' + saved.request + '.');
    }
    const target = directory(initial.request);
    ensure(!candidates.some((candidate) => candidate.request === initial.request)
      && !existsSync(target), 'Pedido já existe; use status ou watch.');
    if (!tryAppend(registry, { seq: (records.at(-1)?.seq ?? 0) + 1, initial })) continue;
    mkdirSync(target, { recursive: true });
    tryAppend(target, initial);
    return;
  }
}

export function evaluate(timeline, now, policy) {
  const initial = timeline[0];
  ensure(initial?.type === 'open', 'Pedido ainda não registrado.');
  const tasks = new Map([['root', { task: 'root', state: 'running', at: initial.at, message: initial.message }]]);
  let receipt = null;
  let lease = null;
  let route = null;
  let retry = null;
  for (const e of timeline.slice(1)) {
    if (e.type === 'receipt') { receipt = e; continue; }
    if (e.type === 'lease') {
      lease = e;
      const parent = tasks.get('root');
      tasks.set('root', { ...parent, at: e.at });
      continue;
    }
    if (e.type === 'route') { route = e; continue; }
    if (['delivery-attempt', 'delivery-error', 'delivery-reset'].includes(e.type)) {
      retry = {
        attempts: e.attempt, deadlineAt: e.deadlineAt, nextAt: e.nextAt,
        state: e.state, code: e.code ?? null,
      };
      continue;
    }
    const last = tasks.get(e.task);
    const state = e.state === 'heartbeat' ? last.state : e.state;
    const optional = e.optional ?? last?.optional;
    const replaces = e.replaces ?? last?.replaces;
    tasks.set(e.task, { task: e.task, state, at: e.at, message: e.message,
      ...(optional && { optional: true }), ...(replaces && { replaces }) });
    if (e.task === 'root' && e.leaseExpiresAt && lease) lease = { ...lease, expiresAt: e.leaseExpiresAt };
  }
  const rows = [...tasks.values()];
  const workers = rows.filter((task) => task.task !== 'root');
  const parent = tasks.get('root');
  const closed = terminal.has(parent.state);
  const hardDeadline = initial.at + policy.hardSeconds * 1000;
  const silent = (task) => !terminal.has(task.state) && now - task.at >= policy.silentSeconds * 1000;
  const timeout = closed ? null : now >= hardDeadline ? 'hard-deadline' : silent(parent) ? 'orchestrator-silent' : null;
  return {
    request: initial.request, channel: initial.channel, reference: initial.reference,
    ...(initial.workspace && { workspace: initial.workspace }),
    sequence: timeline.at(-1).seq, deadline: new Date(hardDeadline).toISOString(),
    state: parent.state, message: parent.message, closed, timeout,
    silentTasks: closed ? [] : rows.filter((task) => task.task !== 'root' && silent(task)).map((task) => task.task),
    tasks: rows,
    progress: { total: workers.length, done: workers.filter((task) => task.state === 'done').length,
      waiting: workers.filter((task) => task.state === 'waiting').map((task) => task.task) },
    replyKey: initial.replyKey ?? 'agent-flow-' + digest(initial.reference + ':' + initial.request),
    route: route && { workspace: route.workspace, agent: route.agent },
    lease: lease && { owner: lease.owner, generation: lease.seq, expiresAt: lease.expiresAt, expired: now >= lease.expiresAt },
    delivery: receipt ? { state: 'recorded', reference: receipt.message, ...(retry && { attempts: retry.attempts }) }
      : { state: closed ? 'pending' : 'not-final', ...(retry && { retry }) },
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertLiveOwner(request) {
  const timeline = read(directory(request));
  const report = evaluate(timeline, Date.now(), timeline[0]?.policy ?? config());
  requireOwner(timeline, report);
  return report;
}

function requireOwner(timeline, report) {
  const current = timeline.findLast((event) => event.type === 'lease');
  if (!current) return; // Compatibility with requests created before leases.
  const token = process.env.AGENT_FLOW_LEASE;
  ensure(!report.lease.expired && token && digest(token) === current.tokenHash,
    'Posse ausente, expirada ou substituída. Consulte status e use claim para retomar.');
  ensure(report.timeout !== 'hard-deadline', 'O prazo total foi atingido.');
}

export async function acknowledgeRead(workspace, reference, agent, send) {
  ensure(agent, 'Use a identidade Concord da sessão destinatária para confirmar a leitura.');
  const inspected = await send('inspect_work', { workspace_id: workspace, message_id: reference });
  const message = inspected.thread?.find((item) => (item.messageId ?? item.message_id) === reference);
  ensure((message?.recipientAgentId ?? message?.recipient_agent_id) === agent,
    'Somente a sessão destinatária pode confirmar a leitura.');
  const receipt = message.receipt;
  if (receipt?.read_at || receipt?.status === 'replied') return { receipt };
  ensure(receipt?.status === 'delivered' || receipt?.status === 'read',
    'Receba a mensagem pelo inbox Concord antes de confirmar a leitura.');
  return send('update_work', {
    workspace_id: workspace, operation: 'reply', reply_to_message_id: reference,
    content: 'Confirmação de leitura do Agent Flow.', idempotency_key: 'agent-flow-read-' + digest(reference),
  });
}

export async function flushReply(report, send) {
  if (report.channel !== 'concord' || report.delivery.state !== 'pending') return null;
  ensure(report.route, 'Informe o workspace e a identidade Concord do orquestrador.');
  const result = await send('update_work', replyArguments(report, report.route.workspace, report.route.agent));
  const message = result.message ?? result;
  const receipt = message.message_id ?? message.messageId;
  if (message.status === 'failed') throw new ConcordError('O Concord recusou a resposta.', false, 'protocol');
  if (typeof receipt !== 'string' || !receipt) {
    throw new ConcordError('O Concord não confirmou o identificador da resposta.', true, 'protocol');
  }
  return receipt;
}

function retryCode(error) {
  const codes = ['configuration', 'unauthorized', 'protocol', 'timeout', 'transport'];
  return codes.includes(error?.code) ? error.code : 'transport';
}

async function deliveryAttempt(dir, report, next, policy, connect) {
  const retry = report.delivery.retry;
  const attempt = (retry?.attempts ?? 0) + 1;
  const deadlineAt = retry?.deadlineAt ?? next.at + (policy.deliveryRetrySeconds ?? deliveryRetrySeconds) * 1000;
  const event = { ...next, type: 'delivery-attempt', state: 'sending', attempt, deadlineAt,
    nextAt: next.at + attemptWindowMs };
  if (!tryAppend(dir, event)) return;

  let receipt;
  let failure;
  try {
    receipt = await connect(root, (call) => flushReply(report, call), report.route.workspace);
  } catch (error) {
    failure = error ?? Error('O Concord não confirmou a operação.');
  }
  for (;;) {
    const timeline = read(dir);
    const now = Date.now();
    const latest = evaluate(timeline, now, policy);
    if (latest.delivery.state === 'recorded') return;
    const nextEvent = { seq: latest.sequence + 1, at: now };
    if (!failure) {
      if (tryAppend(dir, { ...nextEvent, type: 'receipt', message: receipt })) return;
      continue;
    }
    if (latest.delivery.retry?.attempts !== attempt) return;
    const permanent = failure.retryable === false;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
    const code = retryCode(failure);
    if (!tryAppend(dir, { ...nextEvent, type: 'delivery-error', attempt, deadlineAt, code,
      state: permanent ? 'permanent-error' : 'retry', nextAt: permanent ? null : now + delay })) continue;
    console.error(permanent ? 'Entrega recusada pelo Concord. Diagnóstico: ' + code + '.'
      : 'Resposta pendente (' + code + '). Nova tentativa em até ' + delay / 1000 + ' s.');
    return;
  }
}

export async function superviseRequest(request, workspace, agent, connect = withProjectConcord) {
  const dir = directory(request);
  for (;;) {
    const timeline = read(dir);
    const policy = timeline[0]?.policy ?? config();
    const now = Date.now();
    const report = evaluate(timeline, now, policy);
    const next = { seq: report.sequence + 1, at: now };
    if (report.channel === 'concord') {
      ensure(workspace && agent, 'Use supervise <pedido> <workspace-Concord> <identidade-Concord>.');
      if (connect === withProjectConcord) requireProjectWorkspace(workspace);
      ensure(!report.workspace || report.workspace === workspace, 'O pedido pertence a outro workspace Concord.');
      if (!report.route) {
        tryAppend(dir, { ...next, type: 'route', workspace: clean(workspace), agent: clean(agent) });
        continue;
      }
      ensure(report.route.workspace === workspace && report.route.agent === agent,
        'O canal de retorno está vinculado a outra identidade ou workspace.');
    } else ensure(!workspace && !agent, 'Para pedidos do chat use supervise <pedido>.');
    if (!report.closed) {
      const deadline = report.timeout === 'hard-deadline';
      if (report.lease && (report.lease.expired || deadline)) {
        const pending = report.tasks.filter((task) => task.task !== 'root' && !terminal.has(task.state));
        const message = 'Pedido ' + report.request + ' interrompido: ' + (deadline ? 'prazo total atingido.' : 'orquestrador sem atualização.')
          + (pending.length ? ' Frentes a verificar antes de retomar: ' + pending.map((task) => task.task).join(', ') + '.' : '')
          + ' Consulte a linha do tempo e confira a posse no Concord antes de retomar.';
        tryAppend(dir, { ...next, type: 'event', task: 'root', state: 'blocked', message, supervisor: true });
        continue;
      }
      if (report.timeout && !report.lease) return 2;
      await wait(policy.pollMs);
      continue;
    }
    if (report.channel !== 'concord' || report.delivery.state !== 'pending') {
      console.log(JSON.stringify({ request: report.request, state: report.state, message: report.message, delivery: report.delivery }));
      return report.state === 'done' ? 0 : 3;
    }
    const retry = report.delivery.retry;
    if (retry?.state === 'permanent-error') {
      console.error('Resposta segue pendente. Corrija o diagnóstico permanente: ' + retry.code + '.');
      return 4;
    }
    if (retry?.deadlineAt != null && now >= retry.deadlineAt) {
      console.error('Resposta segue pendente. O orçamento de reenvio terminou.');
      return 2;
    }
    if (retry?.nextAt > now) {
      await wait(Math.min(policy.pollMs, retry.nextAt - now, retry.deadlineAt - now));
      continue;
    }
    await deliveryAttempt(dir, report, next, policy, connect);
  }
}

export function liveStatus(request) {
  const timeline = read(directory(request));
  return evaluate(timeline, Date.now(), timeline[0]?.policy ?? config());
}

function clean(value) {
  ensure(typeof value === 'string' && value.trim() && value.length <= 1600,
    'Use uma mensagem curta de até 1600 caracteres.');
  return value.trim();
}
function format(e) {
  const time = new Date(e.at).toISOString();
  if (e.type === 'open') return time + ' ' + e.request + ' recebido: ' + e.message;
  if (e.type === 'receipt') return time + ' resposta registrada: ' + e.message;
  if (e.type === 'lease') return time + ' posse registrada: ' + e.owner;
  if (e.type === 'route') return time + ' canal de retorno configurado';
  if (e.type === 'delivery-attempt') return time + ' tentativa de entrega ' + e.attempt;
  if (e.type === 'delivery-error') return time + ' falha de entrega (' + e.code + ')';
  if (e.type === 'delivery-reset') return time + ' reenvio liberado pelo operador';
  return time + ' ' + e.task + ' [' + e.state + '] ' + e.message;
}
function emit(object, line, json) {
  console.log(json ? JSON.stringify(object) : line);
}
async function watch(request, { json, waitForReceipt, timeoutSeconds }) {
  const dir = directory(request);
  const [initial] = read(dir);
  const policy = initial?.policy ?? config();
  ensure(!waitForReceipt || initial?.channel === 'concord', 'A espera pelo recibo se aplica a pedidos Concord.');
  let cursor = 0;
  let flagged = new Set();
  let receiptDeadline;
  for (;;) {
    const timeline = read(dir);
    const now = Date.now();
    const report = evaluate(timeline, now, policy);
    for (const e of timeline.filter((entry) => entry.seq > cursor)) {
      const { tokenHash, ...visible } = e;
      emit(visible, format(e), json);
    }
    cursor = report.sequence;
    for (const task of report.silentTasks.filter((key) => !flagged.has(key))) {
      emit({ type: 'alert', reason: 'worker-silent', request, task },
        'ALERTA: ' + task + ' está sem atualização; o orquestrador precisa recuperar ou encerrar esta frente.', json);
    }
    flagged = new Set(report.silentTasks);
    if (waitForReceipt && report.closed && report.delivery.state !== 'recorded') {
      receiptDeadline ??= now + (timeoutSeconds ?? policy.deliveryRetrySeconds ?? deliveryRetrySeconds) * 1000;
      const retry = report.delivery.retry;
      if (retry?.state === 'permanent-error') {
        emit({ type: 'end', ...report, outcome: 'delivery-error' },
          'ENTREGA BLOQUEADA: ' + retry.code + '. O resultado permanece disponível.', json);
        return 4;
      }
      const deadline = Math.min(receiptDeadline, retry?.deadlineAt ?? Infinity);
      if (now >= deadline) {
        emit({ type: 'end', ...report, outcome: 'delivery-timeout' },
          'TEMPO ESGOTADO: recibo pendente. O resultado permanece disponível.', json);
        return 2;
      }
      await wait(Math.min(policy.pollMs, deadline - now));
      continue;
    }
    if (report.closed || report.timeout) {
      const reason = report.timeout === 'hard-deadline' ? 'prazo total expirou' : 'orquestrador sem atualização';
      emit({ type: 'end', ...report },
        report.closed ? 'FIM: ' + report.state + ' — ' + report.message + ' | entrega: ' + report.delivery.state
          : 'TEMPO ESGOTADO: ' + reason + '. Retome pelo ID ' + request + '.', json);
      return report.timeout ? 2 : report.state === 'done' ? 0 : 3;
    }
    await wait(policy.pollMs);
  }
}

function watchOptions(args) {
  const options = { json: false, waitForReceipt: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !options.json) options.json = true;
    else if (args[i] === '--until' && !options.waitForReceipt && args[i + 1] === 'delivered') {
      options.waitForReceipt = true;
      i++;
    } else if (args[i] === '--timeout' && options.timeoutSeconds === undefined) {
      options.timeoutSeconds = Number(args[++i]);
      ensure(Number.isSafeInteger(options.timeoutSeconds) && options.timeoutSeconds > 0, 'Informe um prazo em segundos.');
    } else throw Error('Use watch <pedido> [--json] [--until delivered] [--timeout <segundos>].');
  }
  ensure(options.timeoutSeconds === undefined || options.waitForReceipt, 'Use --timeout junto de --until delivered.');
  return options;
}

async function main([cmd, request, ...args]) {
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
    console.log('Agent Live: open, claim, supervise, event, status, watch, delivery, ack-read, receipt, retry-delivery. Veja docs/comunicacao.md.');
    return 0;
  }
  if (cmd === 'ack-read') {
    ensure(typeof request === 'string' && request.trim() && args.length === 0, 'Use ack-read <ID-da-mensagem-Concord>.');
    const agent = process.env.CONCORD_AGENT_ID?.trim();
    ensure(agent, 'Configure CONCORD_AGENT_ID com a identidade efetiva da sessão destinatária.');
    const receipt = await withProjectConcord(root, async (call, workspace) => {
      await acknowledgeRead(workspace, request, agent, call);
      const result = await call('inspect_work', { workspace_id: workspace, message_id: request });
      const original = result.thread?.find((message) => (message.messageId ?? message.message_id) === request)?.receipt;
      ensure(original?.read_at || original?.status === 'replied', 'Aguarde o Concord registrar a leitura e repita ack-read.');
      return original;
    });
    console.log(JSON.stringify(receipt));
    return 0;
  }
  const dir = directory(request);
  if (cmd === 'open') {
    const [channel, ref, message, ...options] = args;
    const usage = 'Use open <id> <chat|concord> <referência> <objetivo> [--workspace <workspace-Concord>] [--deadline <segundos>].';
    ensure(['chat', 'concord'].includes(channel) && message !== undefined && options.length % 2 === 0, usage);
    let workspace;
    let deadline;
    for (let index = 0; index < options.length; index += 2) {
      if (options[index] === '--workspace' && channel === 'concord' && workspace === undefined) workspace = options[index + 1];
      else if (options[index] === '--deadline' && deadline === undefined) deadline = options[index + 1];
      else ensure(false, usage);
    }
    const policy = config();
    if (deadline !== undefined) {
      // Prazo total só deste pedido, para acompanhar CI, build ou publicação longos; o teto é da política do projeto.
      const max = policy.maxHardSeconds ?? policy.hardSeconds;
      ensure(/^\d{1,9}$/.test(deadline) && Number(deadline) >= policy.silentSeconds && Number(deadline) <= max,
        'Use --deadline entre ' + policy.silentSeconds + ' e ' + max + ' segundos; o teto é maxHardSeconds em .codex/live-policy.json'
        + (policy.maxHardSeconds === undefined ? ' (ausente: vale hardSeconds).' : '.'));
      policy.hardSeconds = Number(deadline);
    }
    let requestWorkspace = workspace !== undefined ? clean(workspace) : undefined;
    if (channel === 'concord' && existsSync(path.join(root, '.git'))) {
      requestWorkspace = await withProjectConcord(root, async (_call, project) => project, requestWorkspace);
    }
    const first = { seq: 1, at: Date.now(), type: 'open', request: id(request),
      channel, reference: clean(ref), message: clean(message), policy, replyKey: 'agent-flow-' + randomUUID(),
      ...(requestWorkspace && { workspace: requestWorkspace }) };
    openRequest(first);
    console.log(format(first));
    // Uma abertura retomada depois de uma queda mantém o prazo gravado na primeira vez, não o desta chamada.
    const saved = read(dir)[0] ?? first;
    console.log('Prazo total: ' + new Date(saved.at + saved.policy.hardSeconds * 1000).toISOString());
    return 0;
  }
  ensure(existsSync(dir), 'Pedido não registrado: ' + request);
  if (cmd === 'supervise' && [0, 2].includes(args.length)) return superviseRequest(request, ...args);
  if (cmd === 'watch') return watch(id(request), watchOptions(args));
  const timeline = read(dir);
  const report = evaluate(timeline, Date.now(), timeline[0]?.policy ?? config());
  if (cmd === 'status' && !args.length) {
    console.log(JSON.stringify(report, null, 2));
    return report.timeout ? 2 : report.closed && report.state !== 'done' ? 3 : 0;
  }
  if (cmd === 'delivery' && !args.length) {
    if (!report.route || report.delivery.state !== 'recorded') {
      console.log(JSON.stringify(report.delivery));
      return 0;
    }
    const result = await withProjectConcord(root, (call) => call('inspect_work', {
      workspace_id: report.route.workspace, message_id: report.delivery.reference,
    }), report.route.workspace);
    const receipt = result.thread?.find((message) => (message.messageId ?? message.message_id) === report.delivery.reference)?.receipt;
    ensure(receipt, 'O Concord não confirmou o estado da entrega.');
    console.log(JSON.stringify(receipt, null, 2));
    return 0;
  }
  const next = { seq: report.sequence + 1, at: Date.now() };
  if (cmd === 'retry-delivery' && !args.length) {
    const retry = report.delivery.retry;
    ensure(report.channel === 'concord' && report.delivery.state === 'pending'
      && retry && (retry.state === 'permanent-error' || (retry.deadlineAt != null && Date.now() >= retry.deadlineAt)),
    'Reenvio manual disponível após corrigir uma falha permanente ou esgotar o orçamento.');
    append(dir, { ...next, type: 'delivery-reset', state: 'retry', attempt: retry.attempts,
      deadlineAt: null, nextAt: null });
    console.log('Reenvio liberado. Inicie supervise com a mesma identidade Concord.');
    return 0;
  }
  if (cmd === 'claim') {
    const [owner, flag, evidence] = args;
    ensure(args.length === 1 || (args.length === 3 && flag === '--checked' && clean(evidence)),
      'Use claim <pedido> <responsável> [--checked "<verificação de posse e arquivos>"].');
    ensure(!report.closed && report.timeout !== 'hard-deadline' && (!report.lease || report.lease.expired),
      'Pedido encerrado, prazo total atingido ou posse ainda válida.');
    const active = report.tasks.some((task) => task.task !== 'root' && !terminal.has(task.state));
    ensure(!report.lease || !active || evidence, 'Confira as frentes antigas, a posse e os arquivos antes de retomar.');
    const token = randomUUID();
    append(dir, { ...next, type: 'lease', owner: clean(owner), evidence, tokenHash: digest(token),
      expiresAt: next.at + (timeline[0].policy ?? config()).silentSeconds * 1000 });
    console.log(JSON.stringify({ owner, token }));
    return 0;
  }
  requireOwner(timeline, report);
  if (cmd === 'receipt' && args.length === 1) {
    ensure(report.closed && report.delivery.state === 'pending', 'O pedido não tem resposta final pendente.');
    Object.assign(next, { type: 'receipt', message: clean(args[0]) });
  } else {
    const [rawTask, state, message, flag, replacedTask] = args;
    ensure(cmd === 'event' && events.has(state) && (args.length === 3 || state === 'queued'
      && ((args.length === 4 && flag === '--optional') || (args.length === 5 && flag === '--replaces'))),
    'Evento ou estado inválido.');
    ensure(!report.closed, 'O pedido está encerrado; crie outro ID para uma nova tentativa.');
    const task = id(rawTask);
    const last = report.tasks.find((item) => item.task === task);
    if (!last) ensure(state === 'queued', 'Registre a frente como queued antes de iniciá-la.');
    else {
      ensure(state !== 'queued' && !terminal.has(last.state), 'Frente já registrada ou encerrada.');
      ensure(last.state !== 'queued' || ['running', 'blocked', 'canceled'].includes(state),
        'A frente na fila precisa iniciar ou ser cancelada/bloqueada.');
    }
    if (task === 'root' && terminal.has(state)) {
      ensure(report.tasks.every((item) => item.task === 'root' || terminal.has(item.state)),
        'Encerre ou cancele as frentes abertas antes do pedido.');
      if (state === 'done') {
        const replaced = new Set(report.tasks.map((item) => item.replaces));
        const unresolved = report.tasks.find((item) =>
          item.task !== 'root' && !item.optional && !replaced.has(item.task) && item.state !== 'done');
        ensure(!unresolved, 'Frente obrigatória sem sucesso: ' + unresolved?.task + '. Registre o bloqueio ou uma substituição concluída.');
      }
    }
    Object.assign(next, { type: 'event', task, state, message: clean(message) });
    if (flag === '--optional') next.optional = true;
    if (flag === '--replaces') {
      const previous = report.tasks.find((item) => item.task === id(replacedTask));
      ensure(previous && previous.task !== 'root' && ['blocked', 'canceled'].includes(previous.state)
        && !report.tasks.some((item) => item.replaces === previous.task),
      'Informe uma frente bloqueada ou cancelada que ainda não foi substituída.');
      next.replaces = previous.task;
      if (previous.optional) next.optional = true;
    }
    if (task === 'root' && report.lease && !terminal.has(state)) {
      next.leaseExpiresAt = next.at + (timeline[0].policy ?? config()).silentSeconds * 1000;
    }
  }
  append(dir, next);
  console.log(format(next));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    console.error('Agent Live: ' + error.message);
    process.exitCode = 1;
  }
}
