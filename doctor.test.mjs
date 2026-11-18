import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diagnose } from './template/.codex/hooks/doctor.mjs';

const root = path.resolve('template');
const token = 'SEGREDO-NAO-IMPRIMIR-123';
const models = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'];
const adapters = '  claude-code  installed           native-monitor\n  codex        action_required     managed-controller\n';

function home({ healthy }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-doctor-'));
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  put('.codex/config.toml', [
    'model = "x"',
    '[mcp_servers.twenty.env]', 'API_KEY = "' + token + '"',
    '[mcp_servers.concord]', 'command = "concord-mcp"', 'enabled = ' + healthy,
    ...(healthy ? [
      "[projects.'" + path.dirname(root) + "']", 'trust_level = "trusted"',
      "[hooks.state.'" + path.join(root, '.codex', 'hooks.json') + ":pre_tool_use:0:0']", 'trusted_hash = "abc"',
    ] : []),
    "[hooks.state.'" + path.join(dir, '.codex', 'hooks.json') + ":stop:0:0']", 'trusted_hash = "def"',
  ].join('\n'));
  put('.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node --token=' + token + ' "C:/x/guarda-testes.mjs"' }] }] } }));
  put('.claude/settings.json', JSON.stringify({
    mcpServers: { twenty: { headers: { Authorization: 'Bearer ' + token } } },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/guarda-worktrees.mjs"' }] }] },
  }));
  put('.claude.json', JSON.stringify({ mcpServers: healthy ? {} : { concord: { command: 'concord-mcp', env: { T: token } } } }));
  put('.claude/plugins/cache/oficial/mattpocock-skills/' + (healthy ? '1.3.2' : '1.3.1') + '/x', '');
  return dir;
}

const texts = (items, level) => items.filter((item) => item.level === level).map((item) => item.text).join('\n');

test('doctor aponta bloqueios e avisos de uma máquina com conflitos, sem imprimir segredos', () => {
  const items = diagnose({ root, home: home({ healthy: false }), catalog: models.slice(1), adapters });
  const blocks = texts(items, 'block');
  assert.match(blocks, /Codex.*Concord.*desativado/);
  assert.match(blocks, /Codex.*confiável/);
  const warns = texts(items, 'warn');
  assert.match(warns, /concord-kit/);
  assert.match(warns, /1\.3\.1/);
  assert.match(warns, /code-review/);
  assert.match(warns, /guarda-testes\.mjs/);
  assert.match(warns, /guarda-worktrees\.mjs/);
  assert.match(warns, /action_required/);
  assert.match(warns, /sem registro de aprovação/);
  assert.doesNotMatch(JSON.stringify(items), new RegExp(token));
});

test('doctor avisa, sem bloquear, quando a preferência de modelo do projeto não está no catálogo', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'kit-doctor-rota-'));
  mkdirSync(path.join(project, '.codex'));
  writeFileSync(path.join(project, '.codex', 'model-routing.json'), JSON.stringify({ light: { model: 'modelo-sumido', effort: 'low' } }));
  const items = diagnose({ root: project, home: home({ healthy: true }), catalog: models, adapters });
  assert.match(texts(items, 'warn'), /modelo-sumido/);
  assert.doesNotMatch(texts(items, 'block'), /modelo-sumido/);
  assert.doesNotMatch(texts(diagnose({ root, home: home({ healthy: true }), catalog: null, adapters }), 'warn'), /roteamento não conferido/);
});

test('doctor não bloqueia uma máquina com o kit confiável e Concord ativo', () => {
  const items = diagnose({ root, home: home({ healthy: true }), catalog: models, adapters });
  assert.equal(texts(items, 'block'), '');
  assert.doesNotMatch(texts(items, 'warn'), /concord-kit|1\.3\.1|sem registro de aprovação/);
});

test('doctor não aceita numa worktree a aprovação dos hooks dada à worktree principal', (t) => {
  // Nome longo (no runner do Windows o tmp vem como RUNNER~1), igual ao que o Git e o Codex gravam.
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'kit-doctor-wt-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, encoding: 'utf8' }).status, 0, args.join(' '));
  const main = path.join(base, 'principal');
  const other = path.join(base, 'outra');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(main, 'worktree', 'add', '-q', other);
  const approval = (dir) => bare("[projects.'" + base + "']\ntrust_level = \"trusted\"\n"
    + "[hooks.state.'" + path.join(dir, '.codex', 'hooks.json') + ":pre_tool_use:0:0']\ntrusted_hash = \"abc\"\n");
  const fromMain = texts(diagnose({ root: other, home: approval(main), catalog: models, adapters }), 'warn');
  assert.match(fromMain, /aprovação gravada é a dos hooks da worktree principal .*aprove em \/hooks numa sessão aberta aqui/);
  const own = diagnose({ root: other, home: approval(other), catalog: models, adapters });
  assert.match(texts(own, 'ok'), /aprovação para os hooks desta pasta/);
});

// Pasta de usuário mínima: só o config.toml do Codex e, se pedido, arquivos do Claude.
function bare(config, files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-doctor-'));
  mkdirSync(path.join(dir, '.codex'));
  if (config !== null) writeFileSync(path.join(dir, '.codex', 'config.toml'), config);
  for (const [file, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
  }
  return dir;
}
const top = path.dirname(root);
const run = (dir) => diagnose({ root, home: dir, catalog: models, adapters: '' });

test('confiança do Codex vale pela pasta exata; ancestral só avisa e não confiável explícito bloqueia', () => {
  const trusted = (dir) => "[projects.'" + dir + "']\ntrust_level = \"trusted\"\n";
  assert.match(texts(run(bare(trusted(path.dirname(top)))), 'warn'), /pasta acima/);
  assert.doesNotMatch(texts(run(bare(trusted(path.dirname(top)))), 'ok'), /pasta do projeto confiável/);
  const denied = trusted(path.dirname(top)) + "[projects.'" + top + "']\ntrust_level = \"untrusted\"\n";
  assert.match(texts(run(bare(denied)), 'block'), /marcada como não confiável/);
  assert.match(texts(run(bare("[ projects.'" + top + "' ] # nota\n  trust_level = 'trusted'\n")), 'ok'), /confiável/);
});

test('Codex instalado sem config.toml bloqueia em vez de sumir do relatório', () => {
  const blocks = texts(run(bare(null)), 'block');
  assert.match(blocks, /não é confiável/);
  assert.match(blocks, /Concord não encontrado/);
});

test('cadastro do Concord é lido com recuo, aspas e comentário no cabeçalho', () => {
  assert.match(texts(run(bare('[mcp_servers."concord"] # kit\n  enabled = false\n')), 'block'), /desativado/);
  assert.match(texts(run(bare('[mcp_servers.concord]\nenabled=true # x\n')), 'ok'), /cadastrado e ativo/);
});

test('token em forma de nome de arquivo num argumento de hook não aparece', () => {
  const hooks = { hooks: { Stop: [{ hooks: [
    { type: 'command', command: 'node guard.mjs --out=' + token + '.sh ' + '--key ' + token + '.js' },
    { type: 'command', command: 'node', args: ['C:/x/outro.mjs', '--key=' + token + '.js'] },
  ] }] } };
  const items = run(bare('', { '.codex/hooks.json': hooks }));
  assert.match(texts(items, 'warn'), /guard\.mjs, outro\.mjs/);
  assert.doesNotMatch(JSON.stringify(items), new RegExp('--key|--out|' + token));
});

test('arquivo global malformado vira aviso, sem exceção e sem citar o conteúdo', () => {
  const items = run(bare('', {
    '.codex/hooks.json': '{"hooks": {"Stop": {"x": 5}}, "t": "' + token + '"',
    '.claude/settings.json': { hooks: { Stop: { hooks: 5 } } },
  }));
  assert.match(texts(items, 'warn'), /hooks\.json ilegível/);
  assert.doesNotMatch(JSON.stringify(items), new RegExp(token));
});

test('Claude bloqueia quando o concord-kit foi recusado e reconhece a confiança da pasta', () => {
  const project = (extra) => ({ projects: { [top.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, ...extra } } });
  const refused = run(bare('', { '.claude/x': '', '.claude.json': project({ disabledMcpjsonServers: ['concord-kit'] }) }));
  assert.match(texts(refused, 'block'), /concord-kit desligado neste projeto e nenhum outro servidor do Concord/);
  const fine = run(bare('', { '.claude/x': '', '.claude.json': project({ enabledMcpjsonServers: ['concord-kit'] }) }));
  assert.match(texts(fine, 'ok'), /Claude: confiança da pasta aceita/);
  assert.doesNotMatch(texts(fine, 'block') + texts(fine, 'warn'), /concord-kit/);
  assert.match(texts(run(bare('', { '.claude/x': '' })), 'warn'), /ainda não aberto/);
  const pending = run(bare('', { '.claude/x': '', '.claude.json': { projects: { [top.replaceAll('\\', '/')]: {} } } }));
  assert.match(texts(pending, 'block'), /confiança da pasta ainda não aceita/);
});

test('fonte de hooks de plugin aparece só pelo id, sem o resto da chave', () => {
  const items = run(bare("[hooks.state.'plug@loja:" + token + "/hooks.json:stop:0:0']\nx = 1\n"));
  assert.match(texts(items, 'warn'), /plug@loja/);
  assert.doesNotMatch(JSON.stringify(items), new RegExp(token));
});

test('versão ativa do plugin vem do registro de instalação, não de pastas antigas em cache', () => {
  const installed = { plugins: { 'mattpocock-skills@oficial': [{ version: '1.3.1' }] } };
  const items = run(bare('', { '.claude/plugins/installed_plugins.json': installed,
    '.claude/plugins/cache/oficial/mattpocock-skills/1.3.2/x': '' }));
  assert.match(texts(items, 'warn'), /1\.3\.1/);
});

test('transporte do kit que não abre é bloqueio', () => {
  const items = diagnose({ root, home: bare(''), catalog: models, adapters: '', transport: false });
  assert.match(texts(items, 'block'), /transporte do kit não abriu/);
});

test('guardas globais que recusam testes ou exigem commit são classificadas pelo conteúdo', () => {
  const dir = bare('', {
    'g/testes.mjs': "if (/jest|vitest/.test(c)) out({ permissionDecision: 'deny' })",
    'g/commit.mjs': "if (git(['status', '--porcelain'])) out({ decision: 'block', reason: 'faça commit e push' })",
    'g/outra.mjs': "out({ permissionDecision: 'deny' }); const exemplos = { 'npm i -D vitest': true }",
  });
  const hook = (file) => ({ hooks: [{ type: 'command', command: 'node "' + path.join(dir, 'g', file) + '"' }] });
  writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [hook('testes.mjs'), hook('outra.mjs')], Stop: [hook('commit.mjs')] } }));
  const warns = texts(run(dir), 'warn');
  assert.match(warns, /guarda global testes\.mjs \(PreToolUse\) parece recusar comandos de teste/);
  assert.match(warns, /guarda global commit\.mjs \(Stop\) parece impedir o fim do turno/);
  assert.doesNotMatch(warns, /guarda global outra\.mjs/);
});

test('guarda é lida pelo script certo: interpretador absoluto, mesmo nome em pastas diferentes, sem abrir argumentos de echo', () => {
  const dir = bare('', {
    'a/check.mjs': "if (/jest/.test(c)) out({ permissionDecision: 'deny' })",
    'b/check.mjs': "out({ permissionDecision: 'allow' })",
    'c/exemplo.mjs': "// exemplos: /jest/.test(x)\nout({ permissionDecision: 'deny', reason: 'arquivos protegidos' })",
    'd/segredo.mjs': "if (/jest/.test(c)) out({ permissionDecision: 'deny' })",
  });
  const at = (file) => '"' + path.join(dir, file) + '"';
  writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [
    { hooks: [{ type: 'command', command: '"C:/Program Files/nodejs/node.exe" ' + at('a/check.mjs') }] },
    { hooks: [{ type: 'command', command: 'node ' + at('b/check.mjs') }] },
    { hooks: [{ type: 'command', command: 'node ' + at('c/exemplo.mjs') }] },
    { hooks: [{ type: 'command', command: 'echo ' + at('d/segredo.mjs') }] },
  ] } }));
  const warns = texts(run(dir), 'warn');
  assert.equal(warns.match(/guarda global check\.mjs/g)?.length, 1);
  assert.doesNotMatch(warns, /exemplo\.mjs \(PreToolUse\)|segredo\.mjs/);
});

test('valores multilinha, env e comentários não viram servidor nem comando do Concord', () => {
  const config = [
    '[mcp_servers.concord]', 'command = "concord-mcp"',
    '[mcp_servers.concord.env]', 'PAYLOAD = """', '[mcp_servers.nome_extra]', 'command = "concord-mcp"', '"""',
    '[mcp_servers.outro]', 'command = "other-mcp" # concord-mcp', 'env = { NOTE = "concord-mcp" }',
    '[mcp_servers.falso]', 'command = "not-concord-mcp-wrapper"',
  ].join('\n');
  const items = run(bare(config));
  assert.doesNotMatch(JSON.stringify(items), /nome_extra|mais de um servidor/);
  const tricky = [
    '[mcp_servers.concord]', 'command = "concord-mcp"',
    '[mcp_servers.concord.env]', 'A = """texto \\""" ainda dentro', '[mcp_servers.escondido]', 'command = "concord-mcp"', '"""',
    '[mcp_servers.comentado] # """', 'args = ["ok"] # "concord-mcp"', 'command = "npx"',
    '[mcp_servers.multilinha]', 'command = "npx"', 'args = [', '  "-y",', '  "@concord-ai/concord-mcp@0.20.0",', ']',
  ].join('\n');
  const edge = tricky + '\n' + [
    '[mcp_servers.literal]', 'command = "npx"', "args = ['''concord-mcp''']",
    '[mcp_servers.colchete]', 'command = "npx"', 'args = [', '  "--cache=C:/tmp/x]",', '  "concord-mcp",', ']',
  ].join('\n');
  assert.match(texts(run(bare(edge)), 'warn'), /abre o Concord: concord, multilinha, literal, colchete\./);
  const warns = texts(run(bare(tricky)), 'warn');
  assert.match(warns, /abre o Concord: concord, multilinha\./);
  assert.doesNotMatch(warns, /escondido|comentado/);
  const quoted = run(bare('[mcp_servers.concord]\ncommand = "concord-mcp"\n[mcp_servers."coord.backup"]\nargs = ["-y", "@concord-ai/concord-mcp@0.20.0"]\ncommand = "npx"\n'));
  assert.match(texts(quoted, 'warn'), /abre o Concord: concord, coord\.backup\./);
});

test('concord-kit recusado no Claude não gera aviso de dois agentes', () => {
  const items = run(bare('', { '.claude/x': '', '.claude.json': {
    mcpServers: { coord: { command: 'concord-mcp' } },
    projects: { [top.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, disabledMcpjsonServers: ['concord-kit'] } },
  } }));
  assert.doesNotMatch(texts(items, 'block'), /concord-kit/, 'com o Concord do usuário, desligar o concord-kit é o certo');
  assert.match(texts(items, 'ok'), /concord-kit desligado neste projeto; a sessão usa o Concord do usuário \(coord\)/);
  assert.doesNotMatch(texts(items, 'warn'), /dois agentes/);
});

test('concord-kit desligado no .claude/settings.json do projeto conta, como na issue 12', (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'kit-doctor-projeto-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(path.join(projectRoot, '.claude'));
  writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'concord-kit': { command: 'node' } } }));
  const home = bare('', { '.claude/x': '', '.claude.json': { mcpServers: { concord: { command: 'concord-mcp' } } } });
  for (const file of ['settings.json', 'settings.local.json']) {
    writeFileSync(path.join(projectRoot, '.claude', file), JSON.stringify({ disabledMcpjsonServers: ['concord-kit'] }));
    const items = diagnose({ root: projectRoot, home, catalog: models, adapters: '' });
    assert.doesNotMatch(texts(items, 'warn'), /dois agentes/, file);
    assert.match(texts(items, 'ok'), /a sessão usa o Concord do usuário \(concord\)/, file);
    rmSync(path.join(projectRoot, '.claude', file));
  }
  const both = diagnose({ root: projectRoot, home, catalog: models, adapters: '' });
  assert.match(texts(both, 'warn'), /dois agentes/, 'sem a recusa, o aviso volta');
});

test('busca de skills em plugin grande para no orçamento e avisa', () => {
  const files = { '.claude/plugins/x': '' };
  for (let i = 0; i < 60; i += 1) for (let j = 0; j < 40; j += 1) files['p/n' + i + '/m' + j + '/x'] = '';
  const dir = bare('', files);
  writeFileSync(path.join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'grande@loja': [{ installPath: path.join(dir, 'p') }] } }));
  assert.match(texts(run(dir), 'warn'), /busca de skills interrompida por tamanho em grande/);
});

test('mais de um servidor que abre o Concord é apontado nos dois clientes', () => {
  const config = '[mcp_servers.concord]\ncommand = "concord-mcp"\n[mcp_servers.coord]\ncommand = "C:/npm/concord-mcp.cmd"\n'
    + '[mcp_servers.coord.env]\nT = "' + token + '"\n[mcp_servers.velho]\ncommand = "concord-mcp"\nenabled = false\n';
  assert.match(texts(run(bare(config)), 'warn'), /mais de um servidor MCP ativo abre o Concord: concord, coord\./);
  const claude = run(bare('', { '.claude/x': '', '.claude.json': { mcpServers: { coord: { command: 'concord-mcp', env: { T: token } } } } }));
  assert.match(texts(claude, 'warn'), /abre o Concord \(coord\) e o concord-kit/);
  assert.doesNotMatch(JSON.stringify(claude), new RegExp(token));
});

test('skills do usuário com nome de skill do kit são apontadas por cliente', () => {
  const warns = texts(run(bare('', {
    '.agents/skills/tdd/SKILL.md': '', '.agents/skills/minha/SKILL.md': '', '.claude/skills/grilling/SKILL.md': '',
  })), 'warn');
  assert.match(warns, /Codex: skills do usuário em ~\/\.agents\/skills .*: tdd\./);
  assert.match(warns, /Claude: skills do usuário em ~\/\.claude\/skills .*: grilling\./);
  assert.doesNotMatch(warns, /minha/);
});

test('skills de plugin com nome de skill do kit são contadas por plugin', () => {
  const dir = bare('', {
    '.claude/plugins/x': '', 'p/skills/eng/tdd/SKILL.md': '', 'p/skills/eng/diagnosing-bugs/SKILL.md': '',
    '.codex/plugins/cache/loja/outro/1.0.0/skills/tdd/SKILL.md': '',
  });
  writeFileSync(path.join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'pacote@loja': [{ installPath: path.join(dir, 'p') }] } }));
  const warns = texts(run(dir), 'warn');
  assert.match(warns, /Claude: plugins com skills de mesmo nome que as do kit: pacote \(2\)/);
  assert.match(warns, /Codex: plugins com skills de mesmo nome que as do kit: outro \(1\)/);
});

test('kit doctor recusa opção desconhecida', () => {
  const result = spawnSync(process.execPath, ['template/.agent-kit/kit.mjs', 'doctor', '--ofline'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--offline/);
});

test('kit doctor sai com código 1 quando há bloqueio e não vaza o token', () => {
  const result = spawnSync(process.execPath, ['template/.agent-kit/kit.mjs', '--client', 'portable', 'doctor', '--offline'], {
    encoding: 'utf8', env: { ...process.env, AGENT_KIT_HOME: home({ healthy: false }) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /BLOQUEIO/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
});

test('doctor avisa quando o usuário libera o Bash inteiro, e cita o rtk quando ele reescreve os comandos', () => {
  const rtk = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } };
  const both = run(bare('', { '.claude/settings.json': { permissions: { allow: ['Bash'] }, ...rtk } }));
  assert.match(texts(both, 'warn'), /não conte com as confirmações do projeto.*rtk/);
  const onlyOpen = run(bare('', { '.claude/settings.json': { permissions: { allow: ['Bash'] } } }));
  assert.match(texts(onlyOpen, 'warn'), /não conte com as confirmações do projeto/);
  assert.doesNotMatch(texts(onlyOpen, 'warn'), /rtk/);
  const narrow = run(bare('', { '.claude/settings.json': { permissions: { allow: ['Bash(git status*)'] } } }));
  assert.doesNotMatch(texts(narrow, 'warn'), /confirmações do projeto/);
});

test('Claude: doctor e início da sessão nomeiam o mesmo servidor do Concord, o do usuário antes do concord-kit', () => {
  const withUser = bare('', { '.claude/x': '', '.claude.json': { mcpServers: { concord: { command: 'concord-mcp' } } } });
  const items = run(withUser);
  assert.match(texts(items, 'warn'), /Esta sessão usa só o concord \(mcp__concord__\*\)/);
  assert.match(texts(items, 'ok'), /o Concord desta sessão é o servidor concord/);
  const start = (home) => JSON.parse(spawnSync(process.execPath, [path.join(root, '.codex', 'hooks', 'flow.mjs'), 'hook', 'claude'],
    { cwd: root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart' }), env: { ...process.env, AGENT_KIT_HOME: home } })
    .stdout).hookSpecificOutput.additionalContext;
  assert.match(start(withUser), /Concord: use só o servidor concord \(mcp__concord__\*\)/);
  const opened = (extra) => ({ projects: { [root.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, ...extra } } });
  // concord-kit ainda não aprovado não sobe: nada a nomear.
  const pending = bare('', { '.claude/x': '', '.claude.json': opened({}) });
  assert.doesNotMatch(texts(run(pending), 'ok'), /Concord desta sessão/);
  assert.doesNotMatch(start(pending), /Concord: use só/);
  const kitOnly = bare('', { '.claude/x': '', '.claude.json': opened({ enabledMcpjsonServers: ['concord-kit'] }) });
  assert.match(texts(run(kitOnly), 'ok'), /o Concord desta sessão é o servidor concord-kit/);
  assert.match(start(kitOnly), /use só o servidor concord-kit/);
});

test('Claude: concord-kit com executável diferente do dos hooks do kit é aviso (CONNECTION_CLOSED por ssh)', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'kit-doctor-root-'));
  const hooks = (command) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    { type: 'command', command, args: ['${CLAUDE_PROJECT_DIR}/.agent-kit/kit.mjs', 'hook', 'claude'] }] }] } });
  mkdirSync(path.join(project, '.claude'));
  writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'concord-kit': { command: 'node', args: ['.agent-kit/concord-mcp.mjs'] } } }));
  const check = () => texts(diagnose({ root: project, home: bare('', { '.claude/x': '' }), catalog: models, adapters: '' }), 'warn');
  writeFileSync(path.join(project, '.claude', 'settings.json'), hooks('/opt/node/bin/node'));
  assert.match(check(), /concord-kit abre com "node" e os hooks do kit com "\/opt\/node\/bin\/node"/);
  writeFileSync(path.join(project, '.claude', 'settings.json'), hooks('node'));
  assert.doesNotMatch(check(), /concord-kit abre com/);
  rmSync(project, { recursive: true, force: true });
});

test('doctor aponta hook do Concord sem timeout, no config.toml e nos JSON, e aceita os que têm', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-doctor-concord-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  // Caso real de 17/11/2026: o bloco que o Concord grava no config.toml do Codex, sem timeout.
  put('.codex/config.toml', [
    '[mcp_servers.concord]', 'command = "concord-mcp"',
    '[[hooks.SessionStart]]', '[[hooks.SessionStart.hooks]]', 'type = "command"',
    'command = "concord inbox register --from-hook --provider codex"',
    '[[hooks.Stop]]', '[[hooks.Stop.hooks]]', 'type = "command"',
    'command = "concord inbox drain --from-hook --provider codex --format stop"', 'timeout = 10',
  ].join('\n'));
  put('.codex/hooks.json', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [
    { type: 'command', command: 'concord.cmd inbox drain --from-hook', timeout: 10 }] }] } }));
  put('.claude/settings.json', JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: 'C:/bin/concord.exe', args: ['hook', 'claude-code'] }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/concord-notas.mjs"' }] }],
  } }));
  const warns = texts(diagnose({ root, home: dir, catalog: models, adapters: null }), 'warn');
  assert.match(warns, /Codex: hooks do Concord sem timeout em ~\/\.codex\/config\.toml \(SessionStart\)\./);
  assert.doesNotMatch(warns, /~\/\.codex\/hooks\.json \(/);
  assert.match(warns, /Claude: hooks do Concord sem timeout em ~\/\.claude\/settings\.json \(PreToolUse\)\./);
});

test('doctor mostra o tempo do hook de edição do kit e avisa perto do limite ou sem resposta', () => {
  const at = (hookMs) => diagnose({ root, home: home({ healthy: true }), catalog: models, adapters: null, hookMs });
  assert.match(texts(at(300), 'ok'), /hook de edição respondeu em 300 ms/);
  assert.match(texts(at(3000), 'warn'), /3000 ms.*Perto do limite/);
  assert.match(texts(at(false), 'warn'), /hook de edição não respondeu/);
  assert.doesNotMatch(JSON.stringify(at(null)), /hook de edição/);
});

test('hook de edição do kit responde em menos de 5 s com o Concord fora do PATH', () => {
  // Só o Node no PATH: concord, concord-mcp e o Concord Cloud ficam inalcançáveis.
  const env = { ...process.env, PATH: path.dirname(process.execPath), Path: path.dirname(process.execPath) };
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, '.agent-kit', 'kit.mjs'), 'hook', 'claude'],
    { cwd: root, env, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, session_id: 'sem-concord', tool_name: 'Write',
        tool_input: { file_path: path.join(root, 'docs', 'x.md') } }) });
  const ms = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  // template/ não tem tarefa ativa: a resposta é {} (o caminho com tarefa em implement fica em flow-guards.test.mjs).
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(ms < 5000, 'levou ' + ms + ' ms');
});

test('--client: o código de saída e os bloqueios são os do cliente pedido; os dos outros viram aviso (#88)', () => {
  const sick = home({ healthy: false });
  const items = diagnose({ root, home: sick, catalog: models, adapters: '', client: 'claude' });
  assert.equal(texts(items, 'block'), '');
  assert.match(texts(items, 'warn'), /Codex.*Concord.*desativado.*outro cliente/);
  assert.match(texts(diagnose({ root, home: sick, catalog: models, adapters: '', client: 'codex' }), 'block'), /Codex.*Concord/);
  const cli = (client) => spawnSync(process.execPath, ['template/.agent-kit/kit.mjs', '--client', client, 'doctor', '--offline'],
    { encoding: 'utf8', env: { ...process.env, AGENT_KIT_HOME: sick } });
  assert.equal(cli('claude').status, 0);
  assert.equal(cli('codex').status, 1);
});

test('--client hermes ou antigravity sem o cliente instalado diz que nada foi conferido (#88)', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'kit-doctor-sem-'));
  for (const [client, name] of [['hermes', 'Hermes'], ['antigravity', 'Antigravity']]) {
    const items = diagnose({ root: project, home: home({ healthy: false }), catalog: models, adapters: '', client });
    assert.match(texts(items, 'warn'), new RegExp(name + ': cliente não encontrado; nada conferido'));
    assert.equal(texts(items, 'block'), '');
  }
});

test('Antigravity: hooks.json do kit 0.5.0 (matcher de três ferramentas) é acusado, o atual confere (#88)', async () => {
  const { projectFiles } = await import('./template/.codex/hooks/antigravity.mjs');
  const project = mkdtempSync(path.join(tmpdir(), 'kit-doctor-agy-'));
  mkdirSync(path.join(project, '.agents'));
  mkdirSync(path.join(project, '.agent-kit'));
  writeFileSync(path.join(project, '.agent-kit', 'kit.mjs'), '');
  const files = projectFiles();
  const old = JSON.parse(JSON.stringify(files['.agents/hooks.json']));
  old['agent-flow'].PreToolUse[0].matcher = 'write_to_file|replace_file_content|multi_replace_file_content';
  const script = files['.agents/agent-flow-hook.cjs'];
  const check = (hooks, hookScript = script) => {
    writeFileSync(path.join(project, '.agents', 'hooks.json'), JSON.stringify(hooks));
    writeFileSync(path.join(project, '.agents', 'mcp_config.json'), JSON.stringify(files['.agents/mcp_config.json']));
    if (hookScript === null) rmSync(path.join(project, '.agents', 'agent-flow-hook.cjs'), { force: true });
    else writeFileSync(path.join(project, '.agents', 'agent-flow-hook.cjs'), hookScript);
    return diagnose({ root: project, home: home({ healthy: true }), catalog: models, adapters: '', client: 'antigravity' });
  };
  assert.match(texts(check(old), 'block'), /Antigravity.*matcher.*edit_file/);
  const good = check(files['.agents/hooks.json']);
  assert.equal(texts(good, 'block'), '');
  assert.match(texts(good, 'ok'), /Antigravity: \.agents\/hooks\.json confere/);
  assert.match(texts(good, 'ok'), /agent-flow-hook\.cjs confere/);
  // Fim de linha do Windows não conta; texto diferente é aviso; script ausente com hooks.json chamando-o é bloqueio.
  assert.equal(texts(check(files['.agents/hooks.json'], script.replace(/\n/g, '\r\n')), 'warn').includes('agent-flow-hook.cjs difere'), false);
  assert.match(texts(check(files['.agents/hooks.json'], script + '// editado\n'), 'warn'), /agent-flow-hook\.cjs difere/);
  assert.match(texts(check(files['.agents/hooks.json'], null), 'block'), /agent-flow-hook\.cjs não existe/);
  // 1.6.0: o comando antigo ainda guarda, então é aviso com o passo para trocar.
  const v160 = JSON.parse(JSON.stringify(files['.agents/hooks.json']));
  v160['agent-flow'].PreToolUse[0].hooks[0].command = 'node ../.agent-kit/kit.mjs hook antigravity';
  const old160 = check(v160, null);
  assert.match(texts(old160, 'warn'), /formato da 1\.6\.0.*antigravity-config/);
  assert.equal(texts(old160, 'block'), '');
  // Sem .agent-kit/kit.mjs o hook não tem o que chamar.
  rmSync(path.join(project, '.agent-kit', 'kit.mjs'));
  assert.match(texts(check(files['.agents/hooks.json']), 'block'), /\.agent-kit\/kit\.mjs não existe/);
});

test('Hermes: perfil com o trecho velho é acusado; só perfis deste projeto são conferidos (#88)', () => {
  const p = root.replaceAll('\\', '/');
  const expected = { skills: { external_dirs: [p + '/.agents/skills'] },
    mcp_servers: { 'concord-kit': { command: 'node', args: [p + '/.agent-kit/concord-mcp.mjs'] } },
    hooks: { pre_tool_call: [{ matcher: 'write_file|patch', command: "'node' '" + p + "/.agent-kit/kit.mjs' 'hook' 'hermes'", timeout: 5, fail_closed: true }] } };
  const yaml = (dir, matcher, closed = 'fail_closed: true') => ['skills:', '  external_dirs: [' + dir + '/.agents/skills]', 'mcp_servers:', '  concord-kit:',
    '    args: [' + dir + '/.agent-kit/concord-mcp.mjs]', 'hooks:', '  pre_tool_call:', '  - matcher: ' + matcher,
    "    command: 'node' '" + dir + "/.agent-kit/kit.mjs' 'hook' 'hermes'", '    ' + closed].join('\n');
  const check = (files) => diagnose({ root, catalog: models, adapters: '', client: 'hermes', hermesConfig: expected, binaries: { hermes: true },
    home: bare('', files) });
  assert.match(texts(check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file') }), 'block'), /Hermes \(perfil meu\).*matcher write_file\|patch/);
  assert.match(texts(check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file|patch') }), 'ok'), /Hermes \(perfil meu\): trecho do kit confere/);
  assert.match(texts(check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file|patch', '"fail_closed": yes') }), 'ok'), /perfil meu\): trecho do kit confere/);
  assert.match(texts(check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file|patch', 'fail_closed: false') }), 'block'), /fail_closed/);
  // Dois perfis: o de outro projeto, mesmo com trecho diferente, não bloqueia.
  const two = check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file|patch'), '.hermes/profiles/outro/config.yaml': yaml('/outro/projeto', 'write_file') });
  assert.equal(texts(two, 'block'), '');
  assert.match(texts(two, 'ok'), /Hermes \(perfil outro\): perfil de outro projeto/);
  assert.match(texts(check({ '.hermes/profiles/outro/config.yaml': yaml('/outro/projeto', 'write_file') }), 'warn'), /nenhum perfil com o trecho do kit deste projeto/);
  // Pasta irmã com o mesmo prefixo (app e app-outro) é de outro projeto.
  const sibling = check({ '.hermes/profiles/meu/config.yaml': yaml(p, 'write_file|patch'), '.hermes/profiles/irmao/config.yaml': yaml(p + '-outro', 'write_file') });
  assert.equal(texts(sibling, 'block'), '');
  assert.match(texts(sibling, 'ok'), /Hermes \(perfil irmao\): perfil de outro projeto/);
  assert.match(texts(check({ '.hermes/config.yaml': 'model: x' }), 'warn'), /Hermes: nenhum perfil com o trecho do kit/);
});

test('agy no PATH sem arquivos do Antigravity no projeto não bloqueia, a menos que o cliente pedido seja o Antigravity (#88)', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'kit-doctor-agy-sem-'));
  const base = { root: project, home: home({ healthy: true }), catalog: models, adapters: '', binaries: { agy: true } };
  const padrao = diagnose(base);
  assert.doesNotMatch(texts(padrao, 'block'), /Antigravity/);
  assert.match(texts(padrao, 'warn'), /Antigravity: \.agents\/hooks\.json não existe/);
  assert.match(texts(diagnose({ ...base, client: 'antigravity' }), 'block'), /hooks\.json não existe/);
});

test('sessão do Claude Code em curso é reconhecida pelo ambiente (#88)', () => {
  const base = { root, home: bare('', { '.claude/x': '' }), catalog: models, adapters: '', client: 'claude' };
  assert.match(texts(diagnose(base), 'warn'), /projeto ainda não aberto/);
  const inSession = diagnose({ ...base, claudeSession: true });
  assert.match(texts(inSession, 'ok'), /sessão do Claude Code em curso/);
  assert.doesNotMatch(texts(inSession, 'warn'), /projeto ainda não aberto/);
});

test('a identidade Git ausente é aviso (#93)', () => {
  const base = { root, home: home({ healthy: true }), catalog: models, adapters: '' };
  const missing = diagnose({ ...base, identity: { name: 'Fulano', email: '' } });
  assert.match(texts(missing, 'warn'), /Git: user\.email sem valor; o git commit do kit falha/);
  assert.doesNotMatch(texts(missing, 'warn'), /Git: user\.name/);
  assert.match(texts(diagnose({ ...base, identity: { name: 'Fulano', email: 'f@x.y' } }), 'ok'), /Git: user\.name e user\.email definidos/);
  assert.equal(diagnose(base).some((item) => /^Git:/.test(item.text)), false);
});
