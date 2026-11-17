import assert from 'node:assert/strict';
import test from 'node:test';
import { closeMerged, markCurrent } from './template/.codex/hooks/concord.mjs';

test('só o PR mesclado mais recente vira current, e só se a branch remota e a local não andaram depois dele', () => {
  const pulls = () => [{ url: 'a', mergedAt: '2026-11-01T00:00:00Z', headRefOid: 'aaa' },
    { url: 'b', mergedAt: '2026-11-08T00:00:00Z', headRefOid: 'bbb' }, { url: 'c', mergedAt: 'data inválida', headRefOid: 'ccc' }];
  const current = (remote, local) => markCurrent(pulls(), remote, local).map((pr) => pr.current);
  // Branch apagada no remoto e sem cópia local, ou as duas no commit mesclado.
  assert.deepEqual(current('', ''), [undefined, true, undefined]);
  assert.deepEqual(current('bbb', 'bbb'), [undefined, true, undefined]);
  // A branch andou no remoto, ou foi apagada lá e a local tem commits não enviados.
  assert.deepEqual(current('ddd', ''), [undefined, false, undefined]);
  assert.deepEqual(current('', 'ddd'), [undefined, false, undefined]);
  // Apontar para o commit de um PR antigo não conta.
  assert.deepEqual(current('aaa', ''), [undefined, false, undefined]);
  assert.deepEqual(markCurrent([], '', ''), []);
});

const ready = '2026-11-10T00:00:00Z';
const after = '2026-11-12T00:00:00Z';
const tasks = {
  minha: { taskId: 'minha', agentId: 'eu', branch: 'feat/minha', version: 4, updatedAt: ready },
  alheia: { taskId: 'alheia', agentId: 'outro', branch: 'feat/alheia', version: 2, updatedAt: ready },
  aberta: { taskId: 'aberta', agentId: 'eu', branch: 'feat/aberta', version: 1, updatedAt: ready },
  semBranch: { taskId: 'semBranch', agentId: 'eu', branch: null, version: 1, updatedAt: ready },
  // Dois PRs na mesma branch: o antigo é de antes da entrega; só o novo conta.
  reusada: { taskId: 'reusada', agentId: 'eu', branch: 'feat/reusada', version: 1, updatedAt: ready },
  semData: { taskId: 'semData', agentId: 'eu', branch: 'feat/minha', version: 1 },
};
const pulls = {
  'feat/minha': [{ url: 'https://github.com/o/r/pull/1', mergedAt: after }],
  'feat/alheia': [{ url: 'https://github.com/o/r/pull/2', mergedAt: after }],
  'feat/reusada': [{ url: 'https://github.com/o/r/pull/3', mergedAt: '2026-11-01T00:00:00Z' }, { url: 'https://github.com/o/r/pull/4', mergedAt: 'data inválida' }],
};
const merged = (branch) => pulls[branch] ?? [];

function concord({ refuse } = {}) {
  const finished = [];
  const call = async (tool, args) => {
    if (tool === 'finish_work') {
      if (args.task_id === refuse) throw Error('versão desatualizada');
      finished.push(args);
      return { status: 'complete' };
    }
    assert.equal(tool, 'inspect_work');
    return args.task_id ? { task: tasks[args.task_id] }
      : { review_ready: [...Object.keys(tasks).map((taskId) => ({ taskId })), null], active: [{ taskId: 'viva' }] };
  };
  return { call, finished };
}

test('close-merged fecha só a tarefa do próprio agente com PR mesclado depois da entrega', async () => {
  const { call, finished } = concord();
  const result = await closeMerged(call, 'ws', 'eu', merged, false);
  assert.deepEqual(result.map((item) => [item.task, item.action]), [
    ['minha', 'closed'], ['alheia', 'owner'], ['aberta', 'kept'], ['semBranch', 'kept'], ['reusada', 'kept'], ['semData', 'kept'],
  ]);
  assert.equal(result[1].owner, 'outro');
  assert.equal(finished.length, 1);
  const { what_changed: summary, reason, ...sent } = finished[0];
  assert.deepEqual(sent, { workspace_id: 'ws', agent_id: 'eu', task_id: 'minha', expected_version: 4, outcome: 'complete' });
  assert.match(summary, /pull\/1/);
  assert.equal(reason, summary);
});

test('close-merged aceita o PR mesclado antes da última atualização quando a branch não andou depois dele', async () => {
  const before = '2026-11-08T00:00:00Z';
  // Tarefa criada em 05/11, PR mesclado em 08/11, tarefa atualizada (ida a review_ready) em 10/11.
  tasks.tardia = { taskId: 'tardia', agentId: 'eu', branch: 'feat/tardia', version: 3, createdAt: '2026-11-05T00:00:00Z', updatedAt: ready };
  // Mesmo PR, mas a branch andou depois do merge: há trabalho novo, a tarefa fica.
  tasks.andou = { ...tasks.tardia, taskId: 'andou', branch: 'feat/andou' };
  // Tarefa nascida depois do merge: o PR é de outro trabalho na mesma branch.
  tasks.nova = { ...tasks.tardia, taskId: 'nova', createdAt: '2026-11-09T00:00:00Z' };
  tasks.deOutro = { ...tasks.tardia, taskId: 'deOutro', agentId: 'outro', expectedFiles: ['CLAUDE.md'] };
  pulls['feat/tardia'] = [{ url: 'https://github.com/o/r/pull/5', mergedAt: before, current: true }];
  pulls['feat/andou'] = [{ url: 'https://github.com/o/r/pull/6', mergedAt: before, current: false }];
  try {
    const { call, finished } = concord();
    const result = await closeMerged(call, 'ws', 'eu', merged, false);
    const by = Object.fromEntries(result.map((item) => [item.task, item]));
    assert.deepEqual(['tardia', 'andou', 'nova', 'deOutro'].map((id) => by[id].action), ['closed', 'kept', 'kept', 'owner']);
    // A tarefa de outro dono sai com a presença e os arquivos que retém, para o usuário decidir.
    assert.deepEqual([by.deOutro.present, by.deOutro.files], [false, ['CLAUDE.md']]);
    assert.ok(finished.some((item) => item.task_id === 'tardia'));
  } finally {
    for (const id of ['tardia', 'andou', 'nova', 'deOutro']) delete tasks[id];
    delete pulls['feat/tardia']; delete pulls['feat/andou'];
  }
});

test('close-merged --dry-run mostra o que fecharia sem alterar o Concord', async () => {
  const { call, finished } = concord();
  const result = await closeMerged(call, 'ws', 'eu', merged, true);
  assert.equal(result[0].action, 'would-close');
  assert.equal(finished.length, 0);
});

test('close-merged não fecha nada quando o GitHub falha, mesmo que a falha venha depois da primeira tarefa', async () => {
  const { call, finished } = concord();
  const failing = (branch) => { if (branch === 'feat/aberta') throw Error('gh falhou'); return merged(branch); };
  await assert.rejects(closeMerged(call, 'ws', 'eu', failing, false), /gh falhou/);
  assert.equal(finished.length, 0);
});

test('close-merged registra a recusa de uma tarefa e segue com as demais', async () => {
  tasks.segunda = { taskId: 'segunda', agentId: 'eu', branch: 'feat/alheia', version: 7, updatedAt: ready };
  try {
    const { call, finished } = concord({ refuse: 'minha' });
    const result = await closeMerged(call, 'ws', 'eu', merged, false);
    assert.deepEqual(result.filter((item) => ['error', 'closed'].includes(item.action)).map((item) => [item.task, item.action]),
      [['minha', 'error'], ['segunda', 'closed']]);
    assert.match(result[0].reason, /versão desatualizada/);
    assert.deepEqual(finished.map((item) => item.task_id), ['segunda']);
  } finally { delete tasks.segunda; }
});
