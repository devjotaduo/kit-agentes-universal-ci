import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KIT } from './template/.codex/hooks/update.mjs';

const changelog = readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8');
const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map((match) => match[1]);
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
