import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Ponta a ponta: roteiros sem IA dirigem os comandos reais do kit (install.mjs, kit.mjs flow, bootstrap e a guarda
// chamada como o Claude Code chama) num repositório temporário e reproduzem os atritos que agentes reais tiveram.
// Os cenários das issues abertas são todo: rodam, mostram a falha e não quebram o CI até a correção. Quem corrigir
// uma issue tira o { todo } do cenário dela no mesmo PR.

const install = fileURLToPath(new URL('./install.mjs', import.meta.url));

function directory(t) {
  const base = realpathSync(os.tmpdir());
  const dir = mkdtempSync(path.join(base, 'agent-ponta-a-ponta-'));
  t.after(() => {
    try { assert.equal(path.dirname(realpathSync(dir)), base); } finally { rmSync(dir, { recursive: true, force: true }); }
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

// Cópia do hookEnv de flow-guards.test.mjs (que não o exporta), com CLAUDE_PROJECT_DIR. A guarda aceita a pasta
// temporária do sistema, onde ficam os projetos de teste: o hook roda com outra.
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
// só roda para destino fora da raiz; .claude/worktrees/<nome> fica dentro dela. A issue admite duas correções e as
// duas valem aqui: decidir pela tarefa da worktree, ou recusar mandando abrir a sessão na worktree.
const abrirNaWorktree = /abra a sessão/i;

function aninhada(t, etapaPrincipal) {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(root, '.claude', 'worktrees', 'frente'), 'frente');
  if (etapaPrincipal === 'implement') ateImplement(root, 'principal');
  else ok(flow(root, 'new', 'fix', 'Tarefa de outra sessão no principal'));
  return { root, tree, destino: path.join(tree, 'src', 'app.txt') };
}

test('worktree aninhada em .claude/worktrees: a guarda segue a tarefa da worktree, não a do checkout principal', (t) => {
  const { root, tree, destino } = aninhada(t, 'discover');
  ateImplement(tree, 'worktree');
  // Controles: sem eles uma falha do roteiro passaria pela falha da issue.
  assert.match(guarda(root, root, path.join(root, 'src', 'app.txt')).reason, /edição de produto indisponível em discover/);
  assert.equal(guarda(tree, tree, destino).decision, undefined);
  // CLAUDE_PROJECT_DIR no checkout principal, sessão na worktree em implement.
  const { decision, reason } = guarda(root, tree, destino);
  assert.ok(decision === undefined || decision === 'deny' && abrirNaWorktree.test(reason) && !/indisponível em/.test(reason),
    'A guarda decidiu pela tarefa do principal: ' + reason);
});

// O inverso: a worktree numa etapa sem edição de produto e o principal em implement. Liberar tudo em
// .claude/worktrees não passa: a recusa tem de vir da etapa da worktree (discover) ou mandar abrir a sessão nela.
test('worktree aninhada em discover com o principal em implement: a guarda recusa pela etapa da worktree', (t) => {
  const { root, tree, destino } = aninhada(t, 'implement');
  ok(flow(tree, 'new', 'fix', 'Tarefa da worktree ainda na descoberta'));
  // Controles: o principal em implement libera o próprio produto; a worktree pela própria guarda recusa.
  assert.equal(guarda(root, root, path.join(root, 'src', 'app.txt')).decision, undefined);
  assert.match(guarda(tree, tree, destino).reason, /edição de produto indisponível em discover/);
  const { decision, reason } = guarda(root, tree, destino);
  assert.equal(decision, 'deny', 'A guarda liberou pela etapa do principal (implement).');
  assert.ok(/indisponível em discover/.test(reason) || abrirNaWorktree.test(reason), reason);
});

// Issue #83: com o principal em implement e a worktree em discover, docs/work/ da worktree é aceito (também de uma
// subpasta dela), e um destino em outra worktree aninhada é recusado com o caminho dessa outra, não o do principal.
test('worktree aninhada: docs/work dela é aceito e destino na worktree irmã é recusado com o caminho da irmã', (t) => {
  const { root, tree } = aninhada(t, 'implement');
  ok(flow(tree, 'new', 'fix', 'Tarefa da worktree ainda na descoberta'));
  const nota = path.join(tree, 'docs', 'work', 'nota.md');
  assert.equal(guarda(root, tree, nota).decision, undefined);
  mkdirSync(path.join(tree, 'src'), { recursive: true });
  assert.equal(guarda(root, path.join(tree, 'src'), nota).decision, undefined);
  const irma = worktree(root, path.join(root, '.claude', 'worktrees', 'irma'), 'irma');
  const { decision, reason } = guarda(root, tree, path.join(irma, 'docs', 'work', 'nota.md'));
  assert.equal(decision, 'deny');
  // A guarda mostra o caminho real nativo: no Windows, sem o nome curto (RUNNER~1) que o realpathSync mantém.
  assert.ok(reason.includes('worktree ' + realpathSync.native(irma) + ' do mesmo'), reason);
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

test('sessão na raiz editando arquivo de worktree aninhada é mandada para a worktree, mesmo com o principal em implement', (t) => {
  const { root, tree, destino } = aninhada(t, 'implement');
  ateImplement(tree, 'worktree');
  const { decision, reason } = guarda(root, root, destino);
  assert.equal(decision, 'deny');
  assert.match(reason, abrirNaWorktree);
});

test('sessão numa worktree aninhada sem o kit: a edição é recusada dizendo que falta o kit', (t) => {
  const { root, tree, destino } = aninhada(t, 'implement');
  rmSync(path.join(tree, '.codex'), { recursive: true, force: true });
  const { decision, reason } = guarda(root, tree, destino);
  assert.equal(decision, 'deny');
  assert.match(reason, /não tem o kit instalado/);
});

// O kit da worktree recebe a carga do Hermes como veio: convertida para PreToolUse, ele a recusava como ilegível.
test('Hermes numa worktree aninhada: quem decide é o kit da worktree, com a carga original', (t) => {
  const { root, tree, destino } = aninhada(t, 'implement');
  const hermes = () => JSON.parse(ok(run(tree, process.execPath, [path.join(root, '.agent-kit', 'kit.mjs'), 'hook', 'hermes'],
    { input: JSON.stringify({ cwd: tree, session_id: 'sessao-roteiro', hook_event_name: 'pre_tool_call',
      tool_name: 'write_file', tool_input: { path: destino, content: 'x' } }), env: hookEnv(root) })));
  assert.deepEqual(hermes(), {});
  ok(flow(tree, 'new', 'fix', 'Tarefa da worktree ainda na descoberta'));
  assert.match(hermes().message, /indisponível em discover/);
  // Kit da worktree quebrado: a falha dele recusa a escrita, não a libera.
  writeFileSync(path.join(tree, '.codex', 'hooks', 'flow.mjs'), 'process.exit(1);\n');
  assert.equal(hermes().action, 'block');
});

test('um .git de subpasta que não é worktree (repositório de teste) não tira o destino da guarda da worktree', (t) => {
  const { root, tree } = aninhada(t, 'implement');
  ok(flow(tree, 'new', 'fix', 'Tarefa da worktree ainda na descoberta'));
  const sub = path.join(tree, 'vendor', 'sub');
  mkdirSync(sub, { recursive: true });
  ok(git(sub, 'init', '-q'));
  const { decision, reason } = guarda(root, tree, path.join(sub, 'arquivo.txt'));
  assert.equal(decision, 'deny', 'O destino escapou da guarda pelo .git da subpasta.');
  assert.match(reason, /indisponível em discover/);
  // Na raiz, o mesmo tipo de subpasta continua sendo produto do principal, que está em implement.
  const local = path.join(root, 'vendor', 'local');
  mkdirSync(local, { recursive: true });
  ok(git(local, 'init', '-q'));
  assert.doesNotMatch(String(guarda(root, root, path.join(local, 'arquivo.txt')).reason), /abra a sessão/);
});

test('sessão numa worktree aninhada: o aviso de início de sessão vem da tarefa da worktree', (t) => {
  const { root, tree } = aninhada(t, 'implement');
  ok(flow(tree, 'new', 'fix', 'Tarefa da worktree ainda na descoberta'));
  const input = JSON.stringify({ cwd: tree, session_id: 'sessao-roteiro', hook_event_name: 'SessionStart' });
  const saida = JSON.parse(ok(run(tree, process.execPath, [path.join(root, '.agent-kit', 'kit.mjs'), 'hook', 'claude'],
    { input, env: hookEnv(root) })));
  assert.match(saida.hookSpecificOutput.additionalContext, /fix em discover/);
});

test('close depois do merge --no-ff do próprio PR: commit validado é ancestral do HEAD e o merge só traz o validado', (t) => {
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
  blocked(flow(root, 'close'), /mudou após a validação\. Reabra a tarefa/);
  assert.equal(JSON.parse(ok(flow(root, 'status'))).stage, 'ready');
});

function contem(dir, texto) {
  let names;
  try { names = readdirSync(dir, { recursive: true, withFileTypes: true }); } catch { return false; }
  return names.some((entry) => entry.isFile() && readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8').includes(texto));
}

// Relatório de atritos 1.2.0, seção 12 (proposta H). O kit não remove worktrees, então o ponto objetivo é o close na
// worktree: depois dele e da remoção, que o roteiro faz como um agente faria, o texto das notas tem de estar em
// .agent-flow/notes/ do principal. Só um aviso não basta: as notas somem do mesmo jeito.
test('close depois do merge do próprio PR e de uma nota de evidência commitada em seguida é aceito', (t) => {
  const root = prontoNaBranch(t);
  ok(git(root, 'merge', '-q', '--no-ff', '-m', 'Merge do PR', 'tarefa'));
  mkdirSync(path.join(root, 'docs', 'work'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'work', 'revisao.md'), 'Nota de revisão');
  ok(git(root, 'add', 'docs/work/revisao.md'));
  ok(git(root, 'commit', '-q', '-m', 'Nota de revisão'));
  const result = flow(root, 'close');
  assert.equal(result.status, 0, result.stderr);
});

// A árvore final é igual à validada, mas o histórico que o merge traz tem produto que ninguém revisou.
test('close depois de um merge cujo outro lado acrescentou e removeu produto continua recusado', (t) => {
  const root = prontoNaBranch(t);
  writeFileSync(path.join(root, 'novo.txt'), 'não revisado');
  ok(git(root, 'add', 'novo.txt'));
  ok(git(root, 'commit', '-q', '-m', 'Produto fora da tarefa'));
  ok(git(root, 'rm', '-q', 'novo.txt'));
  ok(git(root, 'commit', '-q', '-m', 'Remove o produto'));
  ok(git(root, 'merge', '-q', '--no-ff', '-m', 'Merge do PR', 'tarefa'));
  blocked(flow(root, 'close'), /O HEAD ou o índice Git mudou após a validação/);
});

test('close numa worktree preserva as notas locais na principal antes da remoção', (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(directory(t), 'notas'), 'notas');
  ateImplement(tree, 'notas');
  ateReady(tree, 'notas', 'src/app.txt');
  const saida = ok(flow(tree, 'close'));
  ok(git(root, 'worktree', 'remove', '--force', tree));
  assert.ok(contem(path.join(root, '.agent-flow', 'notes'), 'Evidência plano-notas'),
    'As notas da worktree sumiram com ela. Saída do close: ' + JSON.stringify(saida));
});

test('close numa worktree guarda o resumo da tarefa; na principal o close não copia nada', (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(directory(t), 'resumo'), 'resumo');
  ateImplement(tree, 'resumo');
  ateReady(tree, 'resumo', 'src/app.txt');
  const saida = ok(flow(tree, 'close'));
  const pasta = saida.match(/guardadas em (\S+) da worktree principal/)?.[1];
  assert.ok(pasta, saida);
  const tarefa = JSON.parse(readFileSync(path.join(root, pasta, 'tarefa.json'), 'utf8'));
  assert.equal(tarefa.outcome, 'closed');
  ateImplement(root, 'principal');
  ateReady(root, 'principal', 'src/outro.txt');
  assert.doesNotMatch(ok(flow(root, 'close')), /guardadas em/);
});

test('cancel numa worktree também guarda as notas; subpastas vêm junto e links ficam de fora', (t) => {
  const root = directory(t);
  instalar(root);
  const tree = worktree(root, path.join(directory(t), 'cancelada'), 'cancelada');
  ok(flow(tree, 'new', 'fix', 'Tarefa que vai ser cancelada'));
  const notas = path.join(tree, '.agent-flow', 'notes');
  mkdirSync(path.join(notas, 'sub'), { recursive: true });
  writeFileSync(path.join(notas, 'sub', 'detalhe.md'), 'Nota da subpasta');
  const fora = directory(t);
  writeFileSync(path.join(fora, 'segredo.txt'), 'fora do projeto');
  symlinkSync(fora, path.join(notas, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const saida = ok(flow(tree, 'cancel', 'Desistimos'));
  const pasta = saida.match(/guardadas em (\S+) da worktree principal/)?.[1];
  assert.ok(pasta, saida);
  assert.equal(readFileSync(path.join(root, pasta, 'sub', 'detalhe.md'), 'utf8'), 'Nota da subpasta');
  assert.equal(existsSync(path.join(root, pasta, 'link')), false, 'O link foi copiado.');
  assert.equal(JSON.parse(readFileSync(path.join(root, pasta, 'tarefa.json'), 'utf8')).outcome, 'canceled');
});
