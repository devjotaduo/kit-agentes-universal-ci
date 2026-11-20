import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTarget, repoFromRemote } from './template/.codex/hooks/issue.mjs';

test('dono do projeto vem do origin em https ou ssh', () => {
  assert.deepEqual(repoFromRemote('https://github.com/devjotaduo/projeto.git\n'), { owner: 'devjotaduo', name: 'projeto', full: 'devjotaduo/projeto' });
  assert.equal(repoFromRemote('git@github.com:devjotaduo/projeto.git').full, 'devjotaduo/projeto');
  assert.equal(repoFromRemote('ssh://git@github.com/devjotaduo/projeto.git').full, 'devjotaduo/projeto');
  for (const fake of ['https://gitlab.com/devjotaduo/projeto.git', 'https://notgithub.com/outro/projeto.git',
    'https://github.com.evil.example/outro/projeto.git', 'https://evil.example/github.com/outro/projeto.git', '']) {
    assert.equal(repoFromRemote(fake), null, fake);
  }
});

test('issue só vai para repositório do mesmo dono, com nome válido', () => {
  const project = repoFromRemote('https://github.com/devjotaduo/atendimento.git');
  assert.equal(checkTarget('devjotaduo/outro-app', project), 'devjotaduo/outro-app');
  assert.equal(checkTarget('DevJotaDuo/outro-app', project), 'DevJotaDuo/outro-app');
  assert.throws(() => checkTarget('outra-org/app', project), /Só repositórios de devjotaduo/);
  for (const bad of ['devjotaduo', '--repo=x/y', 'devjotaduo/a b', 'devjotaduo/../x', 'https://github.com/devjotaduo/x']) {
    assert.throws(() => checkTarget(bad, project), /Repositório inválido/);
  }
  assert.throws(() => checkTarget('devjotaduo/app', null), /não tem origin/);
});

test('kit issue --dry-run monta a issue sem rede e registra a origem do trabalho', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kit-issue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync(process.execPath, [path.resolve('install.mjs'), root], { encoding: 'utf8' }).status, 0);
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/devjotaduo/atendimento.git'], { cwd: root });
  const kit = (...args) => spawnSync(process.execPath, ['.agent-kit/kit.mjs', '--client', 'codex', 'issue', ...args],
    { cwd: root, encoding: 'utf8' });
  const body = 'O endpoint de agenda devolve 500 quando o horário vem sem fuso; o atendimento depende dele.';
  const ok = kit('devjotaduo/agenda', 'bug', 'Agenda falha com horário sem fuso', '--body', body, '--dry-run');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Repositório: devjotaduo\/agenda/);
  assert.match(ok.stdout, /Título: \[falha\] Agenda falha com horário sem fuso/);
  assert.match(ok.stdout, /a partir do trabalho em devjotaduo\/atendimento/);
  assert.match(ok.stdout, /cliente codex/);
  assert.match(kit('outra-org/agenda', 'bug', 'Agenda falha com horário sem fuso', '--body', body, '--dry-run').stderr, /Só repositórios de devjotaduo/);
  const fake = 'ghp_' + 'c'.repeat(36);
  const refused = kit('devjotaduo/agenda', 'bug', 'Agenda falha com horário sem fuso', '--body', body + ' ' + fake, '--dry-run');
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(fake));
});
