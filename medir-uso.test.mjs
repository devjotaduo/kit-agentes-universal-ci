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
const linhaDe = (saida, id) => saida.split('\n').find((l) => l.startsWith(`| ${id} |`)).split('|').map((c) => c.trim());

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
