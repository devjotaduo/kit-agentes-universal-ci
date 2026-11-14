import assert from 'node:assert/strict';
import test from 'node:test';
import { requireProjectWorkspace } from './template/.codex/hooks/concord.mjs';

test('project workspace validation rejects the shared workspace and another project', () => {
  const workspace = 'github.com/example/project-a';
  assert.equal(requireProjectWorkspace(workspace, workspace), workspace);
  for (const shared of ['general', ' General ', '*']) {
    assert.throws(() => requireProjectWorkspace(shared), /proibidos/);
  }
  assert.throws(() => requireProjectWorkspace('github.com/example/project-b', workspace),
    /diferente do projeto/);
});
