import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { available, selectModel } from './template/.codex/hooks/route-model.mjs';
import { evaluate } from './template/.codex/hooks/live.mjs';
import { localEvents, render } from './template/.codex/hooks/panel.mjs';
import { idleHolds, taskOwnership, verifyFronts, withConcord } from './template/.codex/hooks/concord.mjs';
import { heldBy } from './template/.codex/hooks/flow.mjs';

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
const root = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'Agent Flow espaço '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const node = (cwd, args, input) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', input });
const flow = (cwd, ...args) => node(cwd, ['.codex/hooks/flow.mjs', ...args]);
const bootstrap = (cwd, ...args) => node(cwd, ['.codex/hooks/bootstrap.mjs', ...args]);
const live = (cwd, ...args) => node(cwd, ['.codex/hooks/live.mjs', ...args]);
const recorded = (cwd, stage) => ok(flow(cwd, 'record-parallel', stage, 'parent',
  stage + '-worker-1', stage + '-worker-2'));
function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function reject(result, message) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, message);
}
function note(dir, name, content = 'Evidência de ' + name) {
  mkdirSync(path.join(dir, 'docs/work'), { recursive: true });
  const file = 'docs/work/' + name + '.md';
  writeFileSync(path.join(dir, file), content);
  return file;
}
const patch = (file) => '*** Begin Patch\n*** Add File: ' + file + '\n+conteúdo\n*** End Patch';
function runHook(dir, event, fields = {}, cwd = dir) {
  const config = JSON.parse(readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8'));
  const command = config.hooks[event][0].hooks[0].command;
  return JSON.parse(ok(spawnSync(command, { cwd, shell: true, encoding: 'utf8',
    input: JSON.stringify({ cwd, hook_event_name: event, ...fields }) })));
}
const runPatch = (dir, command, extra = {}, cwd = dir) => runHook(dir, 'PreToolUse',
  { tool_name: 'apply_patch', tool_input: { command, ...extra } }, cwd);
const denied = (output) => assert.equal(output.hookSpecificOutput?.permissionDecision, 'deny');

test('installer dry-run and conflict preflight leave existing files alone', (t) => {
  const dir = root(t);
  ok(node(dir, [install, '--dry-run', dir]));
  assert.equal(existsSync(path.join(dir, '.codex')), false);
  writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"local":{"command":"custom"}}}');
  const existing = '# Orientações locais\n';
  writeFileSync(path.join(dir, 'AGENTS.md'), existing);
  reject(node(dir, [install, dir]), /\.mcp\.json/);
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), existing);
  assert.equal(readFileSync(path.join(dir, '.mcp.json'), 'utf8'), '{"mcpServers":{"local":{"command":"custom"}}}');
  assert.equal(existsSync(path.join(dir, '.codex')), false);
});

test('skills-only upgrades an existing project and includes supporting files', (t) => {
  const dir = root(t);
  writeFileSync(path.join(dir, 'AGENTS.md'), 'original');
  ok(node(dir, [install, '--skills-only', '--dry-run', dir]));
  assert.equal(existsSync(path.join(dir, '.agents')), false);
  ok(node(dir, [install, '--skills-only', dir]));
  const skills = path.join(dir, '.agents', 'skills');
  const dirs = readdirSync(skills, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(dirs.length, 27);
  for (const skill of dirs) assert.ok(existsSync(path.join(skills, skill.name, 'SKILL.md')), skill.name);
  for (const file of ['LICENSE-mattpocock', 'tdd/mocking.md', 'to-spec/agents/openai.yaml',
    'diagnosing-bugs/scripts/hitl-loop.template.sh']) {
    assert.ok(existsSync(path.join(skills, file)), file);
  }
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'original');
  assert.equal(existsSync(path.join(dir, '.codex')), false);
  ok(node(dir, [install, '--skills-only', dir]));
});

test('UI feature requires discovery, preview, spec, slice, browser and review; reopen invalidates later stages', (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  assert.ok(existsSync(path.join(dir, '.agents/skills/implement/SKILL.md')));
  assert.deepEqual(runPatch(dir, patch('app.js')), {});
  ok(flow(dir, 'new', 'feature', 'Agenda', '--ui'));
  assert.match(runHook(dir, 'SessionStart').hookSpecificOutput.additionalContext, /discover \(UI\)/);
  assert.match(runHook(dir, 'Stop').systemMessage, /discover/);
  denied(runPatch(dir, patch('app.js')));
  assert.deepEqual(runPatch(dir, patch('prototypes/agenda.html')), {});
  const nested = path.join(dir, 'src');
  mkdirSync(nested);
  denied(runPatch(dir, patch('app.js'), {}, nested));
  assert.deepEqual(runPatch(dir, patch('../docs/work/agenda.md'), {}, nested), {});
  denied(runPatch(dir, '*** Begin Patch\n*** Update File: docs/work/demo.md\n*** Move to: src/demo.js\n*** End Patch'));
  const discovery = note(dir, 'discovery');
  reject(flow(dir, 'advance', 'slice', discovery), /Etapa esperada: discover/);
  reject(flow(dir, 'advance', 'discover', discovery), /2 arquivo/);
  reject(flow(dir, 'advance', 'discover', discovery, discovery), /record-parallel/);
  reject(flow(dir, 'record-parallel', 'discover', 'parent', 'same', 'same'), /Uso na fase atual/);
  recorded(dir, 'discover');
  reject(flow(dir, 'advance', 'discover', discovery, discovery), /arquivo distinto/);
  ok(flow(dir, 'advance', 'discover', discovery, note(dir, 'preview')));
  ok(flow(dir, 'advance', 'specify', note(dir, 'spec')));
  const slice = note(dir, 'slice');
  reject(flow(dir, 'advance', 'slice', slice), /Falta o aceite do plano/);
  reject(flow(dir, 'approve', slice, ''), /Uso: approve/);
  reject(flow(dir, 'approve', discovery, 'Aceite no chat'), /arquivo distinto/);
  const plan = note(dir, 'plano');
  ok(flow(dir, 'approve', plan, 'Usuário aceitou no chat'));
  reject(flow(dir, 'advance', 'slice', plan), /arquivo distinto/);
  writeFileSync(path.join(dir, plan), 'Plano alterado depois do aceite');
  reject(flow(dir, 'advance', 'slice', slice), /O plano mudou depois do aceite/);
  ok(flow(dir, 'approve', plan, 'Usuário aceitou a versão nova'));
  assert.match(runHook(dir, 'SessionStart').hookSpecificOutput.additionalContext, /Plano aceito/);
  ok(flow(dir, 'advance', 'slice', slice));
  assert.match(runHook(dir, 'Stop').systemMessage, /plano aceito e tarefa em implement/);
  assert.deepEqual(runPatch(dir, patch('app.js')), {});
  ok(flow(dir, 'advance', 'implement', note(dir, 'implementation')));
  denied(runPatch(dir, patch('app.js')));
  const validation = note(dir, 'validation');
  reject(flow(dir, 'advance', 'validate', validation), /2 arquivo/);
  ok(flow(dir, 'advance', 'validate', validation, note(dir, 'browser')));
  reject(flow(dir, 'check'), /review/);
  const review = note(dir, 'review');
  reject(flow(dir, 'advance', 'review', review), /record-parallel/);
  reject(flow(dir, 'record-parallel', 'review', 'another-parent', 'review-1', 'review-2'), /mesma tarefa/);
  recorded(dir, 'review');
  ok(flow(dir, 'advance', 'review', review));
  ok(flow(dir, 'check'));
  assert.deepEqual(runHook(dir, 'Stop'), {});
  note(dir, 'review', 'mudança posterior');
  reject(flow(dir, 'check'), /alterada em review/);
  ok(flow(dir, 'reopen', 'Corrigir achado'));
  assert.deepEqual(runPatch(dir, patch('app.js')), {});
  reject(flow(dir, 'check'), /implement/);
  assert.equal(JSON.parse(ok(flow(dir, 'status'))).parallel.review, undefined);
});

test('short route rejects external evidence and planning path escapes, then closes cleanly', (t) => {
  const dir = root(t);
  const external = root(t);
  ok(node(dir, [install, dir]));
  ok(flow(dir, 'new', 'fix', 'Corrigir reserva'));
  recorded(dir, 'discover');
  const reproduction = note(dir, 'repro');
  const externalNote = path.join(external, note(external, 'outside'));
  reject(flow(dir, 'advance', 'discover', externalNote), /dentro do projeto/);
  symlinkSync(external, path.join(dir, 'docs/work/link'), process.platform === 'win32' ? 'junction' : 'dir');
  denied(runPatch(dir, patch('docs/work/link/escape.md')));
  denied(runPatch(dir, patch('.agent-flow/active.json')));
  reject(flow(dir, 'advance', 'discover', reproduction), /Falta o aceite do plano/);
  ok(flow(dir, 'approve', note(dir, 'plano-fix'), 'Aceite de teste'));
  ok(flow(dir, 'advance', 'discover', reproduction));
  note(dir, 'repro', 'evidência mudou');
  denied(runPatch(dir, patch('app.js')));
  reject(flow(dir, 'advance', 'implement', note(dir, 'change')), /alterada em discover/);
  note(dir, 'repro');
  for (const stage of ['implement', 'validate', 'review']) {
    if (stage === 'review') recorded(dir, 'review');
    ok(flow(dir, 'advance', stage, note(dir, stage)));
  }
  ok(flow(dir, 'close'));
  assert.match(ok(flow(dir, 'status')), /Sem tarefa ativa/);
  assert.deepEqual(runPatch(dir, patch('app.js')), {});
});

test('upgrade hands the retired model routing file over to the project', (t) => {
  const manifest = (dir) => JSON.parse(readFileSync(path.join(dir, '.agent-flow/install-manifest.json'), 'utf8'));
  const routing = (dir) => path.join(dir, '.codex/model-routing.json');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const old = (dir, onDisk) => {
    ok(node(dir, [install, dir]));
    const data = manifest(dir);
    data.files['.codex/model-routing.json'] = sha('{"light":{"model":"fixo","effort":"low"}}');
    writeFileSync(path.join(dir, '.agent-flow/install-manifest.json'), JSON.stringify(data, null, 2) + '\n');
    writeFileSync(routing(dir), onDisk);
    ok(node(dir, [install, dir]));
    assert.equal('.codex/model-routing.json' in manifest(dir).files, false);
    return readFileSync(routing(dir), 'utf8');
  };
  assert.equal(old(root(t), '{"light":{"model":"fixo","effort":"low"}}'), '{}\n');
  assert.equal(old(root(t), '{"light":{"model":"do-projeto","effort":"low"}}'), '{"light":{"model":"do-projeto","effort":"low"}}');
});

test('panel lists agents, tasks and activity and escapes what other agents wrote', () => {
  const html = render({
    workspace: 'ws', generatedAt: '2026-11-14T08:00:00Z', refresh: true,
    view: {
      presence: [{ agentId: 'codex:1', kind: 'codex', present: true, summary: '<script>alert(1)</script>', workspaces: ['ws'] },
        { agentId: 'outro:9', kind: 'x', present: false, workspaces: ['outro'] }],
      communications: [{ agentId: 'codex:1', promptable: true }],
      active: [{ taskId: 'front-1', agentId: 'codex:1', status: 'active', branch: 'feat/x' }],
      review_ready: [{ taskId: 'front-2' }],
    },
    events: [{ request: 'pedido', at: '2026-11-14T07:59:00Z', task: 'testes', state: 'done', message: 'passou <b>' },
      { request: 'pedido', at: Date.UTC(2026, 10, 14, 12), task: 'recente', state: 'running', message: 'em milissegundos' }],
  });
  assert.doesNotMatch(html, /<script>|passou <b>/);
  assert.match(html, /&#60;script&#62;/);
  for (const text of ['codex:1', 'Codex', 'front-1', 'front-2', 'review_ready', 'pedido', 'http-equiv="refresh"']) assert.ok(html.includes(text), text);
  assert.equal(html.includes('outro:9'), false);
  // A linha do tempo local grava o horário em milissegundos: aparece com data e vem antes do evento mais antigo.
  assert.ok(html.includes(new Date(Date.UTC(2026, 10, 14, 12)).toLocaleString('pt-BR')));
  assert.ok(html.indexOf('recente') < html.indexOf('testes'));
  // Presente em outro projeto não entra; item nulo não derruba a página.
  const other = render({ workspace: 'ws', view: { presence: [{ agentId: 'fora:1', present: true, workspaces: ['outro'] }, null], active: [null] }, events: [null] });
  assert.equal(other.includes('fora:1'), false);
  assert.match(other, /<b>0<\/b>agentes presentes/);
  assert.match(render({ error: 'sem conexão.', events: [] }), /Concord não respondeu/);
});

test('panel activity ignores the internal request registry of live', (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  ok(live(dir, 'open', 'pedido-painel', 'chat', 'sessao', 'Conferir o painel'));
  const base = path.join(dir, '.agent-flow', 'live');
  assert.ok(readdirSync(base).some((name) => name.startsWith('.')), 'o live deveria ter criado o registro interno');
  const events = localEvents(base);
  assert.ok(events.length > 0);
  assert.deepEqual([...new Set(events.map((event) => event.request))], ['pedido-painel']);
});

test('model routing chooses the task tier, downgrades supported effort, or inherits', () => {
  const profiles = { light: { model: 'cheap', effort: 'low' }, complex: { model: 'expert', effort: 'high' } };
  const model = (slug, effort, visibility = 'list') => ({ slug, visibility, supported_reasoning_levels: [{ effort }] });
  const catalog = [model('cheap', 'low'), model('expert', 'medium')];
  assert.deepEqual(selectModel('complex', profiles, catalog),
    { request: 'complex', profile: 'complex', model: 'expert', reasoning_effort: 'medium' });
  assert.equal(selectModel('critical', profiles, [model('expert', 'medium', 'hide'), catalog[0]]).profile, 'light');
  assert.deepEqual(selectModel('light', profiles, []), { request: 'light', profile: 'inherit' });
  // Sem preferências do projeto, o orquestrador recebe o catálogo e escolhe.
  assert.deepEqual(selectModel('complex', {}, catalog), { request: 'complex', profile: 'inherit' });
  assert.deepEqual(available([model('hidden', 'high', 'hide'), ...catalog]),
    [{ model: 'cheap', efforts: ['low'] }, { model: 'expert', efforts: ['medium'] }]);
});

test('git bootstrap initializes only its own directory and publication requires a completed workflow', (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  reject(bootstrap(dir, 'publish-private', 'example/example'), /reservada/);
  assert.match(ok(bootstrap(dir, 'git-init')), /Git criado/);
  assert.match(ok(bootstrap(dir, 'git-init')), /preservado/);
  reject(bootstrap(dir, 'publish-private', 'example/example', '--', 'AGENTS.md'), /Sem tarefa ativa/);
  const nested = path.join(dir, 'nested');
  mkdirSync(nested);
  ok(node(nested, [install, nested]));
  reject(bootstrap(nested, 'git-init'), /dentro de outro repositório/);
  assert.equal(existsSync(path.join(nested, '.git')), false);
});

test('live request retains its channel, linked Stop reminder, and final receipt', (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  ok(flow(dir, 'new', 'fix', 'Corrigir agenda'));
  ok(live(dir, 'open', 'agenda-42', 'concord', 'message-7', 'Corrigir agenda'));
  ok(flow(dir, 'link-live', 'agenda-42'));
  reject(flow(dir, 'record-parallel', 'discover', 'parent', 'qa', 'design'), /exige verificação/);
  assert.match(runHook(dir, 'Stop').systemMessage, /agenda-42 ainda aberto/);
  reject(flow(dir, 'cancel', 'Pedido cancelado'), /resposta final/);
  ok(live(dir, 'event', 'agenda-42', 'qa', 'queued', 'Preparar validação'));
  ok(live(dir, 'event', 'agenda-42', 'qa', 'running', 'Validando'));
  reject(live(dir, 'event', 'agenda-42', 'root', 'done', 'Pronto'), /frentes abertas/);
  ok(live(dir, 'event', 'agenda-42', 'qa', 'done', 'Validado'));
  ok(live(dir, 'event', 'agenda-42', 'root', 'done', 'Resultado disponível'));
  assert.match(runHook(dir, 'Stop').systemMessage, /pendente no Concord/);
  const updates = ok(live(dir, 'watch', 'agenda-42', '--json')).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(updates.map((e) => e.type), ['open', 'event', 'event', 'event', 'event', 'end']);
  assert.equal(updates.at(-1).reference, 'message-7');
  assert.equal(updates.at(-1).delivery.state, 'pending');
  ok(live(dir, 'receipt', 'agenda-42', 'reply-11'));
  assert.equal(JSON.parse(ok(live(dir, 'status', 'agenda-42'))).delivery.reference, 'reply-11');
  reject(live(dir, 'receipt', 'agenda-42', 'reply-12'), /não tem resposta final pendente/);
});

test('separate watcher exits with a timeout when orchestrator goes silent', { timeout: 12000 }, async (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  writeFileSync(path.join(dir, '.codex/live-policy.json'), JSON.stringify({
    heartbeatSeconds: 1, silentSeconds: 2, hardSeconds: 8, pollMs: 100,
  }));
  ok(live(dir, 'open', 'stall', 'chat', 'sessao', 'Testar silêncio'));
  const watcher = spawn(process.execPath, ['.codex/hooks/live.mjs', 'watch', 'stall', '--json'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (watcher.exitCode === null) watcher.kill(); });
  let stdout = '';
  let stderr = '';
  watcher.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  watcher.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(watcher, 'close');
  assert.equal(code, 2, stderr);
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.timeout, 'orchestrator-silent');
  assert.equal(result.request, 'stall');
});

test('watch streams events written after it starts and exits on final result', { timeout: 12000 }, async (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  ok(live(dir, 'open', 'stream', 'chat', 'sessao', 'Acompanhar'));
  const watcher = spawn(process.execPath, ['.codex/hooks/live.mjs', 'watch', 'stream', '--json'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (watcher.exitCode === null) watcher.kill(); });
  watcher.stdout.setEncoding('utf8');
  const closed = once(watcher, 'close');
  const [first] = await once(watcher.stdout, 'data');
  assert.match(first, /"type":"open"/);
  let output = '';
  watcher.stdout.on('data', (chunk) => { output += chunk; });
  ok(live(dir, 'event', 'stream', 'root', 'heartbeat', 'Etapa em andamento'));
  ok(live(dir, 'event', 'stream', 'root', 'done', 'Final registrado'));
  assert.equal((await closed)[0], 0);
  const rows = output.trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(rows.some((row) => row.state === 'heartbeat'));
  assert.equal(rows.at(-1).message, 'Final registrado');
});

test('live health distinguishes stalled workers and enforces a total deadline despite heartbeats', () => {
  const policy = { silentSeconds: 90, hardSeconds: 900 };
  const history = [
    { seq: 1, at: 0, type: 'open', request: 'a', channel: 'chat', reference: 'chat', message: 'Pedido' },
    { seq: 2, at: 1000, type: 'event', task: 'qa', state: 'queued', message: 'Na fila' },
    { seq: 3, at: 890000, type: 'event', task: 'root', state: 'heartbeat', message: 'Ainda ativo' },
  ];
  const before = evaluate(history, 895000, policy);
  assert.deepEqual(before.silentTasks, ['qa']);
  assert.equal(before.timeout, null);
  assert.equal(evaluate(history, 900000, policy).timeout, 'hard-deadline');
});

test('supervisor retries after the MCP server accepts a reply and loses the response', { timeout: 12000 }, async (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  ok(live(dir, 'open', 'outbox', 'concord', 'synthetic-request', 'Entrega'));
  ok(live(dir, 'event', 'outbox', 'root', 'done', 'Resultado persistido'));
  const { superviseRequest } = await import(pathToFileURL(path.join(dir, '.codex/hooks/live.mjs')));
  const ledger = path.join(dir, 'synthetic-ledger.json');
  const wire = String.raw`
    const fs = require('node:fs');
    const lines = require('node:readline').createInterface({ input: process.stdin });
    const file = process.argv[1];
    lines.on('line', (line) => {
      const req = JSON.parse(line);
      const reply = (result) => console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
      if (req.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'synthetic', version: '1' } });
      if (req.method !== 'tools/call') return;
      const args = req.params.arguments;
      const records = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { messages: {}, calls: [] };
      const duplicate = Boolean(records.messages[args.idempotency_key]);
      records.messages[args.idempotency_key] ??= { args, message_id: 'synthetic-reply' };
      records.calls.push(args);
      fs.writeFileSync(file, JSON.stringify(records));
      if (!duplicate) return process.exit(0);
      reply({ structuredContent: { message_id: 'synthetic-reply' } });
    });
  `;
  const connect = (cwd, operation) => withConcord(cwd, operation, { command: process.execPath, args: ['-e', wire, ledger] });
  assert.equal(await superviseRequest('outbox', 'general', 'synthetic-test-owner', connect), 0);
  const records = JSON.parse(readFileSync(ledger));
  assert.equal(Object.keys(records.messages).length, 1);
  assert.equal(records.calls.length, 2);
  assert.deepEqual(records.calls[0], records.calls[1]);
  assert.equal(records.calls[1].reply_to_message_id, 'synthetic-request');
  assert.equal(JSON.parse(ok(live(dir, 'status', 'outbox'))).delivery.reference, 'synthetic-reply');
});

test('expired orchestration can be reclaimed and the old lease cannot write', { timeout: 12000 }, async (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  writeFileSync(path.join(dir, '.codex/live-policy.json'), JSON.stringify({
    heartbeatSeconds: 1, silentSeconds: 2, hardSeconds: 30, pollMs: 100,
  }));
  ok(live(dir, 'open', 'takeover', 'chat', 'sessao', 'Retomar'));
  const first = JSON.parse(ok(live(dir, 'claim', 'takeover', 'primeiro'))).token;
  const event = (token, ...args) => spawnSync(process.execPath, ['.codex/hooks/live.mjs', 'event', 'takeover', ...args],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, AGENT_FLOW_LEASE: token } });
  ok(event(first, 'qa', 'queued', 'Verificar', '--optional'));
  await new Promise((resolve) => setTimeout(resolve, 2150));
  reject(live(dir, 'claim', 'takeover', 'segundo'), /posse e os arquivos/);
  const next = JSON.parse(ok(live(dir, 'claim', 'takeover', 'segundo', '--checked', 'Frente antiga interrompida e arquivos inspecionados'))).token;
  reject(event(first, 'root', 'heartbeat', 'antigo'), /Posse ausente/);
  ok(event(next, 'qa', 'canceled', 'Frente antiga encerrada'));
  ok(event(next, 'root', 'done', 'Concluído pela nova sessão'));
});

test('Concord verification rejects incomplete, unrelated or overlapping fronts', async () => {
  const root = { workspace_id: 'general', task: { taskId: 'parent' } };
  const front = (id, extra = {}) => ({ workspace_id: 'general',
    task: { taskId: id, parentTaskId: 'parent', status: 'complete', title: id, version: 2, ...extra },
    latest_handoff: { whatChanged: 'resultado registrado' } });
  const verify = (second, first = front('first')) => verifyFronts(async (_tool, { task_id }) =>
    ({ parent: root, first, second })[task_id], 'general', 'parent', ['first', 'second']);
  assert.equal((await verify(front('second'))).children.length, 2);
  await assert.rejects(verify(front('second', { status: 'active' })), /resultado confirmado/);
  await assert.rejects(verify(front('second', { parentTaskId: 'another' })), /resultado confirmado/);
  await assert.rejects(verify(front('second', { expectedFiles: ['src/file.js'] }),
    front('first', { expectedFiles: ['src/**'] })), /sobrepõem/);
});

test('scope ownership requires an active claim unless the reason it cannot be claimed is recorded', () => {
  const parent = { workspace: 'ws', parent: 'parent' };
  const result = (extra = {}) => ({ workspace_id: 'ws',
    task: { taskId: 'front', parentTaskId: 'parent', status: 'active', agentId: 'a', ...extra } });
  assert.equal(taskOwnership(result(), parent, 'front'), true);
  assert.throws(() => taskOwnership(result({ status: 'review_ready' }), parent, 'front'), /--unclaimed/);
  assert.throws(() => taskOwnership(result({ leaseExpiresAt: '2000-01-01T00:00:00Z' }), parent, 'front'), /--unclaimed/);
  assert.equal(taskOwnership(result({ status: 'review_ready' }), parent, 'front', 'dono ausente'), false);
  // O motivo não dispensa o vínculo com o pedido.
  assert.throws(() => taskOwnership(result({ parentTaskId: 'outro' }), parent, 'front', 'dono ausente'), /não pertence/);
  assert.throws(() => taskOwnership(result({ status: 'cancelled' }), parent, 'front', 'dono ausente'), /cancelled/);
});

test('unclaimed scope only reaches files held by a stale or review-ready task', async () => {
  const tasks = { parada: ['src/a.js', 'docs'], entregue: ['lib/**'], front: ['own.js'] };
  const holds = await idleHolds(async (_tool, { task_id }) => (task_id
    ? { task: { expectedFiles: tasks[task_id] } }
    : { stale_claims: [{ taskId: 'parada' }, null], review_ready: [{ taskId: 'entregue' }, { taskId: 'front' }], active: [{ taskId: 'viva' }] }),
  'ws', 'front');
  assert.deepEqual(holds, ['src/a.js', 'docs', 'lib/**']);
  for (const file of ['src/a.js', 'docs/guia.md', 'docs/**', 'lib/x/y.js']) assert.equal(heldBy(holds, file), true, file);
  for (const file of ['src/b.js', 'src/**', 'own.js', 'docs-outros/a.md']) assert.equal(heldBy(holds, file), false, file);
});

test('independent supervisor records a blocked result after an owner disappears', { timeout: 12000 }, async (t) => {
  const dir = root(t);
  ok(node(dir, [install, dir]));
  writeFileSync(path.join(dir, '.codex/live-policy.json'), JSON.stringify({
    heartbeatSeconds: 1, silentSeconds: 2, hardSeconds: 30, pollMs: 100,
  }));
  ok(live(dir, 'open', 'orphan', 'chat', 'sessao', 'Sem orquestrador'));
  ok(live(dir, 'claim', 'orphan', 'primeiro'));
  const watcher = spawn(process.execPath, ['.codex/hooks/live.mjs', 'supervise', 'orphan'],
    { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (watcher.exitCode === null) watcher.kill(); });
  const [code] = await once(watcher, 'close');
  assert.equal(code, 3);
  const persisted = live(dir, 'status', 'orphan');
  assert.equal(persisted.status, 3);
  assert.match(JSON.parse(persisted.stdout).message, /orquestrador sem atualização/);
});
