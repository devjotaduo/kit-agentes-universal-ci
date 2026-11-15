// Confere, num projeto recém-instalado, que hooks, skills e agentes do kit funcionam juntos.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
const roles = ['flow-orchestrator', 'flow-discovery', 'flow-design', 'flow-build', 'flow-validation', 'flow-review'];
const env = { ...process.env, AGENT_KIT_NO_UPDATE_CHECK: '1' };

function project(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const done = spawnSync(process.execPath, [install, dir], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  return dir;
}
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
function frontmatter(text, file) {
  const block = text.replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(block, file + ': sem cabeçalho');
  const fields = Object.fromEntries(block[1].split('\n').filter((line) => /^[\w-]+:/.test(line))
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  return { fields, body: block[2].trim() };
}

// Cada hook declarado, rodado como o cliente roda, com a entrada do evento.
function hookRuns(dir) {
  const payload = (event, sessionId) => JSON.stringify({ hook_event_name: event, cwd: dir, session_id: sessionId,
    ...(event === 'PreToolUse' && { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch' } }) });
  const claudePayload = (event) => JSON.stringify({ hook_event_name: event, cwd: dir, session_id: 'saude',
    ...(event === 'PreToolUse' && { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') } }) });
  const runs = [];
  for (const [event, groups] of Object.entries(JSON.parse(read(dir, '.codex/hooks.json')).hooks)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      runs.push({ client: 'codex', event, result: spawnSync(hook.command, { cwd: dir, shell: true, encoding: 'utf8', env, input: payload(event, 'saude') }) });
    }
  }
  for (const [event, groups] of Object.entries(JSON.parse(read(dir, '.claude/settings.json')).hooks)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      const args = hook.args.map((arg) => arg.replace('${CLAUDE_PROJECT_DIR}', dir));
      runs.push({ client: 'claude', event, result: spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env, input: claudePayload(event) }) });
    }
  }
  return runs.map(({ client, event, result }) => {
    const label = client + ' ' + event;
    assert.equal(result.status, 0, label + ': ' + result.stderr);
    let output;
    assert.doesNotThrow(() => { output = JSON.parse(result.stdout); }, label + ': saída não é JSON: ' + result.stdout);
    return { client, event, output };
  });
}

test('hooks dos dois clientes rodam em todos os eventos e barram edição fora da etapa', (t) => {
  const dir = project(t);
  const idle = hookRuns(dir);
  for (const client of ['codex', 'claude']) {
    assert.deepEqual([...new Set(idle.filter((run) => run.client === client).map((run) => run.event))].sort(),
      ['PreToolUse', 'SessionStart', 'Stop'], client);
  }
  // Sem tarefa ativa a guarda não interfere.
  for (const run of idle.filter((item) => item.event === 'PreToolUse')) {
    assert.notEqual(run.output.hookSpecificOutput?.permissionDecision, 'deny', run.client);
  }
  const started = spawnSync(process.execPath, ['.agent-kit/kit.mjs', 'flow', 'new', 'fix', 'Conferir a guarda'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(started.status, 0, started.stderr);
  const guarded = hookRuns(dir).filter((run) => run.event === 'PreToolUse');
  assert.equal(guarded.length, 2);
  for (const run of guarded) assert.equal(run.output.hookSpecificOutput?.permissionDecision, 'deny', run.client + ' deixou editar em discover');
});

test('skills instaladas têm cabeçalho válido e o fluxo só cita skills que existem', (t) => {
  const dir = project(t);
  const folder = path.join(dir, '.agents', 'skills');
  const skills = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(skills.length > 0);
  for (const name of skills) {
    const { fields, body } = frontmatter(read(dir, '.agents/skills/' + name + '/SKILL.md'), name);
    assert.equal(fields.name, name, name + ': nome diferente da pasta');
    assert.ok(fields.description?.length > 20, name + ': sem descrição');
    assert.ok(body.length > 0, name + ': sem conteúdo');
    assert.ok(existsSync(path.join(folder, name, 'agents', 'openai.yaml')), name + ': sem metadados do Codex');
  }
  const stages = read(dir, 'docs/agent-flow.md').split('\n').filter((line) => /^\| (?:discover|specify|slice|implement|validate|review|ready) \|/.test(line));
  assert.equal(stages.length, 7);
  for (const line of stages) {
    const [, stage, role, cited] = line.split('|').map((cell) => cell.trim());
    assert.ok(roles.includes(role) || role === 'agente principal', stage + ': papel desconhecido ' + role);
    assert.ok(skills.some((name) => new RegExp('(?<![\\w-])' + name + '(?![\\w-])').test(cited)), stage + ': nenhuma skill instalada citada');
    for (const name of cited.match(/(?<![\w-])[a-z]+(?:-[a-z]+)+(?![\w-])/g) ?? []) {
      assert.ok(skills.includes(name), stage + ': skill citada não existe: ' + name);
    }
  }
});

test('os seis agentes existem nos dois clientes, sem modelo fixo e apontando para documentos que existem', (t) => {
  const dir = project(t);
  assert.deepEqual(readdirSync(path.join(dir, '.codex', 'agents')).sort(), roles.map((role) => role + '.toml').sort());
  assert.deepEqual(readdirSync(path.join(dir, '.claude', 'agents')).sort(), roles.map((role) => role + '.md').sort());
  for (const role of roles) {
    const toml = read(dir, '.codex/agents/' + role + '.toml').replaceAll('\r\n', '\n');
    assert.match(toml, new RegExp('^name = "' + role + '"$', 'm'), role);
    assert.match(toml, /^description = ".{10,}"$/m, role);
    const instructions = toml.match(/^developer_instructions = """\n([\s\S]+?)\n"""$/m)?.[1];
    assert.ok(instructions?.trim(), role + ': sem instruções no Codex');
    assert.doesNotMatch(toml, /^model(?:_reasoning_effort)? =/m, role + ': modelo fixo no Codex');

    const { fields, body } = frontmatter(read(dir, '.claude/agents/' + role + '.md'), role);
    assert.equal(fields.name, role);
    assert.ok(fields.description?.length > 10, role + ': sem descrição no Claude');
    assert.equal(fields.model, 'inherit', role + ': modelo fixo no Claude');
    assert.ok(body, role + ': sem instruções no Claude');

    for (const text of [instructions, body]) {
      const cited = text.match(/(?:docs\/[\w-]+\.md|AGENTS\.md)/g) ?? [];
      assert.ok(cited.includes('docs/agent-flow.md') || cited.includes('docs/orquestracao.md'), role + ': não aponta para o fluxo');
      for (const file of cited) assert.ok(existsSync(path.join(dir, file)), role + ': cita arquivo ausente ' + file);
    }
  }
});

// No Windows o mesmo arquivo tem um nome curto (PASTA-~1). A guarda decide pelo arquivo real.
test('guarda no Windows trata o nome curto como o arquivo real e não segue junção', { skip: process.platform !== 'win32' }, (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'kit-nome-curto-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'projeto com nome longo');
  mkdirSync(dir);
  const short = (target) => spawnSync('powershell', ['-NoProfile', '-Command',
    "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('" + target + "').ShortPath"], { encoding: 'utf8' }).stdout?.trim();
  const shortDir = short(dir);
  if (!shortDir || shortDir.toLowerCase() === dir.toLowerCase()) return t.skip('volume sem nomes curtos');
  assert.equal(spawnSync(process.execPath, [install, dir], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, ['.agent-kit/kit.mjs', 'flow', 'new', 'fix', 'Conferir nome curto'], { cwd: dir, encoding: 'utf8', env }).status, 0);
  const decide = (file) => {
    const result = spawnSync(process.execPath, [path.join(dir, '.agent-kit', 'kit.mjs'), 'hook', 'claude'], { cwd: dir, encoding: 'utf8', env,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, session_id: 'curto', tool_name: 'Write', tool_input: { file_path: file } }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput ?? {};
  };
  const denied = (file) => decide(file).permissionDecision === 'deny';

  // Evidência pelo nome curto é aceita; produto pelo nome curto continua barrado pela etapa.
  assert.equal(denied(path.join(shortDir, 'docs', 'work', 'nota.md')), false);
  assert.equal(denied(path.join(shortDir, 'src', 'a.js')), true);
  // O estado do kit escrito pelo nome curto da pasta recebe a mesma recusa que pelo nome real.
  const state = path.join(dir, '.agent-flow', 'active.json');
  const shortState = path.join(short(path.join(dir, '.agent-flow')), 'active.json');
  assert.notEqual(shortState.toLowerCase(), state.toLowerCase());
  assert.equal(decide(shortState).permissionDecisionReason, decide(state).permissionDecisionReason);
  assert.equal(denied(shortState), true);
  // Junção fora do projeto apontando para dentro dele não vira caminho aceito.
  const junction = path.join(base, 'atalho');
  assert.equal(spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junction, dir], { encoding: 'utf8' }).status, 0);
  assert.equal(denied(path.join(junction, 'docs', 'work', 'nota.md')), true);
});
