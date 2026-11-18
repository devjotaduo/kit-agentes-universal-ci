import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const kit = fileURLToPath(new URL('./template/.agent-kit/kit.mjs', import.meta.url));
const exec = (env, args) => {
  const base = { ...process.env };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CONCORD_AGENT_ID']) delete base[key];
  return spawnSync(process.execPath, [kit, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
};
const route = (env, args = []) => {
  const out = exec(env, [...args, 'route-model', 'light']);
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
};

test('sem --client, o cliente vem do ambiente da sessão', () => {
  assert.equal(route({}).client, 'portable');
  assert.equal(route({ CLAUDE_CODE_SESSION_ID: 's' }).client, 'claude');
});

test('Codex e Claude juntos no ambiente voltam a portable; uma variável do Codex sozinha decide', () => {
  assert.equal(route({ CODEX_THREAD_ID: 't', CLAUDE_CODE_SESSION_ID: 's' }).client, 'portable');
  assert.equal(route({ CODEX_SESSION_ID: 't', CLAUDE_CODE_SESSION_ID: 's' }).client, 'portable');
  // Com só o Codex o route-model usa o catálogo do codex (pode falhar sem o CLI); o `hook` mostra o cliente sem ele.
  for (const env of [{ CODEX_THREAD_ID: 't' }, { CODEX_SESSION_ID: 't' }]) {
    const out = exec(env, ['route-model', 'light']);
    assert.notEqual(JSON.parse(out.stdout || '{"client":"x"}').client, 'portable');
  }
});

test('--client vence o ambiente; a nota de route-model depende do cliente', () => {
  const hermes = route({ CLAUDE_CODE_SESSION_ID: 's' }, ['--client', 'hermes']);
  assert.equal(hermes.client, 'hermes');
  assert.equal(hermes.profile, 'inherit');
  assert.match(hermes.note, /herdado/);
  assert.match(route({}, ['--client', 'claude']).note, /ferramenta Agent/);
  assert.equal(route({}).note, undefined);
});

test('--client sem valor e --agent-id sem id são recusados', () => {
  assert.notEqual(exec({}, ['--client']).status, 0);
  assert.notEqual(exec({}, ['--agent-id', '--client', 'claude', 'route-model', 'light']).status, 0);
  assert.notEqual(exec({}, ['--agent-id']).status, 0);
});

test('--agent-id chega ao filho como CONCORD_AGENT_ID', () => {
  // close-merged recusa sem identidade.
  assert.match(exec({}, ['concord', 'close-merged', '--dry-run']).stderr, /CONCORD_AGENT_ID/);
  assert.doesNotMatch(exec({}, ['--agent-id', 'claude-code:x-r1', 'concord', 'close-merged', '--dry-run']).stderr, /Configure CONCORD_AGENT_ID/);
});
