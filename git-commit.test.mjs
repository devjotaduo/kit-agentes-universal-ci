import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// #93: sem identidade o commit falha; o kit explica o que fazer e desfaz o que adicionou ao índice.
test('git commit sem identidade explica a causa e desfaz o índice, preservando o que já estava no stage', (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kit-git-commit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync('template/.codex/hooks', path.join(dir, '.codex', 'hooks'), { recursive: true });
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

test('git commit leva remoções preparadas e avulsas sem levar outras alterações do índice', (t) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kit-git-remocoes-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installation = spawnSync(process.execPath, ['install.mjs', dir], { encoding: 'utf8' });
  assert.equal(installation.status, 0, installation.stderr);
  const ok = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const git = (...args) => ok(spawnSync('git', args, { cwd: dir, encoding: 'utf8' }));
  const env = { ...process.env };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const commit = (...paths) => spawnSync(process.execPath, ['.agent-kit/kit.mjs', 'git', 'commit', 'fix: remove arquivos', '--', ...paths],
    { cwd: dir, encoding: 'utf8', env });
  git('init', '-q');
  git('config', 'user.name', 'Teste Agent Kit');
  git('config', 'user.email', 'kit@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(dir, 'pasta'));
  for (const file of [' preparado.txt', 'pasta/a.txt', 'pasta/b.txt', 'manter.txt']) writeFileSync(path.join(dir, file), file);
  git('add', '--', ' preparado.txt', 'pasta/a.txt', 'pasta/b.txt', 'manter.txt');
  git('commit', '-qm', 'base');

  git('rm', '--', ' preparado.txt');
  unlinkSync(path.join(dir, 'pasta/a.txt'));
  unlinkSync(path.join(dir, 'pasta/b.txt'));
  rmdirSync(path.join(dir, 'pasta'));
  writeFileSync(path.join(dir, 'manter.txt'), 'alteração separada');
  git('add', '--', 'manter.txt');

  ok(commit(' preparado.txt', 'pasta/a.txt'));
  assert.equal(git('diff-tree', '--no-commit-id', '-r', '--name-status', '-z', 'HEAD'), 'D\0 preparado.txt\0D\0pasta/a.txt\0');
  assert.equal(git('diff', '--cached', '--name-only', '-z'), 'manter.txt\0');

  for (const invalid of ['pasta', 'nunca-existiu.txt']) {
    const result = commit(invalid);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Arquivo não existe/);
  }
  assert.equal(git('diff', '--name-only', '-z'), 'pasta/b.txt\0');
  assert.equal(git('diff', '--cached', '--name-only', '-z'), 'manter.txt\0');

  mkdirSync(path.join(dir, 'pasta'));
  writeFileSync(path.join(dir, 'pasta/b.txt'), 'modificação no índice');
  git('add', '--', 'pasta/b.txt');
  unlinkSync(path.join(dir, 'pasta/b.txt'));
  git('config', 'user.name', '');
  git('config', 'user.email', '');
  const cached = git('diff', '--cached', '--binary');
  const failed = commit('pasta/b.txt');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /git config user\.name/);
  assert.equal(git('diff', '--cached', '--binary'), cached);
});
