// Confere as regras de comando que o kit distribui para o Codex (.codex/rules/kit.rules).
// O Codex casa prefixos de argumentos e a regra mais restritiva vence; o avaliador abaixo reproduz isso para não
// depender do binário do Codex no CI. O formato foi conferido com `codex execpolicy check` 0.167.1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));
const source = readFileSync(fileURLToPath(new URL('./template/.codex/rules/kit.rules', import.meta.url)), 'utf8');
const severity = { allow: 0, prompt: 1, forbidden: 2 };

function parse(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^prefix_rule\(pattern = (\[.*\]), decision = "(allow|prompt|forbidden)"\)$/);
    assert.ok(match, 'linha fora do formato: ' + line);
    const pattern = JSON.parse(match[1]);
    assert.ok(pattern.length >= 2 && pattern.every((token) => typeof token === 'string' && token), 'padrão inválido: ' + line);
    rules.push({ pattern, decision: match[2] });
  }
  return rules;
}

const rules = parse(source);

function decide(command) {
  const tokens = command.split(' ');
  const hits = rules.filter(({ pattern }) => pattern.every((token, index) => tokens[index] === token));
  return hits.reduce((worst, { decision }) => (worst && severity[worst] >= severity[decision] ? worst : decision), null);
}

test('as regras do Codex liberam as leituras do kit e bloqueiam o que o Claude Code bloqueia', () => {
  for (const command of ['gh pr view 12', 'gh pr checks 12', 'gh issue list', 'git status --short', 'git rev-parse HEAD',
    'git worktree list', 'git branch --show-current', 'node .agent-kit/kit.mjs flow status', 'node --test',
    'concord status', 'concord who']) {
    assert.equal(decide(command), 'allow', command);
  }
  for (const command of ['git push --force origin main', 'git push -f', 'git reset --hard HEAD', 'git clean -fd',
    'git branch -D velha', 'git checkout -- arquivo', 'rm -rf pasta', 'gh repo delete o/r', 'gh repo create o/r',
    'npx skills add x', 'npm install -g pacote']) {
    assert.equal(decide(command), 'forbidden', command);
  }
});

test('nenhuma liberação do Codex fica mais larga que a do Claude Code', () => {
  // Prefixos que liberariam escrita: apagar branch, buscar com refspec, escrever com --output, git em geral.
  for (const command of ['git branch -d velha', 'git branch nova', 'git fetch origin main:main', 'git diff --output=x',
    'git log --output=x', 'git push origin main', 'git commit -m x', 'gh pr merge 12', 'gh api -X DELETE repos/o/r']) {
    assert.notEqual(decide(command), 'allow', command);
  }
  for (const { pattern } of rules.filter((rule) => rule.decision === 'allow')) {
    const larga = pattern[0] === 'git' && pattern.length === 2 && ['branch', 'fetch', 'diff', 'log', 'show'].includes(pattern[1]);
    assert.ok(!larga, 'liberação larga demais: ' + pattern.join(' '));
  }
});

test('o projeto instalado recebe as regras do Codex', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-codex-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const done = spawnSync(process.execPath, [install, dir], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(path.join(dir, '.codex/rules/kit.rules'), 'utf8'), source);
});
