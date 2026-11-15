import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkDestinations, defaultTrusted, difference, listedSkills, snapshot, trustedOwners, uniqueSkill, validateAdd, validateTerms,
} from './template/.codex/hooks/skills.mjs';
import { checkBranch, checkCommit } from './template/.codex/hooks/git.mjs';

const temp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('instalação de skill aceita fonte confiável, exige aceite para as outras e recusa argumento perigoso', () => {
  assert.equal(validateAdd('vercel-labs/agent-skills', 'react-best-practices', defaultTrusted).trusted, true);
  assert.throws(() => validateAdd('desconhecido/skills', 'util', defaultTrusted), /fonte-aprovada/);
  assert.equal(validateAdd('desconhecido/skills', 'util', defaultTrusted, 'Usuário aceitou no chat').trusted, false);
  assert.throws(() => validateAdd('desconhecido/skills', 'util', defaultTrusted, 'ok'), /fonte-aprovada/);
  for (const pkg of ['vercel-labs/agent-skills; calc', '../x', 'https://exemplo.com/a', 'vercel-labs', '-g/x']) {
    assert.throws(() => validateAdd(pkg, 'util', defaultTrusted), /Pacote inválido/);
  }
  for (const skill of ['*', 'Util', 'a b', 'x;y', '--global']) {
    assert.throws(() => validateAdd('vercel-labs/agent-skills', skill, defaultTrusted), /Skill inválida/);
  }
});

test('busca aceita palavras simples e recusa shell e opções da CLI', () => {
  assert.deepEqual(validateTerms(['react', 'performance']), ['react', 'performance']);
  assert.deepEqual(validateTerms(['revisão de PR']), ['revisão', 'de', 'PR']);
  for (const bad of [['a'], ['x && y'], ['$(id)'], ['a|b'], ['x'.repeat(81)], ['--owner', 'x'], ['react', '-g']]) {
    assert.throws(() => validateTerms(bad), /Termos/);
  }
});

test('instala só quando o repositório tem exatamente uma skill com aquele nome', () => {
  const listing = '◇  Available skills\n│\n│    review-code\n│\n│      Revisa código.\n│\n│    Review_Code\n│\n│      Outra.\n│\n│    tdd\n│\n└  Use --skill';
  assert.deepEqual(listedSkills(listing), ['review-code', 'Review_Code', 'tdd']);
  assert.doesNotThrow(() => uniqueSkill(listedSkills(listing), 'tdd'));
  assert.throws(() => uniqueSkill(listedSkills(listing), 'review-code'), /ambíguo/);
  assert.throws(() => uniqueSkill(['Review Code'], 'review-code'), /ambíguo|não encontrada/);
  assert.throws(() => uniqueSkill(['tdd'], 'outra'), /não encontrada/);
});

test('instalação recusa pasta de skills que seja link para fora do projeto', (t) => {
  const dir = temp(t);
  const outside = temp(t);
  mkdirSync(path.join(dir, '.claude'));
  assert.doesNotThrow(() => checkDestinations(dir));
  try { symlinkSync(outside, path.join(dir, '.agents'), 'junction'); } catch { t.skip('sem permissão para criar link'); return; }
  assert.throws(() => checkDestinations(dir), /\.agents aponta para fora do projeto/);
});

test('inventário mostra criado, alterado e removido, inclusive arquivo que já estava modificado', (t) => {
  const dir = temp(t);
  mkdirSync(path.join(dir, '.agents', 'skills', 'util'), { recursive: true });
  writeFileSync(path.join(dir, '.agents', 'skills', 'util', 'SKILL.md'), 'antes');
  writeFileSync(path.join(dir, '.agents', 'skills', 'velha.md'), 'x');
  const before = snapshot(dir);
  writeFileSync(path.join(dir, '.agents', 'skills', 'util', 'SKILL.md'), 'depois');
  rmSync(path.join(dir, '.agents', 'skills', 'velha.md'));
  mkdirSync(path.join(dir, '.claude', 'skills', 'nova'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'skills', 'nova', 'SKILL.md'), 'n');
  assert.deepEqual(difference(before, snapshot(dir)), [
    'alterado .agents/skills/util/SKILL.md', 'criado .claude/skills/nova/SKILL.md', 'removido .agents/skills/velha.md',
  ]);
});

test('lista de fontes confiáveis pode ser trocada pelo projeto', (t) => {
  const dir = temp(t);
  assert.deepEqual(trustedOwners(dir), defaultTrusted);
  mkdirSync(path.join(dir, '.agent-kit'));
  writeFileSync(path.join(dir, '.agent-kit', 'skills-sources.json'), JSON.stringify({ trusted: ['MinhaOrg'] }));
  assert.deepEqual(trustedOwners(dir), ['minhaorg']);
});

test('push e PR do kit recusam a branch padrão e as protegidas', () => {
  assert.equal(checkBranch('feat/login', 'main'), 'feat/login');
  for (const branch of ['main', 'Master', 'develop', 'release/1.2', 'trunk']) {
    assert.throws(() => checkBranch(branch, 'trunk'), /padrão ou protegida/);
  }
  for (const branch of ['', '-f', 'a..b', 'x y']) assert.throws(() => checkBranch(branch, 'main'), /inválida/);
});

test('kit skills e kit git recusam uso inválido sem chamar a rede', () => {
  const run = (...args) => spawnSync(process.execPath, ['template/.agent-kit/kit.mjs', ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.match(run('skills').stderr, /Use skills find/);
  assert.match(run('skills', 'add', 'desconhecido/skills', 'util').stderr, /fonte-aprovada/);
  assert.match(run('skills', 'find', '--owner', 'x').stderr, /Termos/);
  assert.match(run('git', 'pr').stderr, /Use git commit/);
  assert.match(run('git', 'pr', 'Título bom', '--body-file', 'nao-existe.md').stderr, /Não foi possível ler/);
});

// Casamento das regras como o Claude Code descreve: * casa qualquer texto; bloqueio vence liberação.
function decide(permissions, command) {
  const matches = (rule) => {
    const body = rule.match(/^Bash\((.*)\)$/)?.[1];
    return body !== undefined && new RegExp('^' + body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      .test(command);
  };
  if (permissions.deny.some(matches)) return 'deny';
  return permissions.allow.some(matches) ? 'allow' : 'ask';
}

test('permissões do projeto liberam leitura e o kit, e nenhuma escrita crua do git passa sem confirmação', () => {
  const { permissions } = JSON.parse(readFileSync('template/.claude/settings.json', 'utf8'));
  for (const command of ['node .agent-kit/kit.mjs flow status', 'node .agent-kit/kit.mjs git push',
    'node .agent-kit/kit.mjs git commit "feat: x" -- src/a.js', 'node .agent-kit/kit.mjs skills find react',
    'git status', 'git status --short', 'git diff --stat', 'git log --oneline -5', 'git fetch origin', 'gh pr checks 12',
    'node --test']) assert.equal(decide(permissions, command), 'allow', command);
  // Escrita crua do git nunca fica liberada: ou pede confirmação, ou é bloqueada.
  for (const command of [
    'git add docs/agent-flow.md', 'git add -A', 'git add -vf .env', 'git add --for .env', 'git commit -m "fix: documenta --amend"',
    'git commit -m x --amen', 'git commit -m x -n', 'git push -u origin feat/domain', 'git push', 'git push -u origin +HEAD:main',
    'git push origin feat:master', 'git fetch origin +refs/heads/old:refs/heads/main', 'git switch feat/x', 'git switch -C main HEAD',
    'gh pr create --draft --title x', 'gh pr create --title x --draft=false', 'gh pr merge 12 --squash',
  ]) assert.notEqual(decide(permissions, command), 'allow', command);
  for (const command of ['git push --force', 'git push -f origin x', 'git reset --hard HEAD~1', 'git clean -fd', 'git branch -D feat/x',
    'git checkout -- .', 'git diff --output=/tmp/x', 'git log --oneline --output=a.txt', 'npx skills add x/y', 'npx -y skills find --owner x',
    'npm install -g pacote', 'npm i -g pacote', 'gh repo delete x/y']) assert.equal(decide(permissions, command), 'deny', command);
});

test('commit do kit recusa opção, curinga, arquivo fora do projeto e nome de segredo', () => {
  const seen = [];
  const inspect = (file) => seen.push(file);
  assert.deepEqual(checkCommit('feat: login', ['src/a.js', './docs/b.md'], inspect), ['src/a.js', 'docs/b.md']);
  assert.deepEqual(seen, ['src/a.js', 'docs/b.md'], 'cada arquivo é inspecionado no disco');
  assert.throws(() => checkCommit('--amend', ['a.js'], inspect), /Mensagem/);
  assert.throws(() => checkCommit('feat: x', [], inspect), /arquivos/);
  assert.throws(() => checkCommit('feat: x', ['../fora.js'], inspect), /fora do projeto/);
  for (const file of ['*', 'src/*.js', ':(glob)**', '--all', 'a[bc].js']) {
    assert.throws(() => checkCommit('feat: x', [file], inspect), /sem curinga nem opção/, file);
  }
  for (const file of ['.env', 'config/.env.local', 'id_rsa', 'certs/server.key', 'credentials.json', 'secrets.yaml']) {
    assert.throws(() => checkCommit('feat: x', [file], inspect), /nome de segredo/, file);
  }
});

test('commit do kit recusa pasta, link simbólico e link físico no disco', (t) => {
  const dir = path.resolve('template', '.tmp-commit-teste');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'pasta'), { recursive: true });
  writeFileSync(path.join(dir, 'comum.txt'), 'x');
  writeFileSync(path.join(dir, 'original.txt'), 'y');
  const rel = (name) => '.tmp-commit-teste/' + name;
  assert.throws(() => checkCommit('feat: x', [rel('pasta')]), /não pastas/);
  try { linkSync(path.join(dir, 'original.txt'), path.join(dir, 'fisico.txt')); } catch { t.skip('sem link físico'); return; }
  assert.throws(() => checkCommit('feat: x', [rel('fisico.txt')]), /link físico/);
  try { symlinkSync(path.join(dir, 'comum.txt'), path.join(dir, 'simbolico.txt')); } catch { return; }
  assert.throws(() => checkCommit('feat: x', [rel('simbolico.txt')]), /é um link/);
});

test('push recusa quando não consegue confirmar a branch padrão, e a listagem ignora cores', () => {
  assert.throws(() => checkBranch('feat/x', null), /confirmar a branch padrão/);
  const esc = String.fromCharCode(27);
  assert.deepEqual(listedSkills('│    ' + esc + '[36mtdd' + esc + '[39m\n│\n│      descrição'), ['tdd']);
});

test('instalação pede à CLI só os clientes do kit', async () => {
  const { kitAgents } = await import('./template/.codex/hooks/skills.mjs');
  assert.deepEqual(kitAgents, ['claude-code', 'codex', 'antigravity-cli', 'hermes-agent']);
  const source = readFileSync('template/.codex/hooks/skills.mjs', 'utf8');
  assert.match(source, /'--agent', \.\.\.kitAgents, '--copy', '--yes'/);
});
