import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('.', import.meta.url));

function fixture(t) {
  const temp = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(temp, 'agent-flow-install-'));
  t.after(() => {
    const actual = realpathSync(root);
    assert.equal(path.dirname(actual), temp);
    assert.match(path.basename(actual), /^agent-flow-install-/);
    rmSync(actual, { recursive: true, force: true });
  });
  const kit = path.join(root, 'kit');
  const dest = path.join(root, 'dest');
  mkdirSync(kit);
  mkdirSync(dest);
  copyFileSync(path.join(source, 'install.mjs'), path.join(kit, 'install.mjs'));
  const sourceTemplate = path.join(source, 'template');
  const template = path.join(kit, 'template');
  cpSync(sourceTemplate, template, {
    recursive: true,
    filter: (file) => {
      const [folder, name] = path.relative(sourceTemplate, file).split(path.sep);
      return folder !== '.agent-flow' || !name || name === '.gitignore';
    },
  });
  const install = (flags = [], nodeFlags = []) => spawnSync(process.execPath,
    [...nodeFlags, path.join(kit, 'install.mjs'), ...flags, dest], { cwd: kit, encoding: 'utf8' });
  const read = (file) => readFileSync(path.join(dest, file), 'utf8');
  return { kit, dest, template, install, read };
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function update(template, file, suffix) {
  const abs = path.join(template, file);
  writeFileSync(abs, readFileSync(abs, 'utf8') + '\n' + suffix + '\n');
}

test('instalação e simulação ignoram estado ativo, histórico e arquivos fora da distribuição', (t) => {
  const { dest, template, install } = fixture(t);
  mkdirSync(path.join(template, '.agent-flow', 'live', 'pedido'), { recursive: true });
  writeFileSync(path.join(template, '.agent-flow', 'active.json'), '{"synthetic":true}');
  writeFileSync(path.join(template, '.agent-flow', 'live', 'pedido', 'private.txt'), 'histórico sintético');
  writeFileSync(path.join(template, '.env'), 'estado sintético');
  writeFileSync(path.join(template, 'docs', 'private.md'), 'evidência sintética');
  writeFileSync(path.join(template, '.agents', 'skills', 'tdd', '.env'), 'estado sintético de skill');
  assert.doesNotMatch(ok(install(['--dry-run'])), /active\.json|private|\.env/);
  assert.equal(existsSync(path.join(dest, '.agent-flow')), false);
  ok(install());
  assert.equal(existsSync(path.join(dest, '.agent-flow', 'active.json')), false);
  assert.equal(existsSync(path.join(dest, '.agent-flow', 'live')), false);
  assert.equal(existsSync(path.join(dest, 'docs', 'private.md')), false);
  assert.equal(existsSync(path.join(dest, '.env')), false);
  assert.equal(existsSync(path.join(dest, '.agents', 'skills', 'tdd', '.env')), false);
  ok(spawnSync(process.execPath, [path.join(dest, '.codex', 'hooks', 'flow.mjs'),
    'new', 'maintenance', 'Primeiro pedido'], { cwd: dest, encoding: 'utf8' }));
});

test('instalação idempotente e upgrade preservam estado e detectam conflitos antes de escrever', (t) => {
  const { dest, template, install, read } = fixture(t);
  ok(install());
  assert.match(ok(install()), /Sem alterações/);
  writeFileSync(path.join(dest, '.agent-flow', 'active.json'), 'estado local');
  writeFileSync(path.join(dest, 'AGENTS.md'), 'orientação local');
  const oldDoc = read('docs/agent-flow.md');
  update(template, 'docs/agent-flow.md', 'guia atualizado');
  writeFileSync(path.join(template, '.codex/hooks/new-check.mjs'), '// novo');
  const conflict = install(['--dry-run']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /Atualizar: docs\/agent-flow\.md/);
  assert.match(conflict.stdout, /Adicionar: \.codex\/hooks\/new-check\.mjs/);
  assert.match(conflict.stderr, /AGENTS\.md/);
  assert.equal(install().status, 1);
  assert.equal(read('AGENTS.md'), 'orientação local');
  assert.equal(read('docs/agent-flow.md'), oldDoc);
  assert.equal(existsSync(path.join(dest, '.codex/hooks/new-check.mjs')), false);
  assert.equal(read('.agent-flow/active.json'), 'estado local');
  assert.equal(existsSync(path.join(dest, '.agent-flow/install-transaction')), false);
});

test('arquivos idênticos de instalações anteriores são adotados sem sobrescrita', (t) => {
  const { template, dest, install, read } = fixture(t);
  copyFileSync(path.join(template, 'AGENTS.md'), path.join(dest, 'AGENTS.md'));
  writeFileSync(path.join(template, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(path.join(dest, 'CLAUDE.md'), '@AGENTS.md\r\n');
  assert.match(ok(install(['--dry-run'])), /Adotar: AGENTS\.md/);
  assert.equal(existsSync(path.join(dest, '.agent-flow/install-manifest.json')), false);
  ok(install());
  assert.equal(read('CLAUDE.md'), '@AGENTS.md\r\n');
  update(template, 'AGENTS.md', 'versão atualizada');
  assert.match(ok(install()), /Atualizar: AGENTS\.md/);
  assert.match(read('AGENTS.md'), /versão atualizada/);
});

test('instruções existentes são mescladas sem duplicar e atualizadas mesmo sem manifesto', (t) => {
  const { template, dest, install, read } = fixture(t);
  const agents = '\uFEFF# Projeto existente\r\n\r\nInstruções locais.\r\n';
  const claude = '# Regras do Claude\nPrefira comandos do projeto.\n';
  writeFileSync(path.join(dest, 'AGENTS.md'), agents);
  writeFileSync(path.join(dest, 'CLAUDE.md'), claude);
  const dryRun = ok(install(['--dry-run']));
  assert.match(dryRun, /Mesclar: AGENTS\.md/);
  assert.match(dryRun, /Mesclar: CLAUDE\.md/);
  assert.equal(read('AGENTS.md'), agents);
  assert.equal(read('CLAUDE.md'), claude);
  assert.equal(existsSync(path.join(dest, '.agent-flow')), false);

  ok(install());
  const first = read('AGENTS.md');
  assert.ok(first.startsWith(agents));
  assert.match(first, /\r\n<!-- agent-kit:instructions-begin [^\r\n]+\r\n# Trabalho com agentes\r\n/);
  assert.doesNotMatch(first.replaceAll('\r\n', ''), /\n/);
  const installedClaude = read('CLAUDE.md');
  assert.ok(installedClaude.startsWith(claude));
  assert.match(installedClaude, /^@AGENTS\.md$/m);
  assert.match(ok(install()), /Sem alterações/);

  const addition = '\r\nOutra orientação local.\r\n';
  writeFileSync(path.join(dest, 'AGENTS.md'), first + addition);
  unlinkSync(path.join(dest, '.agent-flow/install-manifest.json'));
  update(template, 'AGENTS.md', 'Regra nova do Kit.');
  assert.match(ok(install()), /Mesclar: AGENTS\.md/);
  const updated = read('AGENTS.md');
  assert.ok(updated.startsWith(agents));
  assert.ok(updated.endsWith(addition));
  assert.match(updated, /Regra nova do Kit\./);
  assert.equal(updated.match(/agent-kit:instructions-begin/g).length, 1);
  assert.equal(read('CLAUDE.md'), installedClaude);
  assert.match(ok(install()), /Sem alterações/);
});

test('importação existente do AGENTS.md é preservada sem inserir uma segunda', (t) => {
  const { dest, install, read } = fixture(t);
  const claude = '# Instruções locais\n\n@./AGENTS.md\n';
  writeFileSync(path.join(dest, 'CLAUDE.md'), claude);
  ok(install());
  assert.equal(read('CLAUDE.md'), claude);
});

test('bloco do Kit alterado ou incompleto impede qualquer escrita', (t) => {
  const { template, dest, install, read } = fixture(t);
  const agents = path.join(dest, 'AGENTS.md');
  writeFileSync(agents, '# Projeto existente\n');
  ok(install());
  const first = read('AGENTS.md');
  const oldDoc = read('docs/agent-flow.md');
  update(template, 'docs/agent-flow.md', 'Nova documentação.');
  for (const edited of [
    first.replace('# Trabalho com agentes', '# Bloco editado à mão'),
    first.replace('<!-- agent-kit:instructions-end -->', ''),
  ]) {
    writeFileSync(agents, edited);
    const conflict = install();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /AGENTS\.md.*bloco do Kit/);
    assert.equal(read('AGENTS.md'), edited);
    assert.equal(read('docs/agent-flow.md'), oldDoc);
    assert.equal(existsSync(path.join(dest, '.agent-flow/install-transaction')), false);
  }
});

function interruptUpgrade(fixtureState) {
  const { kit, dest, template, install, read } = fixtureState;
  ok(install());
  const original = [read('AGENTS.md'), read('docs/agent-flow.md'), read('.agent-flow/install-manifest.json')];
  writeFileSync(path.join(dest, '.agent-flow', 'active.json'), 'pedido em andamento');
  update(template, 'AGENTS.md', 'nova orientação');
  update(template, 'docs/agent-flow.md', 'novo fluxo');
  const injection = path.join(kit, 'interrupt.mjs');
  writeFileSync(injection, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const original = fs.renameSync;',
    "fs.renameSync = (from, to) => { if (path.basename(to) === 'agent-flow.md') process.exit(77); original(from, to); };",
    'syncBuiltinESMExports();',
  ].join('\n'));
  const interrupted = install([], ['--import', pathToFileURL(injection).href]);
  assert.equal(interrupted.status, 77, interrupted.stderr);
  assert.match(read('AGENTS.md'), /nova orientação/);
  assert.equal(read('docs/agent-flow.md'), original[1]);
  assert.equal(read('.agent-flow/install-manifest.json'), original[2]);
  assert.equal(existsSync(path.join(dest, '.agent-flow/install-transaction')), true);
  return original;
}

test('upgrade interrompido retoma exatamente a transação persistida', (t) => {
  const f = fixture(t);
  interruptUpgrade(f);
  update(f.template, 'docs/agent-flow.md', 'versão posterior à transação');
  assert.match(ok(f.install(['--dry-run'])), /Retomar/);
  assert.match(ok(f.install()), /pendente concluída/);
  assert.match(f.read('docs/agent-flow.md'), /novo fluxo/);
  assert.doesNotMatch(f.read('docs/agent-flow.md'), /versão posterior/);
  assert.equal(f.read('.agent-flow/active.json'), 'pedido em andamento');
  assert.equal(existsSync(path.join(f.dest, '.agent-flow/install-transaction')), false);
});

test('rollback de upgrade interrompido restaura conteúdo e manifesto sem perder trabalho ativo', (t) => {
  const f = fixture(t);
  const original = interruptUpgrade(f);
  assert.match(ok(f.install(['--rollback', '--dry-run'])), /Reverter/);
  assert.match(f.read('AGENTS.md'), /nova orientação/);
  assert.match(ok(f.install(['--rollback'])), /pendente revertida/);
  assert.equal(f.read('AGENTS.md'), original[0]);
  assert.equal(f.read('docs/agent-flow.md'), original[1]);
  assert.equal(f.read('.agent-flow/install-manifest.json'), original[2]);
  assert.equal(f.read('.agent-flow/active.json'), 'pedido em andamento');
});

test('retomada recusa sobrescrever edição local feita depois da interrupção', (t) => {
  const f = fixture(t);
  const original = interruptUpgrade(f);
  writeFileSync(path.join(f.dest, 'AGENTS.md'), 'edição após interrupção');
  const resumed = f.install();
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /Arquivos alterados desde a transação/);
  assert.equal(f.read('AGENTS.md'), 'edição após interrupção');
  assert.equal(f.read('docs/agent-flow.md'), original[1]);
});

test('upgrade interrompido ao esvaziar o arquivo de modelos aposentado é retomado ou revertido', (t) => {
  const old = '{"light":{"model":"fixo","effort":"low"}}';
  for (const flags of [[], ['--rollback']]) {
    const f = fixture(t);
    ok(f.install());
    const manifestFile = path.join(f.dest, '.agent-flow', 'install-manifest.json');
    const data = JSON.parse(readFileSync(manifestFile, 'utf8'));
    data.files['.codex/model-routing.json'] = createHash('sha256').update(old).digest('hex');
    writeFileSync(manifestFile, JSON.stringify(data, null, 2) + '\n');
    writeFileSync(path.join(f.dest, '.codex', 'model-routing.json'), old);
    const injection = path.join(f.kit, 'interrupt.mjs');
    writeFileSync(injection, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const original = fs.renameSync;',
      "fs.renameSync = (from, to) => { if (path.basename(to) === 'model-routing.json') process.exit(77); original(from, to); };",
      'syncBuiltinESMExports();',
    ].join('\n'));
    assert.equal(f.install([], ['--import', pathToFileURL(injection).href]).status, 77);
    assert.equal(existsSync(path.join(f.dest, '.agent-flow/install-transaction')), true);
    ok(f.install(flags));
    assert.equal(existsSync(path.join(f.dest, '.agent-flow/install-transaction')), false);
    const rolledBack = flags.length > 0;
    assert.equal(f.read('.codex/model-routing.json'), rolledBack ? old : '{}\n');
    assert.equal('.codex/model-routing.json' in JSON.parse(f.read('.agent-flow/install-manifest.json')).files, rolledBack);
  }
});
