import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'medir-uso.mjs');
const linha = (texto) => JSON.stringify({ message: texto }) + '\n';

function cenario(arquivos) {
  const raiz = mkdtempSync(join(tmpdir(), 'medir-uso-'));
  for (const [nome, conteudo, data] of arquivos) {
    const caminho = join(raiz, nome);
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo);
    if (data) utimesSync(caminho, data, data);
  }
  return raiz;
}

const roda = (raiz, ...extra) => spawnSync(process.execPath,
  [script, '--claude', join(raiz, 'claude'), '--codex', join(raiz, 'codex'), ...extra], { encoding: 'utf8' });
// O padrão tem `\|` dentro; só as quatro últimas colunas importam, na posição 3 a 6.
const linhaDe = (saida, id) => ['', id, '', ...saida.split('\n').find((l) => l.startsWith(`| ${id} |`)).replace(/ \|$/, '').split(' | ').slice(-4)];

test('conta por sessão, ignora sessão sem o kit e linha inválida', () => {
  const kit = 'node .agent-kit/kit.mjs flow status';
  const raiz = cenario([
    ['claude/p/a.jsonl', linha(kit) + linha('Identidade da sessão indisponível') + 'não é json\n' + linha('Identidade da sessão indisponível')],
    ['codex/2026/b.jsonl', linha('Agent Flow: ativo') + linha('needs agent_id')],
    ['codex/2026/c.jsonl', linha('Agent Live: x')],
    ['claude/p/sem-kit.jsonl', linha('Identidade da sessão indisponível')],
  ]);
  try {
    const r = roda(raiz);
    assert.equal(r.status, 0);
    const e = linhaDe(r.stdout, 'E');
    assert.deepEqual([e[3], e[4], e[5], e[6]], ['1', '3', '33.3%', '2']);
    assert.equal(linhaDe(r.stdout, 'H')[3], '1');
    assert.match(r.stdout, /Total de ocorrências: 3/);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--desde filtra pela data de modificação', () => {
  const velho = new Date('2026-01-01');
  const raiz = cenario([
    ['claude/a.jsonl', linha('.agent-kit/kit.mjs') + linha('Identidade da sessão indisponível'), velho],
    ['claude/b.jsonl', linha('.agent-kit/kit.mjs')],
  ]);
  try {
    const r = roda(raiz, '--desde', '2026-06-01');
    const e = linhaDe(r.stdout, 'E');
    assert.deepEqual([e[3], e[4]], ['0', '1']);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('a saída não traz texto de transcrição, caminho nem nome de projeto', () => {
  const raiz = cenario([['claude/projeto-secreto/sessao-xyz.jsonl',
    linha('.agent-kit/kit.mjs segredo-no-texto Identidade da sessão indisponível')]]);
  try {
    const r = roda(raiz);
    for (const proibido of ['segredo-no-texto', 'projeto-secreto', 'sessao-xyz', raiz]) assert.ok(!r.stdout.includes(proibido));
    assert.equal(r.stderr, '');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('padrões A e F casam com as frases reais do kit', () => {
  const raiz = cenario([['claude/a.jsonl', linha('.agent-kit/kit.mjs')
    + linha('O HEAD ou o índice Git mudou após a validação. Reabra a tarefa.')
    + linha('Credencial não corresponde a nenhuma posse deste pedido (dono atual: x).')
    + linha('Prazo total atingido em 2026-11-14.') + linha('O prazo total foi atingido')]]);
  try {
    const r = roda(raiz);
    assert.equal(linhaDe(r.stdout, 'F')[4], '1');
    assert.equal(linhaDe(r.stdout, 'A')[6], '3');
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('conta no máximo uma ocorrência por linha', () => {
  const dupla = 'Identidade da sessão indisponível / Identidade da sessão indisponível';
  const raiz = cenario([['claude/a.jsonl', linha('.agent-kit/kit.mjs') + linha(dupla)]]);
  try { assert.equal(linhaDe(roda(raiz).stdout, 'E')[6], '1'); } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('sessões do repositório do kit (e worktrees) ficam fora; instruções do Codex não contam', () => {
  const raiz = cenario([
    ['repo-kit/install.mjs', ''], ['repo-kit/template/.codex/hooks/flow.mjs', ''], ['projeto/x', ''],
  ]);
  const kitDir = join(raiz, 'repo-kit'), proj = join(raiz, 'projeto');
  const j = (o) => JSON.stringify(o) + '\n';
  const codex = (cwd, corpo) => j({ type: 'session_meta', payload: { cwd, base_instructions: '.agent-kit/kit.mjs' } })
    + j({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'AGENTS.md .agent-kit/kit.mjs' } }) + corpo;
  const uso = j({ type: 'response_item', payload: { type: 'function_call_output', output: 'Agent Flow: x Identidade da sessão indisponível' } });
  for (const [nome, conteudo] of [
    ['claude/k.jsonl', j({ cwd: kitDir, message: '.agent-kit/kit.mjs' })],
    ['claude/p.jsonl', j({ cwd: proj, message: '.agent-kit/kit.mjs Identidade da sessão indisponível' })],
    ['codex/k.jsonl', codex(kitDir, uso)],
    ['codex/so-instrucao.jsonl', codex(proj, '')],
    ['codex/p.jsonl', codex(proj, uso)],
  ]) {
    mkdirSync(dirname(join(raiz, nome)), { recursive: true });
    writeFileSync(join(raiz, nome), conteudo);
  }
  try {
    const e = linhaDe(roda(raiz).stdout, 'E');
    assert.deepEqual([e[3], e[4]], ['2', '2']);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--desde recusa data inválida', () => {
  const raiz = cenario([['claude/a.jsonl', linha('x')]]);
  try {
    for (const d of ['2026-02-30', 'ontem', '2026-13-01']) {
      const r = roda(raiz, '--desde', d);
      assert.equal(r.status, 1);
      assert.equal(r.stderr, 'Use --desde AAAA-MM-DD com uma data válida.\n');
    }
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('descarta cwd de worktree do kit já apagada e linhas turn_context do Codex', () => {
  const j = (o) => JSON.stringify(o) + '\n';
  const apagada = join(tmpdir(), 'worktree', 'kit-agentes-universal', 'inexistente');
  const raiz = cenario([
    ['claude/a.jsonl', j({ cwd: apagada, message: '.agent-kit/kit.mjs Identidade da sessão indisponível' })],
    ['codex/b.jsonl', j({ type: 'session_meta', payload: { cwd: join(tmpdir(), 'outro') } })
      + j({ type: 'turn_context', payload: { developer_instructions: '.agent-kit/kit.mjs Identidade da sessão indisponível' } })],
  ]);
  try {
    const e = linhaDe(roda(raiz).stdout, 'E');
    assert.deepEqual([e[3], e[4]], ['0', '0']);
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('--help mostra o uso e sai 0; argumento desconhecido sai 1', () => {
  const ajuda = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(ajuda.status, 0);
  assert.match(ajuda.stdout, /--claude.*--codex.*--desde/);
  const ruim = spawnSync(process.execPath, [script, '--xyz'], { encoding: 'utf8' });
  assert.equal(ruim.status, 1);
  assert.match(ruim.stderr, /Uso:/);
});
