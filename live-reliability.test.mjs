import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConcordError } from './template/.codex/hooks/concord.mjs';
import { acknowledgeRead, evaluate } from './template/.codex/hooks/live.mjs';

test('read acknowledgment requires the recipient and actual delivery', async () => {
  const payloads = [];
  let status = 'sent';
  const send = async (name, args) => {
    if (name === 'inspect_work') {
      return { thread: [{ messageId: 'result', recipientAgentId: 'receiver', receipt: { status } }] };
    }
    payloads.push(args);
    return { message_id: 'ack' };
  };
  await assert.rejects(acknowledgeRead('project', 'result', 'other', send), /destinatária/);
  await assert.rejects(acknowledgeRead('project', 'result', 'receiver', send), /inbox/);
  assert.equal(payloads.length, 0);
  status = 'delivered';
  await acknowledgeRead('project', 'result', 'receiver', send);
  await acknowledgeRead('project', 'result', 'receiver', send);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[0].reply_to_message_id, 'result');
  status = 'replied';
  assert.equal((await acknowledgeRead('project', 'result', 'receiver', send)).receipt.status, 'replied');
  assert.equal(payloads.length, 2);
});

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
const script = '.codex/hooks/live.mjs';

function command(cwd, ...args) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kit-live-reliability-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const setup = command(cwd, install, cwd);
  assert.equal(setup.status, 0, setup.stderr);
  writeFileSync(path.join(cwd, '.codex/live-policy.json'), JSON.stringify({
    heartbeatSeconds: 1, silentSeconds: 3, hardSeconds: 30, pollMs: 100, deliveryRetrySeconds: 1,
  }));
  return cwd;
}

function live(cwd, ...args) {
  return command(cwd, script, ...args);
}

function ok(cwd, ...args) {
  const result = live(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runAsync(cwd, ...args) {
  const child = spawn(process.execPath, [script, ...args], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  const result = once(child, 'close').then(([status]) => ({ status, stdout, stderr }));
  return { child, result };
}

function status(cwd, id) {
  return JSON.parse(live(cwd, 'status', id).stdout);
}

test('Concord origin is reserved once even when opened concurrently with different local IDs', async (t) => {
  const cwd = fixture(t);
  const options = ['concord', 'message-abc', 'Pedido', '--workspace', 'org/repo'];
  const ids = ['first', 'second'];
  const outcomes = await Promise.all(ids.map((id) => runAsync(cwd, 'open', id, ...options).result));
  const winner = outcomes.findIndex((result) => result.status === 0);
  assert.notEqual(winner, -1, JSON.stringify(outcomes));
  assert.equal(outcomes[1 - winner].status, 1);
  assert.match(outcomes[1 - winner].stderr, new RegExp('Use o pedido ' + ids[winner]));
  assert.equal(status(cwd, ids[winner]).workspace, 'org/repo');
  assert.equal(existsSync(path.join(cwd, '.agent-flow/live', ids[1 - winner])), false);
  ok(cwd, 'open', 'other-workspace', 'concord', 'message-abc', 'Outro', '--workspace', 'org/other');
  ok(cwd, 'open', 'legacy', 'concord', 'legacy-message', 'Legado');
  assert.match(live(cwd, 'open', 'legacy-duplicate', 'concord', 'legacy-message', 'Legado').stderr, /Use o pedido legacy\./);

  const previous = path.join(cwd, '.agent-flow/live/pre-upgrade');
  mkdirSync(previous);
  writeFileSync(path.join(previous, '000000000001.json'), JSON.stringify({
    type: 'open', seq: 1, at: Date.now(), request: 'pre-upgrade', channel: 'concord',
    reference: 'old-message', message: 'Aberto antes da atualização',
  }));
  writeFileSync(path.join(previous, '000000000002.json'), JSON.stringify({
    type: 'route', seq: 2, at: Date.now(), workspace: 'org/repo', agent: 'supervisor',
  }));
  const duplicate = live(cwd, 'open', 'new-id', 'concord', 'old-message', 'Mesmo pedido', '--workspace', 'org/repo');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Use o pedido pre-upgrade\./);
});

test('a blocked required front needs a completed replacement before success', (t) => {
  const cwd = fixture(t);
  ok(cwd, 'open', 'work', 'chat', 'session', 'Trabalho');
  ok(cwd, 'event', 'work', 'required', 'queued', 'Obrigatória');
  ok(cwd, 'event', 'work', 'required', 'blocked', 'Sem acesso');
  ok(cwd, 'event', 'work', 'optional', 'queued', 'Opcional', '--optional');
  ok(cwd, 'event', 'work', 'optional', 'canceled', 'Dispensada');
  assert.match(live(cwd, 'event', 'work', 'root', 'done', 'Falso sucesso').stderr, /Frente obrigatória sem sucesso: required/);
  ok(cwd, 'event', 'work', 'retry', 'queued', 'Tentar de novo', '--replaces', 'required');
  ok(cwd, 'event', 'work', 'retry', 'running', 'Em execução');
  ok(cwd, 'event', 'work', 'retry', 'done', 'Concluída');
  ok(cwd, 'event', 'work', 'root', 'done', 'Concluído');
});

test('transient retry budget survives supervisor restart', async (t) => {
  const cwd = fixture(t);
  ok(cwd, 'open', 'work', 'concord', 'message-budget', 'Pedido', '--workspace', 'general');
  ok(cwd, 'event', 'work', 'root', 'done', 'Concluído');
  const { superviseRequest } = await import(pathToFileURL(path.join(cwd, script)));
  let calls = 0;
  const connect = async () => {
    calls++;
    throw new ConcordError('Segredo hipotético que não deve ir ao estado', true, 'timeout');
  };
  assert.equal(await superviseRequest('work', 'general', 'supervisor', connect), 2);
  const retry = status(cwd, 'work').delivery.retry;
  assert.equal(retry.attempts, 1);
  assert.equal(retry.code, 'timeout');
  assert.ok(retry.deadlineAt <= Date.now());
  assert.equal(await superviseRequest('work', 'general', 'supervisor', connect), 2);
  assert.equal(calls, 1);
  assert.deepEqual(status(cwd, 'work').delivery.retry, retry);
});

test('a permanent error stops retries and an explicit reset keeps the same reply key', async (t) => {
  const cwd = fixture(t);
  ok(cwd, 'open', 'work', 'concord', 'message-denied', 'Pedido', '--workspace', 'general');
  ok(cwd, 'event', 'work', 'root', 'done', 'Concluído');
  const { superviseRequest } = await import(pathToFileURL(path.join(cwd, script)));
  const argumentsSeen = [];
  const reject = (_root, send) => send((_name, args) => {
    argumentsSeen.push(args);
    throw new ConcordError('Permissão recusada', false, 'unauthorized');
  });
  assert.equal(await superviseRequest('work', 'general', 'supervisor', reject), 4);
  const retry = status(cwd, 'work').delivery.retry;
  assert.equal(retry.state, 'permanent-error');
  assert.equal(retry.code, 'unauthorized');
  assert.equal(await superviseRequest('work', 'general', 'supervisor', reject), 4);
  const denied = live(cwd, 'watch', 'work', '--until', 'delivered', '--json');
  assert.equal(denied.status, 4);
  assert.equal(JSON.parse(denied.stdout.trim().split('\n').at(-1)).outcome, 'delivery-error');
  assert.equal(argumentsSeen.length, 1);
  ok(cwd, 'retry-delivery', 'work');
  const accept = (_root, send) => send((_name, args) => {
    argumentsSeen.push(args);
    return { message_id: 'receipt' };
  });
  assert.equal(await superviseRequest('work', 'general', 'supervisor', accept), 0);
  assert.deepEqual(argumentsSeen[1], argumentsSeen[0]);
  assert.deepEqual(status(cwd, 'work').delivery, { state: 'recorded', reference: 'receipt', attempts: 2 });
});

test('watch can wait for receipt or exit with delivery pending after its deadline', async (t) => {
  const cwd = fixture(t);
  ok(cwd, 'open', 'work', 'concord', 'message-watch', 'Pedido');
  ok(cwd, 'event', 'work', 'root', 'done', 'Concluído');
  const pending = live(cwd, 'watch', 'work', '--until', 'delivered', '--timeout', '1', '--json');
  assert.equal(pending.status, 2, pending.stderr);
  assert.equal(JSON.parse(pending.stdout.trim().split('\n').at(-1)).outcome, 'delivery-timeout');
  const watching = runAsync(cwd, 'watch', 'work', '--until', 'delivered', '--timeout', '3', '--json');
  await once(watching.child.stdout, 'data');
  ok(cwd, 'receipt', 'work', 'accepted');
  const finished = await watching.result;
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(JSON.parse(finished.stdout.trim().split('\n').at(-1)).delivery,
    { state: 'recorded', reference: 'accepted' });
});

test('espera declarada estende a posse até o teto e o prazo, e o silêncio conta depois dela', (t) => {
  const cwd = fixture(t);
  ok(cwd, 'open', 'lento', 'chat', 'sessao', 'Ferramenta lenta');
  const token = JSON.parse(ok(cwd, 'claim', 'lento', 'eu')).token;
  const as = (...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, AGENT_FLOW_LEASE: token } });
  const asOk = (...args) => { const result = as(...args); assert.equal(result.status, 0, result.stderr); return result.stdout; };

  const before = Date.now();
  assert.match(asOk('event', 'lento', 'root', 'waiting', 'Build rodando', '--for', '10'), /espera declarada até/);
  let report = status(cwd, 'lento');
  // Posse até o fim da espera (10 s) mais silentSeconds (3 s da fixture).
  assert.ok(report.lease.expiresAt >= before + 13000 && report.lease.expiresAt <= Date.now() + 13000, JSON.stringify(report.lease));
  // Um heartbeat no meio mantém a espera.
  asOk('event', 'lento', 'root', 'heartbeat', 'Build em 40%');
  report = status(cwd, 'lento');
  assert.ok(report.lease.expiresAt >= before + 13000, JSON.stringify(report.lease));
  assert.ok(report.tasks.find((task) => task.task === 'root').waitUntil >= before + 10000);
  // Pedido maior que o prazo total (30 s) fica no prazo.
  asOk('event', 'lento', 'root', 'waiting', 'Deploy', '--for', '500');
  report = status(cwd, 'lento');
  assert.equal(report.tasks.find((task) => task.task === 'root').waitUntil, Date.parse(report.deadline));
  // Outro evento da raiz encerra a espera.
  asOk('event', 'lento', 'root', 'running', 'Build terminou');
  assert.equal(status(cwd, 'lento').tasks.find((task) => task.task === 'root').waitUntil, undefined);

  for (const value of ['0', '601', '1e2', '-3']) assert.match(as('event', 'lento', 'root', 'waiting', 'x', '--for', value).stderr, /entre 1 e 600/, value);
  asOk('event', 'lento', 'qa', 'queued', 'Frente');
  assert.match(as('event', 'lento', 'qa', 'waiting', 'x', '--for', '10').stderr, /root waiting/);
  assert.match(as('event', 'lento', 'root', 'running', 'x', '--for', '10').stderr, /root waiting/);
});

test('silêncio da raiz conta a partir do fim da espera declarada', () => {
  const policy = { silentSeconds: 90, hardSeconds: 3600 };
  const history = [
    { seq: 1, at: 0, type: 'open', request: 'a', channel: 'chat', reference: 'chat', message: 'Pedido' },
    { seq: 2, at: 1000, type: 'event', task: 'root', state: 'waiting', message: 'Build', waitUntil: 181000 },
  ];
  assert.equal(evaluate(history, 200000, policy).timeout, null);
  assert.equal(evaluate(history, 271000, policy).timeout, 'orchestrator-silent');
});

test('open accepts a per-request deadline only within the project policy', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-live-prazo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(command(dir, install, dir).status, 0);
  const open = (id, ...options) => command(dir, script, 'open', id, 'chat', 'sessao', 'Acompanhar job externo', ...options);
  const deadline = (id) => {
    const status = JSON.parse(command(dir, script, 'status', id).stdout);
    return Date.parse(status.deadline) - Date.now();
  };

  assert.equal(open('padrao').status, 0);
  assert.ok(deadline('padrao') <= 900000 && deadline('padrao') > 890000);

  const long = open('longo', '--deadline', '3600');
  assert.equal(long.status, 0, long.stderr);
  assert.match(long.stdout, /Prazo total: \d{4}-/);
  assert.ok(deadline('longo') <= 3600000 && deadline('longo') > 3590000);
  // O prazo maior é só daquele pedido.
  assert.equal(open('seguinte').status, 0);
  assert.ok(deadline('seguinte') <= 900000);

  for (const value of ['7201', '10', '-5', '+600', '600.5', '1e3', 'muito']) {
    const refused = open('recusado-' + value.replace(/\W/g, ''), '--deadline', value);
    assert.equal(refused.status, 1, value);
    assert.match(refused.stderr, /entre 90 e 7200/, value);
  }
  assert.equal(open('repetido', '--deadline', '600', '--deadline', '900').status, 1);
  assert.equal(open('sem-valor', '--deadline').status, 1);
  assert.equal(open('chat-sem-workspace', '--workspace', 'ws').status, 1);

  // A política do projeto define o teto; sem a chave, o teto é o próprio padrão.
  writeFileSync(path.join(dir, '.codex', 'live-policy.json'),
    JSON.stringify({ heartbeatSeconds: 30, silentSeconds: 90, hardSeconds: 900, pollMs: 1000 }));
  assert.match(open('sem-teto', '--deadline', '901').stderr, /entre 90 e 900/);
});
