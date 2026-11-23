import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ARGS, asset, binary, install, launcher, startEnv } from './template/.codex/hooks/github-mcp.mjs';

const tempHome = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-github-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('cada plataforma suportada tem pacote com sha256 fixado', () => {
  assert.equal(asset('win32', 'x64').file, 'github-mcp-server_Windows_x86_64.zip');
  assert.equal(asset('linux', 'arm64').file, 'github-mcp-server_Linux_arm64.tar.gz');
  assert.equal(asset('darwin', 'x64').file, 'github-mcp-server_Darwin_x86_64.tar.gz');
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
    assert.match(asset(platform, arch).sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => asset('darwin', 'ia32'), /Sem binário/);
  assert.throws(() => asset('freebsd', 'x64'), /Sem binário/);
});

test('download com checksum diferente não instala nada', async (t) => {
  const base = tempHome(t);
  await assert.rejects(install({ base, download: async () => Buffer.from('pacote adulterado') }), /checksum/);
  assert.equal(existsSync(binary(base)), false);
  assert.equal(existsSync(launcher(base)), false);
});

test('com o binário já instalado não baixa e só atualiza o lançador', async (t) => {
  const base = tempHome(t);
  mkdirSync(path.dirname(binary(base)), { recursive: true });
  writeFileSync(binary(base), 'binário');
  await install({ base, download: async () => assert.fail('não deveria baixar') });
  assert.match(readFileSync(launcher(base), 'utf8'), /--read-only/);
});

test('o ambiente não amplia as ferramentas nem tira o modo só leitura', () => {
  const env = startEnv({ PATH: 'x', GITHUB_TOOLSETS: 'all', GITHUB_TOOLS: 'merge_pull_request', GITHUB_READ_ONLY: '0' }, 'tok');
  assert.equal(env.GITHUB_TOOLSETS, undefined);
  assert.equal(env.GITHUB_TOOLS, undefined);
  assert.equal(env.GITHUB_READ_ONLY, '1');
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, 'tok');
  assert.equal(env.PATH, 'x');
  assert.equal(startEnv({ GITHUB_HOST: 'https://outro.example', github_api_url: 'x' }, 'tok').GITHUB_HOST, undefined);
  assert.equal(startEnv({ github_api_url: 'x' }, 'tok').github_api_url, undefined);
  assert.deepEqual(ARGS, ['stdio', '--read-only', '--toolsets', 'default,actions']);
});

test('o template cadastra o github-kit no Claude Code e libera só as ferramentas dele', () => {
  const mcp = JSON.parse(readFileSync('template/.mcp.json', 'utf8')).mcpServers['github-kit'];
  assert.deepEqual(mcp.args, ['.codex/hooks/github-mcp.mjs', 'start']);
  const allow = JSON.parse(readFileSync('template/.claude/settings.json', 'utf8')).permissions.allow;
  assert.ok(allow.includes('mcp__github-kit__*'));
});
