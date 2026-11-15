import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
const launcher = '.agent-kit/kit.mjs';

function run(root, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 15000, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function project(t) {
  const sandbox = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'kit-agy-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'projeto');
  mkdirSync(root);
  run(root, [installer, root]);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  return { sandbox, root };
}

const payload = (root, file, conversation = 'conversa-um', name = 'write_to_file') => JSON.stringify({
  hookEventName: 'PreToolUse', conversationId: conversation, cwd: root, workspacePaths: [root],
  toolCall: { name, args: { TargetFile: path.isAbsolute(file) ? file : path.join(root, file) } },
});

test('Antigravity aplica a mesma guarda de etapa e de escopo por conversa', (t) => {
  const { root } = project(t);
  const hook = (file, conversation, name) => JSON.parse(run(root, [launcher, 'hook', 'antigravity'],
    { input: payload(root, file, conversation, name) }));
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste Antigravity']);
  assert.equal(hook('src/page.txt').decision, 'deny');
  assert.deepEqual(hook('docs/work/plano.md'), { decision: 'allow' });

  const evidence = '.agent-flow/notes/discovery.md';
  mkdirSync(path.join(root, '.agent-flow', 'notes'), { recursive: true });
  writeFileSync(path.join(root, evidence), 'Descoberta de teste');
  run(root, [launcher, 'flow', 'record-parallel', 'discover', 'parent', 'discover-a', 'discover-b']);
  writeFileSync(path.join(root, '.agent-flow', 'notes', 'plano.md'), 'Plano de teste');
  run(root, [launcher, 'flow', 'approve', '.agent-flow/notes/plano.md', 'Aceite de teste']);
  run(root, [launcher, 'flow', 'advance', 'discover', evidence]);
  run(root, [launcher, 'flow', 'scope', '--session', 'conversa-um', '--', 'src/**']);
  assert.deepEqual(hook('src/page.txt'), { decision: 'allow' });
  assert.deepEqual(hook('src/page.txt', 'conversa-um', 'multi_replace_file_content'), { decision: 'allow' });
  assert.match(hook('src/page.txt', 'conversa-dois').reason, /scope --session conversa-dois/);
  assert.equal(hook(path.join(root, '..', 'fora.txt')).decision, 'deny');
  const broken = JSON.parse(run(root, [launcher, 'hook', 'antigravity'], { input: '{' }));
  assert.equal(broken.decision, 'deny');
});

test('Antigravity 1.5.5: edit_file com Path passa pela guarda, leitura passa direto e escrita sem destino é recusada', (t) => {
  const { root } = project(t);
  const send = (toolCall) => JSON.parse(run(root, [launcher, 'hook', 'antigravity'], { input: JSON.stringify({
    hookEventName: 'PreToolUse', conversationId: 'c1', cwd: root, workspacePaths: [root], toolCall,
  }) }));
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste edit_file']);
  // Formato observado numa sessão real do agy 1.5.5: Target é o texto antigo, não o caminho.
  const edit = send({ name: 'edit_file', args: { Path: path.join(root, 'src', 'sub.js'), Target: 'a + b', Replacement: 'a - b' } });
  assert.equal(edit.decision, 'deny');
  assert.match(edit.reason, /indisponível em discover/);
  assert.deepEqual(send({ name: 'read_file', args: { Path: path.join(root, 'src', 'sub.js') } }), { decision: 'allow' });
  assert.deepEqual(send({ name: 'run_command', args: { CommandLine: 'ls' } }), { decision: 'allow' });
  assert.match(send({ name: 'create_new_file', args: { Conteudo: 'x' } }).reason, /não foi possível ler o destino/);
  assert.equal(send({ name: 'move_file', args: { SourcePath: path.join(root, 'docs/work/a.md'), DestinationPath: path.join(root, 'src/a.md') } }).decision,
    'deny', 'o destino fora do permitido recusa, mesmo com a origem permitida');
});

test('resposta da guarda comum fora do formato conhecido vira recusa, e sem objeção segue para a política normal', async () => {
  const { fromCommon } = await import(pathToFileURL(path.resolve('template/.codex/hooks/antigravity.mjs')));
  assert.deepEqual(fromCommon({}), { decision: 'allow' });
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fora do escopo' } };
  assert.deepEqual(fromCommon(deny), { decision: 'deny', reason: 'fora do escopo' });
  for (const strange of [null, [], 'texto', { hookSpecificOutput: { permissionDecision: 'allow' } }, { outra: 1 }]) {
    assert.equal(fromCommon(strange).decision, 'deny');
  }
});

test('setup do Antigravity cria os arquivos uma vez, não sobrescreve e respeita o Concord do usuário', async (t) => {
  const { sandbox, root } = project(t);
  const { setup } = await import(pathToFileURL(path.join(root, '.codex', 'hooks', 'antigravity.mjs')));
  const home = path.join(sandbox, 'home');
  mkdirSync(home);
  assert.deepEqual(setup(root, home), ['.agents/hooks.json: criado.', '.agents/mcp_config.json: criado.']);
  assert.deepEqual(setup(root, home), ['.agents/hooks.json: já atualizado.', '.agents/mcp_config.json: já atualizado.']);
  writeFileSync(path.join(root, '.agents', 'hooks.json'), '{}\n');
  assert.match(setup(root, home)[0], /já existe com outro conteúdo; não alterado/);
  assert.equal(readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'), '{}\n');

  const other = path.join(sandbox, 'outro');
  mkdirSync(other);
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { coord: { command: 'concord-mcp' } } }));
  assert.match(setup(other, home)[1], /mcp_config\.json: não criado; o Antigravity já tem um servidor Concord/);
});

test('hook gerado roda a partir de .agents sem aspas e falha quando o kit não está lá', async (t) => {
  const { sandbox, root } = project(t);
  const { projectFiles } = await import(pathToFileURL(path.join(root, '.codex', 'hooks', 'antigravity.mjs')));
  const command = projectFiles()['.agents/hooks.json']['agent-flow'].PreToolUse[0].hooks[0].command;
  assert.doesNotMatch(command, /["']/, 'o executor do agy não respeita aspas');
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste do comando']);
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  // Sem shell, palavra por palavra, como o agy executa, e com .agents como diretório atual.
  const [exe, ...args] = command.split(' ');
  const exec = (cwd) => spawnSync(exe === 'node' ? process.execPath : exe, args, { cwd, encoding: 'utf8', input: payload(root, 'src/page.txt') });
  assert.equal(JSON.parse(exec(path.join(root, '.agents')).stdout).decision, 'deny');
  const outside = path.join(sandbox, 'sem-kit', '.agents');
  mkdirSync(outside, { recursive: true });
  assert.notEqual(exec(outside).status, 0, 'sem o kit, o hook falha e o agy não roda a ferramenta');
});
