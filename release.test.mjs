import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KIT } from './template/.codex/hooks/update.mjs';
import { publishRelease } from './scripts/publish-release.mjs';

const changelog = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8');
const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\r?$/gm)].map((match) => match[1]);
const number = (version) => version.split('.').map(Number).reduce((total, part) => total * 1000 + part, 0);

test('a versão do kit tem entrada no CHANGELOG e é a mais nova dele', () => {
  assert.match(KIT.version, /^\d+\.\d+\.\d+$/);
  assert.ok(versions.includes(KIT.version), 'CHANGELOG.md sem a entrada "## [' + KIT.version + '] - AAAA-MM-DD"');
  assert.equal(versions[0], KIT.version, 'a primeira versão do CHANGELOG.md deve ser a de KIT.version');
});

test('as versões do CHANGELOG estão em ordem, sem repetição', () => {
  assert.equal(new Set(versions).size, versions.length);
  for (let index = 1; index < versions.length; index += 1) {
    assert.ok(number(versions[index - 1]) > number(versions[index]), versions[index - 1] + ' vem antes de ' + versions[index]);
  }
});

const tag = `v${KIT.version}`;
const ref = `refs/tags/${tag}`;
const tagObject = 'c'.repeat(40);
const plan = { version: KIT.version, commit: 'a'.repeat(40), pr: '110', reviewed: 'b'.repeat(40), visibility: 'private' };
const url = `https://github.com/${KIT.repository}/releases/tag/${tag}`;

function github() {
  const state = { pushes: 0, creates: 0, ci: 'success' };
  const ok = (stdout = '') => ({ status: 0, stdout });
  const json = (value) => ok(JSON.stringify(value));
  const run = (command, args, options) => {
    if (command === 'git') {
      if (args[0] === 'ls-remote') return ok(state.remote ? `${tagObject}\t${ref}\n${state.remote}\t${ref}^{}\n` : '');
      if (args[0] === 'show') {
        assert.deepEqual(args, ['show', `${plan.commit}:CHANGELOG.md`]);
        return ok(`## [${plan.version}] - 2026-11-20\n\n- Nova entrega.\n\n## [1.0.0] - 2026-11-19\n\n- Antiga.\n`);
      }
      if (args[0] === 'tag' && args[1] === '--list') return ok(state.local ? tag : '');
      if (args[0] === 'tag') {
        assert.deepEqual(args.slice(1, 4), ['-a', tag, plan.commit]);
        state.local = plan.commit;
        return ok();
      }
      if (args[0] === 'cat-file') return ok('tag');
      if (args[0] === 'rev-parse') return ok(args[1] === '--verify' ? tagObject : state.local);
      if (args[0] === 'push') {
        assert.deepEqual(args, ['push', `https://github.com/${KIT.repository}.git`, `${tagObject}:${ref}`]);
        state.pushes++;
        state.remote = state.local;
        return ok();
      }
    }
    if (command === 'gh' && args[0] === 'api') {
      const endpoint = args.at(-1).slice(`repos/${KIT.repository}`.length);
      if (!endpoint) return json({ visibility: 'private' });
      if (endpoint === `/pulls/${plan.pr}`) return json({ merged: true, base: { ref: KIT.branch },
        head: { sha: plan.reviewed }, merge_commit_sha: plan.commit });
      if (endpoint === `/git/ref/heads/${KIT.branch}`) return json({ object: { sha: plan.commit } });
      if (endpoint === `/commits/${plan.reviewed}/status`) return json({ statuses: [{ context: 'ci-publico', state: state.ci }] });
      if (endpoint === `/releases/tags/${tag}`) {
        if (state.lookupError) return { status: 1, stdout: 'HTTP/2.0 503 Service Unavailable', stderr: 'Serviço indisponível' };
        if (!state.release) return { status: 1, stdout: 'HTTP/2.0 404 Not Found' };
        return ok(`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(state.release)}`);
      }
    }
    if (command === 'gh' && args[0] === 'release') {
      assert.deepEqual(args, ['release', 'create', tag, '--repo', `github.com/${KIT.repository}`, '--verify-tag', '--latest',
        '--title', plan.version, '--notes-file', '-']);
      assert.equal(options.input, '- Nova entrega.\n');
      state.creates++;
      if (state.interrupted) return { status: 1, stderr: 'Publicação interrompida' };
      state.release = { html_url: url, tag_name: tag, draft: false, prerelease: false };
      return ok(url);
    }
    assert.fail(`Comando inesperado ${command} ${args.join(' ')}`);
  };
  return { state, publish: (accepted = plan) => publishRelease(accepted, run) };
}

test('publicação retoma pela tag anotada após falha e reaproveita a release já concluída', () => {
  const { state, publish } = github();
  state.interrupted = true;
  assert.throws(() => publish(), /Publicação interrompida/);
  assert.equal(state.remote, plan.commit);
  assert.equal(state.pushes, 1);
  state.interrupted = false;
  assert.equal(publish(), url);
  assert.equal(publish(), url);
  assert.equal(state.pushes, 1);
  assert.equal(state.creates, 2);
});

test('publicação para antes de escrever se a tag existente aponta para outro commit', () => {
  const { state, publish } = github();
  state.remote = 'd'.repeat(40);
  assert.throws(() => publish(), /tag remota.*apontar para/);
  assert.equal(state.pushes + state.creates, 0);
  delete state.remote;
  state.local = 'd'.repeat(40);
  assert.throws(() => publish(), /tag local.*apontar para/);
  assert.equal(state.pushes + state.creates, 0);
});

test('publicação exige a visibilidade autorizada, o CI da revisão e uma resposta conclusiva do GitHub', () => {
  const { state, publish } = github();
  assert.throws(() => publish({ ...plan, visibility: 'public' }), /visibilidade.*diverge/);
  assert.throws(() => publish({ ...plan, reviewed: 'f'.repeat(40) }), /PR #110 precisa ligar/);
  state.ci = 'pending';
  assert.throws(() => publish(), /status ci-publico aprovado/);
  state.ci = 'success';
  state.lookupError = true;
  assert.throws(() => publish(), /Serviço indisponível/);
  assert.equal(state.local, undefined);
  assert.equal(state.pushes + state.creates, 0);
});
