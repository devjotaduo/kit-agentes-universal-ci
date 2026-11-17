import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Ponta a ponta: roteiros sem IA dirigem os comandos reais do kit (install.mjs, kit.mjs flow, bootstrap e a guarda
// chamada como o Claude Code chama) num repositório temporário e reproduzem os atritos que agentes reais tiveram.
// Os cenários das issues abertas são todo: rodam, mostram a falha e não quebram o CI até a correção.

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));

function directory(t) {
  const base = realpathSync(os.tmpdir());
  const dir = mkdtempSync(path.join(base, 'agent-ponta-a-ponta-'));
  t.after(() => {
    assert.equal(path.dirname(realpathSync(dir)), base);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const run = (cwd, command, args, options = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000, ...options });
const kit = (dir, ...args) => run(dir, process.execPath, ['.agent-kit/kit.mjs', ...args]);
const flow = (dir, ...args) => kit(dir, 'flow', ...args);
const git = (dir, ...args) => run(dir, 'git', args);

function ok(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function blocked(result, message) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, message);
}

function note(dir, name) {
  mkdirSync(path.join(dir, '.agent-flow/notes'), { recursive: true });
  const file = '.agent-flow/notes/' + name + '.md';
  writeFileSync(path.join(dir, file), 'Evidência ' + name);
  return file;
}

// A guarda aceita a pasta temporária do sistema, onde ficam os projetos de teste: o hook roda com outra.
function hookEnv(project) {
  const temp = path.join(os.tmpdir(), 'agent-ponta-a-ponta-sem-temp');
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: path.join(temp, 'home'),
    USERPROFILE: path.join(temp, 'home'), CLAUDE_PROJECT_DIR: project };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

// Como o Claude Code chama a guarda: node ${CLAUDE_PROJECT_DIR}/.agent-kit/kit.mjs hook claude, com o cwd da sessão
// no payload. Devolve a decisão (undefined quando libera) e o motivo.
function guarda(project, cwd, file) {
  const input = JSON.stringify({ cwd, session_id: 'sessao-roteiro', hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' } });
  const output = JSON.parse(ok(run(cwd, process.execPath, [path.join(project, '.agent-kit', 'kit.mjs'), 'hook', 'claude'],
    { input, env: hookEnv(project) }))).hookSpecificOutput;
  return { decision: output?.permissionDecision, reason: output?.permissionDecisionReason };
}

function instalar(root) {
  ok(run(root, process.execPath, [install, root]));
  ok(kit(root, 'bootstrap', 'git-init'));
  ok(git(root, 'config', 'user.name', 'Roteiro Ponta a Ponta'));
  ok(git(root, 'config', 'user.email', 'ponta-a-ponta@example.invalid'));
  ok(git(root, 'config', 'commit.gpgsign', 'false'));
  ok(git(root, 'add', '-A'));
  ok(git(root, 'commit', '-q', '-m', 'base'));
}

// Roteiro do agente de uma tarefa pequena: abre a correção, uma frente na descoberta, plano aceito e implement.
function ateImplement(dir, nome) {
  ok(flow(dir, 'new', 'fix', 'Correção pequena ' + nome));
  ok(flow(dir, 'record-parallel', 'discover', 'tarefa-' + nome, 'descoberta-' + nome));
  ok(flow(dir, 'approve', note(dir, 'plano-' + nome), 'Usuário aceitou no chat'));
  assert.match(ok(flow(dir, 'advance', 'discover', note(dir, 'descoberta-' + nome))), /Próxima etapa: implement/);
}

// Continua do implement até ready: edita, commita pelo kit, valida e revisa.
function ateReady(dir, nome, arquivo) {
  mkdirSync(path.dirname(path.join(dir, arquivo)), { recursive: true });
  writeFileSync(path.join(dir, arquivo), 'conteúdo de ' + nome);
  ok(flow(dir, 'advance', 'implement', note(dir, 'implementacao-' + nome)));
  ok(kit(dir, 'git', 'commit', 'Corrige ' + nome, '--', arquivo));
  ok(flow(dir, 'advance', 'validate', note(dir, 'validacao-' + nome)));
  ok(flow(dir, 'record-parallel', 'review', 'tarefa-' + nome, 'revisao-' + nome));
  assert.match(ok(flow(dir, 'advance', 'review', note(dir, 'revisao-' + nome))), /Próxima etapa: ready/);
  ok(flow(dir, 'check'));
}

function worktree(root, dir, branch) {
  ok(git(root, 'worktree', 'add', '-q', '-b', branch, dir));
  return realpathSync(dir);
}

test('caminho feliz: tarefa pequena numa worktree, da instalação ao close, com a guarda liberando só em implement', (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(directory(t), 'tarefa'), 'tarefa');
  const produto = path.join(tree, 'src', 'app.txt');

  ok(flow(tree, 'new', 'fix', 'Correção pequena'));
  assert.equal(guarda(tree, tree, produto).decision, 'deny');
  assert.match(guarda(tree, tree, produto).reason, /edição de produto indisponível em discover/);
  // Plano e notas locais podem ser escritos na descoberta.
  assert.equal(guarda(tree, tree, path.join(tree, '.agent-flow', 'notes', 'plano.md')).decision, undefined);
  ok(flow(tree, 'record-parallel', 'discover', 'tarefa', 'descoberta'));
  blocked(flow(tree, 'advance', 'discover', note(tree, 'descoberta')), /aceite do plano/);
  ok(flow(tree, 'approve', note(tree, 'plano'), 'Usuário aceitou no chat'));
  ok(flow(tree, 'advance', 'discover', '.agent-flow/notes/descoberta.md'));

  assert.equal(guarda(tree, tree, produto).decision, undefined);
  mkdirSync(path.dirname(produto), { recursive: true });
  writeFileSync(produto, 'corrigido');
  ok(flow(tree, 'advance', 'implement', note(tree, 'implementacao')));
  assert.match(guarda(tree, tree, produto).reason, /edição de produto indisponível em validate/);
  blocked(flow(tree, 'advance', 'validate', note(tree, 'validacao')), /não commitada: src\/app\.txt/);
  ok(kit(tree, 'git', 'commit', 'Corrige app', '--', 'src/app.txt'));
  ok(flow(tree, 'advance', 'validate', '.agent-flow/notes/validacao.md'));
  ok(flow(tree, 'record-parallel', 'review', 'tarefa', 'revisao'));
  ok(flow(tree, 'advance', 'review', note(tree, 'revisao')));
  assert.match(guarda(tree, tree, produto).reason, /edição de produto indisponível em ready/);
  assert.match(ok(flow(tree, 'check')), /Ready/);
  assert.match(ok(flow(tree, 'close')), /Tarefa arquivada: closed\./);
  assert.equal(ok(flow(tree, 'status')), 'Sem tarefa ativa.');
  const archive = path.join(tree, '.agent-flow', 'archive');
  assert.deepEqual(readdirSync(archive).map((file) => JSON.parse(readFileSync(path.join(archive, file), 'utf8')).outcome), ['closed']);
});

// Causa no relatório de atritos 1.2.0, seção 1: flow.mjs calcula root pela posição do script, e outsideDestination
// só roda para destino fora da raiz; .claude/worktrees/<nome> fica dentro dela.
test('worktree aninhada em .claude/worktrees: a guarda segue a tarefa da worktree, não a do checkout principal', { todo: 'issue #51' }, (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(root, '.claude', 'worktrees', 'frente'), 'frente');
  ok(flow(root, 'new', 'fix', 'Tarefa de outra sessão no principal'));
  ateImplement(tree, 'worktree');
  const destino = path.join(tree, 'src', 'app.txt');
  // Controles: sem eles uma falha do roteiro passaria pela falha da issue.
  assert.match(guarda(root, root, path.join(root, 'src', 'app.txt')).reason, /edição de produto indisponível em discover/);
  assert.equal(guarda(tree, tree, destino).decision, undefined);
  // CLAUDE_PROJECT_DIR no checkout principal, sessão na worktree.
  const { decision, reason } = guarda(root, tree, destino);
  assert.equal(decision, undefined, reason);
});

// Relatório de atritos 1.2.0, seção 6: o merge do próprio PR muda o HEAD depois da validação.
function prontoNaBranch(t) {
  const root = directory(t);
  instalar(root);
  const main = ok(git(root, 'branch', '--show-current'));
  ok(git(root, 'switch', '-q', '-c', 'tarefa'));
  ateImplement(root, 'merge');
  ateReady(root, 'merge', 'src/app.txt');
  ok(git(root, 'switch', '-q', main));
  return root;
}

test('close depois do merge do próprio PR: commit validado é ancestral do HEAD e o merge só traz o validado', { todo: 'issue #52' }, (t) => {
  const root = prontoNaBranch(t);
  ok(git(root, 'merge', '-q', '--no-ff', '-m', 'Merge do PR', 'tarefa'));
  const result = flow(root, 'close');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tarefa arquivada: closed\./);
});

test('close depois de um merge que traz arquivo de produto não validado continua recusado', (t) => {
  const root = prontoNaBranch(t);
  writeFileSync(path.join(root, 'novo.txt'), 'não revisado');
  ok(git(root, 'add', 'novo.txt'));
  ok(git(root, 'commit', '-q', '-m', 'Produto fora da tarefa'));
  ok(git(root, 'merge', '-q', '--no-ff', '-m', 'Merge do PR', 'tarefa'));
  blocked(flow(root, 'close'), /mudou após a validação\. Reabra a tarefa\./);
  assert.match(ok(flow(root, 'status')), /"stage": "ready"/);
});

function contem(dir, texto) {
  let names;
  try { names = readdirSync(dir, { recursive: true, withFileTypes: true }); } catch { return false; }
  return names.some((entry) => entry.isFile() && readFileSync(path.join(entry.parentPath, entry.name), 'utf8').includes(texto));
}

// Relatório de atritos 1.2.0, seção 12. O kit não remove worktrees, então o ponto objetivo é o close na worktree:
// depois dele as notas precisam estar no .agent-flow do principal, ou a saída do close precisa avisar das notas
// (os avisos atuais só cobrem docs/work/). A remoção da worktree é feita pelo roteiro, como um agente faria.
test('close numa worktree preserva as notas locais na principal ou avisa antes da remoção', { todo: 'issue #59' }, (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(directory(t), 'notas'), 'notas');
  ateImplement(tree, 'notas');
  ateReady(tree, 'notas', 'src/app.txt');
  const saida = ok(flow(tree, 'close'));
  ok(git(root, 'worktree', 'remove', '--force', tree));
  const preservada = contem(path.join(root, '.agent-flow'), 'Evidência plano-notas');
  assert.ok(preservada || /\.agent-flow\/notes/.test(saida),
    'As notas da worktree sumiram sem aviso. Saída do close: ' + JSON.stringify(saida));
});
