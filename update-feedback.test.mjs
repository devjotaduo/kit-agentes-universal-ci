import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KIT, message, newer, notice, readCache, refresh, releaseLock, reserve } from './template/.codex/hooks/update.mjs';
import { findSimilar, issue, validate } from './template/.codex/hooks/feedback.mjs';

test('issue parecida recém-criada é achada pela lista, mesmo fora do índice de busca', () => {
  const recent = [{ number: 2, title: '[melhoria] Falta teste automatizado para dobro', url: 'u2' },
    { number: 1, title: '[falha] Outra coisa', url: 'u1' }];
  const run = (args) => ({ status: 0, stdout: JSON.stringify(args.includes('--search') ? [] : recent) });
  assert.deepEqual(findSimilar('dono/repo', 'Falta teste automatizado para dobro', run).map((item) => item.number), [2]);
  assert.deepEqual(findSimilar('dono/repo', 'falta  TESTE automatizado para dóbro', run).map((item) => item.number), [2]);
  assert.deepEqual(findSimilar('dono/repo', 'Assunto sem relação nenhuma', run), []);
  const fromSearch = (args) => ({ status: 0, stdout: JSON.stringify(args.includes('--search') ? [{ number: 9, title: 'x', url: 'u9' }] : []) });
  assert.deepEqual(findSimilar('dono/repo', 'qualquer coisa aqui', fromSearch).map((item) => item.number), [9]);
  assert.throws(() => findSimilar('dono/repo', 'título', () => ({ status: 1, stdout: '' })), /Não foi possível consultar/);
});

const day = 24 * 60 * 60 * 1000;
const temp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const later = KIT.version.replace(/\d+$/, (patch) => String(Number(patch) + 1));

test('versão do kit é semver e newer compara por número', () => {
  assert.match(KIT.version, /^\d+\.\d+\.\d+$/);
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('0.4.9', '0.5.0'), false);
  assert.equal(newer('lixo', '0.5.0'), false);
});

test('aviso só lê o cache e agenda a consulta quando ele tem mais de um dia', (t) => {
  const dir = temp(t);
  const scheduled = [];
  const schedule = (target) => scheduled.push(target);
  assert.equal(notice(dir, Date.now(), schedule), null);
  assert.equal(scheduled.length, 1);

  refresh(dir, later, Date.now());
  assert.equal(notice(dir, Date.now(), schedule), message(later));
  assert.equal(scheduled.length, 1);
  assert.equal(notice(dir, Date.now() + 2 * day, schedule), message(later));
  assert.equal(scheduled.length, 2);

  refresh(dir, null, Date.now());
  assert.equal(readCache(dir).latest, later, 'consulta que falha mantém a última versão conhecida');
  refresh(dir, KIT.version, Date.now());
  assert.equal(notice(dir, Date.now(), schedule), null);
});

test('a trava entre sessões deixa só uma consulta e é retomada quando abandonada', (t) => {
  const dir = temp(t);
  const now = Date.now();
  assert.equal(reserve(dir, now), true);
  assert.equal(reserve(dir, now), false, 'segunda sessão não agenda enquanto a trava existe');
  const scheduled = [];
  notice(dir, now, (target) => scheduled.push(target));
  assert.equal(scheduled.length, 0);
  assert.equal(reserve(dir, now + 11 * 60 * 1000), true, 'trava abandonada há mais de dez minutos é retomada');
  releaseLock(dir);
  refresh(dir, later, now);
  assert.equal(reserve(dir, now), false, 'cache fresco depois de travar: não consulta de novo');
});

test('cache não é gravado através de uma .agent-flow que seja link', (t) => {
  const dir = temp(t);
  const outside = temp(t);
  try { symlinkSync(outside, path.join(dir, '.agent-flow'), 'junction'); } catch { t.skip('sem permissão para criar link'); return; }
  refresh(dir, later, Date.now());
  assert.equal(existsSync(path.join(outside, 'update-check.json')), false);
});

test('hook de início de sessão devolve o aviso no formato do cliente e nunca falha', (t) => {
  const root = temp(t);
  const installer = path.resolve('install.mjs');
  assert.equal(spawnSync(process.execPath, [installer, root], { encoding: 'utf8' }).status, 0);
  const notify = (client) => spawnSync(process.execPath, ['.agent-kit/kit.mjs', 'update', 'notice', client],
    { cwd: root, encoding: 'utf8', env: { ...process.env, AGENT_KIT_NO_UPDATE_CHECK: '1' } });
  assert.equal(notify('claude').stdout.trim(), '{}');
  mkdirSync(path.join(root, '.agent-flow'), { recursive: true });
  writeFileSync(path.join(root, '.agent-flow', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: later }));
  const out = JSON.parse(notify('codex').stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp('Kit Universal ' + later.replaceAll('.', '\\.') + ' disponível'));
  writeFileSync(path.join(root, '.agent-flow', 'update-check.json'), '{');
  assert.equal(notify('claude').stdout.trim(), '{}');
});

test('feedback recusa segredo, caminho pessoal e texto curto, e marca a origem', () => {
  const body = 'Ao rodar o doctor num projeto novo, a mensagem não diz qual arquivo faltou.';
  assert.doesNotThrow(() => validate({ kind: 'melhoria', title: 'Doctor deveria citar o arquivo', body }));
  assert.throws(() => validate({ kind: 'ideia', title: 'Doctor deveria citar o arquivo', body }), /Tipo inválido/);
  assert.throws(() => validate({ kind: 'bug', title: 'curto', body }), /título/);
  const fake = 'ghp_' + 'a'.repeat(36);
  assert.throws(() => validate({ kind: 'bug', title: 'Token no exemplo do README', body: body + ' ' + fake }), /token do GitHub/);
  assert.throws(() => validate({ kind: 'bug', title: 'Falha ao instalar o kit aqui', body: body + ' Authorization: Bearer abcdefghijklmnopqrstu' }), /autorização/);
  assert.throws(() => validate({ kind: 'bug', title: 'Falha ao instalar o kit aqui', body: body + ' C:\\Users\\fulano\\projeto' }), /pasta pessoal/);
  assert.throws(() => validate({ kind: 'bug', title: 'Falha ao instalar o kit aqui', body: body + ' /home/fulano/x' }), /pasta pessoal/);
  for (const sample of ['{"password": "exemplo-ficticio"}', "secret: 'exemplo-ficticio'", 'api_key=exemplo-ficticio',
    '{"password":"um dois tres quatro"}', '{"pass\\u0077ord": "exemplo-ficticio"}', 'password: |\n  linha um\n  linha dois']) {
    assert.throws(() => validate({ kind: 'bug', title: 'Falha no comando doctor', body: body + ' ' + sample }), /senha ou segredo/);
  }
  const draft = issue({ kind: 'funcionalidade', title: ' Comando para listar projetos ', body, client: 'antigravity' });
  assert.equal(draft.title, '[funcionalidade] Comando para listar projetos');
  assert.match(draft.body, new RegExp('Kit Universal ' + KIT.version.replaceAll('.', '\\.') + ' \\(cliente antigravity\\)'));
});

test('feedback --dry-run mostra a issue sem chamar o GitHub e erro não repete o segredo', (t) => {
  const root = temp(t);
  assert.equal(spawnSync(process.execPath, [path.resolve('install.mjs'), root], { encoding: 'utf8' }).status, 0);
  const feedback = (...args) => spawnSync(process.execPath, ['.agent-kit/kit.mjs', '--client', 'claude', 'feedback', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } });
  const ok = feedback('melhoria', 'Doctor deveria citar o arquivo', '--body', 'A mensagem do doctor não diz qual arquivo faltou.', '--dry-run');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Título: \[melhoria\] Doctor deveria citar o arquivo/);
  assert.match(ok.stdout, /cliente claude/);
  const fake = 'sk-' + 'b'.repeat(30);
  const refused = feedback('bug', 'Chave no exemplo de configuração', '--body', 'Exemplo com a chave ' + fake + ' no texto.', '--dry-run');
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(fake));
  const missing = feedback('bug', 'Falha no comando doctor', '--body-file', 'pasta-confidencial/nota.md', '--dry-run');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Não foi possível ler o arquivo do corpo/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /pasta-confidencial/);
});
