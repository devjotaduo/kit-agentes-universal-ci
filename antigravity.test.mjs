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
  // O projeto fica na pasta temporária, que a guarda aceita fora da raiz: o hook usa outra.
  const temp = path.join(os.tmpdir(), 'kit-agy-sem-temp');
  const home = path.join(os.tmpdir(), 'kit-agy-sem-home');
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  const hook = (file, conversation, name) => JSON.parse(run(root, [launcher, 'hook', 'antigravity'],
    { env, input: payload(root, file, conversation, name) }));
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
  // A memória do Claude Code para este projeto não é destino do Antigravity.
  const memory = path.join(home, '.claude', 'projects', realpathSync.native(root).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  assert.equal(hook(path.join(memory, 'MEMORY.md')).decision, 'deny');
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
  assert.match(send({ name: 'create_new_file', args: { Conteudo: 'x' } }).reason, /não foi possível ler o destino.*terminada em Path ou File/);
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
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'agy'), '');
  const env = { PATH: bin };
  const names = ['.agents/hooks.json', '.agents/agent-flow-hook.cjs', '.agents/mcp_config.json'];
  assert.deepEqual(setup(root, home, env), names.map((name) => name + ': criado.'));
  assert.deepEqual(setup(root, home, env), names.map((name) => name + ': já atualizado.'));
  writeFileSync(path.join(root, '.agents', 'hooks.json'), '{}\n');
  assert.match(setup(root, home, env)[0], /^AVISO: .*falta a entrada agent-flow; não alterado\. A guarda de edição não ficou instalada/);
  assert.equal(readFileSync(path.join(root, '.agents', 'hooks.json'), 'utf8'), '{}\n');

  const other = path.join(sandbox, 'outro');
  mkdirSync(other);
  mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { coord: { command: 'concord-mcp' } } }));
  assert.match(setup(other, home, env)[2], /mcp_config\.json: não criado; o Antigravity já tem um servidor Concord/);
});

test('setup do Antigravity compara por conteúdo e avisa quando a guarda, o Concord ou o agy ficaram de fora (#91)', async (t) => {
  const { sandbox, root } = project(t);
  const script = path.join(root, '.codex', 'hooks', 'antigravity.mjs');
  const { setup, projectFiles } = await import(pathToFileURL(script));
  const home = path.join(sandbox, 'home');
  const env = { PATH: path.join(sandbox, 'vazio') };
  const files = projectFiles();
  setup(root, home, env);
  const hookFile = path.join(root, '.agents', 'agent-flow-hook.cjs');
  const lines = (hooks, mcp) => {
    writeFileSync(path.join(root, '.agents', 'hooks.json'), hooks);
    writeFileSync(path.join(root, '.agents', 'mcp_config.json'), mcp);
    return setup(root, home, env);
  };
  const hooks = JSON.stringify(files['.agents/hooks.json']);
  const mcp = JSON.stringify(files['.agents/mcp_config.json']);
  let out = lines(hooks, mcp);
  assert.deepEqual(out.slice(0, 3), ['.agents/hooks.json: já atualizado.', '.agents/agent-flow-hook.cjs: já atualizado.',
    '.agents/mcp_config.json: já atualizado.'], 'mesmo JSON em uma linha');
  assert.match(out[3], /^AVISO: agy não encontrado no PATH/);

  out = lines(JSON.stringify({ ...files['.agents/hooks.json'], outro: { PreToolUse: [] } }), '{ não é json');
  assert.match(out[0], /^\.agents\/hooks\.json: já tem a entrada agent-flow do kit/);
  assert.match(out[2], /^AVISO: \.agents\/mcp_config\.json: JSON inválido; não alterado\. O Concord do kit não ficou instalado/);

  const old = { 'agent-flow': { PreToolUse: [{ matcher: '^(?:write_to_file|replace_file_content|multi_replace_file_content)$', hooks: [] }] } };
  out = lines(JSON.stringify(old), JSON.stringify({ mcpServers: { outro: { command: 'x' } } }));
  assert.match(out[0], /^AVISO: .*kit 0\.5\.0.*edit_file.*A guarda de edição não ficou instalada/);
  assert.match(out[2], /^AVISO: .*falta a entrada concord-kit/);

  const v160 = { 'agent-flow': { PreToolUse: [{ hooks: [{ timeout: 10, command: 'node ../.agent-kit/kit.mjs hook antigravity', type: 'command' }], matcher: '.*' }] } };
  out = lines(JSON.stringify(v160), mcp);
  assert.match(out[0], /^\.agents\/hooks\.json: a entrada agent-flow é a da versão 1\.6\.0/, 'a guarda da 1.6.0 funciona: sem AVISO');

  // O script do hook com outro conteúdo não é sobrescrito, e o fim de linha CRLF não conta como diferença.
  writeFileSync(hookFile, files['.agents/agent-flow-hook.cjs'].replace(/\n/g, '\r\n'));
  assert.equal(lines(hooks, mcp)[1], '.agents/agent-flow-hook.cjs: já atualizado.');
  writeFileSync(hookFile, '// meu\n');
  assert.match(lines(hooks, mcp)[1], /^AVISO: \.agents\/agent-flow-hook\.cjs: já existe com outro conteúdo; não alterado\. A guarda de edição não ficou instalada/);
  assert.equal(readFileSync(hookFile, 'utf8'), '// meu\n');

  // Pela linha de comando, a guarda fora faz o setup sair com código 1.
  const cli = () => spawnSync(process.execPath, [script, 'setup'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(cli().status, 1);
  writeFileSync(hookFile, files['.agents/agent-flow-hook.cjs']);
  lines('[', mcp);
  const result = cli();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /AVISO: \.agents\/hooks\.json: JSON inválido/);
});

test('hook gerado roda sem aspas a partir de .agents e recusa com instrução quando o kit não está lá', async (t) => {
  const { sandbox, root } = project(t);
  const { projectFiles, setup } = await import(pathToFileURL(path.join(root, '.codex', 'hooks', 'antigravity.mjs')));
  const command = projectFiles()['.agents/hooks.json']['agent-flow'].PreToolUse[0].hooks[0].command;
  assert.equal(command, 'node agent-flow-hook.cjs', 'o executor do agy não respeita aspas');
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste do comando']);
  setup(root, path.join(sandbox, 'home'), {});
  // Sem shell, palavra por palavra, como o agy executa, com .agents como diretório atual.
  const [exe, ...args] = command.split(' ');
  const exec = (cwd) => spawnSync(exe === 'node' ? process.execPath : exe, args, { cwd, encoding: 'utf8', input: payload(root, 'src/page.txt') });
  const result = exec(path.join(root, '.agents'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /indisponível em discover/);
  // Sem o kit na pasta de cima o script não procura mais acima: recusa e diz como reinstalar.
  const outside = path.join(sandbox, 'sem-kit', '.agents');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'agent-flow-hook.cjs'), projectFiles()['.agents/agent-flow-hook.cjs']);
  const missing = exec(outside);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).decision, 'deny');
  assert.match(JSON.parse(missing.stdout).reason, /kit não encontrado.*--client antigravity setup/);
});

test('guarda do Antigravity: nomes em camelCase e hífen, evento fixo e carga sem nome (#86)', (t) => {
  const { root } = project(t);
  const raw = (input) => JSON.parse(run(root, [launcher, 'hook', 'antigravity'], { input }));
  const send = (toolCall, extra = {}) => raw(JSON.stringify({ hookEventName: 'PreToolUse', conversationId: 'c1', cwd: root,
    workspacePaths: [root], toolCall, ...extra }));
  const file = path.join(root, 'soma.mjs');
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste de nomes']);
  for (const name of ['writeFile', 'WriteToFile', 'write-file', 'update_file', 'modifyFile', 'save_file', 'apply_patch',
    'writefile', 'multiedit', 'fileedit', 'strreplace', 'copy_file', 'touch', 'mkdir', 'download_file', 'put_object']) {
    assert.match(send({ name, args: { Path: file } }).reason, /indisponível em discover/, name);
  }
  // Leitura comum continua passando, também com o nome todo em minúsculas.
  for (const name of ['viewFile', 'view_file', 'list_dir', 'grep_search', 'readfile', 'listdir', 'readoutput', 'codebasesearch']) {
    assert.deepEqual(send({ name, args: { Path: file } }), { decision: 'allow' }, name);
  }
  assert.match(send({ name: 'edit_file', args: { Path: file } }, { hookEventName: 'pre_tool_use' }).reason, /indisponível em discover/);
  for (const input of ['{"hookEventName":"PreToolUse"}', JSON.stringify({ tool_name: 'edit_file', tool_input: { Path: file } }), 'null', '[]']) {
    const out = raw(input);
    assert.equal(out.decision, 'deny', input);
    assert.match(out.reason, /formato de hook não reconhecido/, input);
  }
});

test('guarda do Antigravity: sem tarefa não recusa, e com tarefa lê file_path, listas, aninhados, texto JSON e file:// (#87)', (t) => {
  const { root } = project(t);
  const send = (name, args) => JSON.parse(run(root, [launcher, 'hook', 'antigravity'], { input: JSON.stringify({
    hookEventName: 'PreToolUse', conversationId: 'c1', cwd: root, workspacePaths: [root], toolCall: { name, args },
  }) }));
  const file = path.join(root, 'soma.mjs');
  const work = path.join(root, 'docs', 'work', 'a.md');
  const unreadable = [['write_file', { Path: 7 }], ['write_file', { Paths: [work, 7] }], ['write_to_file', { TargetFile: 5 }],
    ['write_to_file', 'not json'], ['write_to_file', { TargetFile: 'file:///a%2Fb' }], ['save_report', { OutputDir: work }],
    ['copy_file', { Source: work, To: 'src/a.js' }], ['rename_file', { Path: work, NewName: 'src/a.js' }],
    ['create_file', { FileName: 'src/a.js', Content: 'x' }]];
  for (const [name, args] of [['create_task', { Title: 'x' }], ['write_todos', { Todos: ['a'] }], ['write_to_file', {}],
    ['create_memory', { Content: 'x' }], ['write_to_file', { TargetFile: file }], ...unreadable]) {
    assert.deepEqual(send(name, args), { decision: 'allow' }, name + ' ' + JSON.stringify(args) + ' sem tarefa ativa');
  }
  run(root, [launcher, 'flow', 'new', 'fix', 'Teste de destinos']);
  const noTarget = send('create_memory', { Content: 'x' });
  assert.equal(noTarget.decision, 'deny');
  assert.match(noTarget.reason, /não foi possível ler o destino de create_memory\. A guarda lê o destino de Path, TargetFile, file_path/);
  for (const [name, args] of unreadable) {
    assert.match(send(name, args).reason, /não foi possível ler o destino/, name + ' ' + JSON.stringify(args));
  }
  for (const [name, args] of [['edit_file', { file_path: file }], ['edit_file', { Paths: [work, file] }], ['edit_file', { NotebookPath: file }],
    ['edit_file', JSON.stringify({ Path: file })], ['edit_file', { Path: pathToFileURL(file).href }],
    ['copy_file', { SourcePath: work, DestinationPath: file }], ['move_file', { Source: work, Target: file }],
    ['apply_edits', { edits: [{ path: work, text: 'a' }, { path: file, text: 'b' }] }],
    ['save_report', { Report: { Where: file }, Content: 'x' }], ['save_report', { Where: pathToFileURL(file).href }]]) {
    assert.match(send(name, args).reason, /indisponível em discover/, name + ' ' + JSON.stringify(args));
  }
  assert.deepEqual(send('edit_file', { Path: work, Target: 'texto antigo' }), { decision: 'allow' }, 'no edit_file, Target é o texto');
  assert.deepEqual(send('edit_file', { Path: pathToFileURL(work).href }), { decision: 'allow' });
  assert.deepEqual(send('edit_file', JSON.stringify({ file_path: work })), { decision: 'allow' });
  assert.deepEqual(send('apply_edits', { edits: [{ path: work }] }), { decision: 'allow' });
  // Ferramentas do Concord passam com tarefa ativa; outra ferramenta de MCP com o mesmo verbo, não.
  for (const name of ['mcp_concord-kit_update_work', 'mcp_concord-kit_start_work', 'mcp_concord_finish_work',
    'mcp_concord-kit_transfer_work', 'mcp_concord-kit_inspect_work']) {
    assert.deepEqual(send(name, { workspace_id: 'w', content: 'x' }), { decision: 'allow' }, name);
  }
  assert.deepEqual(send('write_to_file', { TargetFile: work, CodeContent: '/** cabeçalho */\nconst a = 1;' }), { decision: 'allow' },
    'texto a gravar que começa com / não é destino');
  for (const name of ['mcp_outro_update_work', 'mcp_fakeconcord_update_work', 'mcp_concord-fake_update_work']) {
    assert.equal(send(name, { content: 'x' }).decision, 'deny', name);
  }
});
