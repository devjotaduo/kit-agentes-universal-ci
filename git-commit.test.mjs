import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// #93: sem identidade o commit falha; o kit explica o que fazer e desfaz o que adicionou ao índice.
test('git commit sem identidade explica a causa e desfaz o índice, preservando o que já estava no stage', (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kit-git-commit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.codex', 'hooks'), { recursive: true });
  cpSync('template/.codex/hooks/git.mjs', path.join(dir, '.codex', 'hooks', 'git.mjs'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'vazio'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
  assert.equal(git('init', '-q').status, 0);
  git('config', 'user.name', '');
  git('config', 'user.email', '');
  for (const file of ['a.txt', 'b.txt', ' previo.txt']) writeFileSync(path.join(dir, file), file);
  assert.equal(git('add', ' previo.txt').status, 0);
  const result = spawnSync(process.execPath, [path.join(dir, '.codex', 'hooks', 'git.mjs'), 'commit', 'feat: mensagem', '--', 'a.txt', 'b.txt', ' previo.txt'],
    { cwd: dir, encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git commit falhou/);
  assert.match(result.stderr, /git config user\.name/);
  assert.match(result.stderr, /índice foi desfeito \(2 arquivo/);
  // Nome com espaço no começo (o -z não pode ser aparado). a.txt e b.txt voltaram a não rastreados; previo.txt, já no stage antes, continua lá.
  assert.equal(git('diff', '--cached', '--name-only', '-z').stdout, ' previo.txt' + String.fromCharCode(0));
});
