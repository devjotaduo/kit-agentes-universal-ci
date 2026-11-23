import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { guide, sections } from './template/.codex/hooks/guide.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const tokens = (text) => Math.ceil(text.length / 4);

test('guide mostra o índice, uma etapa ou uma seção, e não o documento inteiro', () => {
  const index = guide([]);
  for (const text of ['docs/agent-flow.md', 'docs/orquestracao.md', 'docs/comunicacao.md', 'docs/concord-chamadas.md', 'Paralelismo e posse', 'tokens']) assert.ok(index.includes(text), text);
  for (const stage of ['discover', 'specify', 'slice', 'implement', 'validate', 'review', 'ready']) {
    const out = guide([stage]);
    assert.match(out, new RegExp('^\\| Etapa \\|[^\\n]*\\n\\|[ -|]+\\n\\| ' + stage + ' \\|'), stage);
    assert.ok(tokens(out) < 600, stage + ' com ' + tokens(out) + ' tokens');
  }
  // Só a linha da etapa pedida, e o comando que o papel dela usa.
  assert.doesNotMatch(guide(['implement']), /\| review \|/);
  assert.match(guide(['implement']), /flow scope --session/);
  assert.match(guide(['review']), /flow review-reference/);
  const hermes = guide(['orquestracao', 'hermes']);
  assert.match(hermes, /^## Hermes\n/);
  assert.doesNotMatch(hermes, /\n## /);
  // Título com acento e maiúscula casa sem eles; subseção de nível 3 vem junto com a seção.
  assert.match(guide(['orquestracao', 'PARALELISMO']), /^## Paralelismo e posse/);
  assert.match(guide(['comunicacao', 'evitar', 'espera']), /### Prazo para trabalho longo/);
  assert.match(guide(['orquestracao']), /^Seções de docs\/orquestracao\.md:/);
});

test('guide recusa pedido ambíguo, seção ausente e documento desconhecido dizendo o que existe', () => {
  assert.throws(() => guide(['orquestracao', 'sugestoes']), /Mais de uma seção casa[\s\S]*Sugestões e falhas do kit/);
  assert.throws(() => guide(['orquestracao', 'nao-existe']), /Nenhuma seção casa[\s\S]*Hermes/);
  assert.throws(() => guide(['segredos']), /Use guide/);
  assert.throws(() => guide(['agent-flow', 'discover']), /Para a etapa, use node \.agent-kit\/kit\.mjs guide discover/);
  // Bloco de código com "## " não vira seção; documento ausente não derruba o índice dos outros.
  assert.deepEqual(sections('# T\n\n```\n## exemplo\n```\n\n## Real').map((x) => x.title), ['Início', 'Real']);
  const semUm = guide([], (name) => { if (name === 'comunicacao') throw Error('falta'); return '# T\n\n## Uma'; });
  assert.match(semUm, /comunicacao \(docs\/comunicacao\.md ausente/);
  assert.match(semUm, /orquestracao \(docs\/orquestracao\.md, ~/);
  // Título exato vence o que só contém o termo.
  const doc = '# T\n\n## Concord\n\na\n\n## Concord e nuvem\n\nb';
  assert.equal(guide(['orquestracao', 'concord'], () => doc), '## Concord\n\na');
  assert.deepEqual(sections(doc).map((s) => s.title), ['Início', 'Concord', 'Concord e nuvem']);
});

test('papéis leem a etapa pelo guide, e o que um trabalhador e o orquestrador leem cabe na meta', () => {
  for (const pasta of ['template/.claude/agents', 'template/.codex/agents']) {
    for (const file of readdirSync(here('./' + pasta))) {
      const text = readFileSync(here('./' + pasta + '/' + file), 'utf8');
      assert.match(text, /node \.agent-kit\/kit\.mjs guide/, file);
      assert.doesNotMatch(text, /Leia [^.]*docs\/(agent-flow|orquestracao)\.md[ .,]/, file);
    }
  }
  assert.match(readFileSync(here('./template/AGENTS.md'), 'utf8'), /node \.agent-kit\/kit\.mjs guide/);
  // Trabalhador: o papel mais a sua etapa ficam abaixo de 1,5 mil tokens.
  const papel = tokens(readFileSync(here('./template/.claude/agents/flow-build.md'), 'utf8'));
  assert.ok(papel + tokens(guide(['implement'])) < 1500);
  // Orquestrador: o que o próprio papel manda ler antes de delegar fica abaixo de 10 mil (eram 18 mil com os documentos inteiros).
  const orquestrador = readFileSync(here('./template/.claude/agents/flow-orchestrator.md'), 'utf8');
  const obrigatorias = [...orquestrador.matchAll(/kit\.mjs guide ([a-z-]+) ([a-z ]+)`/g)].map((m) => [m[1], ...m[2].split(' ')]);
  assert.deepEqual(obrigatorias.map((a) => a.join(' ')), ['agent-flow inicio', 'orquestracao paralelismo', 'orquestracao aceite', 'agent-flow comandos', 'orquestracao minimo']);
  const lidas = [guide([]), ...obrigatorias.slice(0, 3).map((a) => guide(a)), readFileSync(here('./template/AGENTS.md'), 'utf8'), orquestrador];
  const total = lidas.reduce((sum, text) => sum + tokens(text), 0);
  assert.ok(total < 10000, 'orquestrador lê ' + total + ' tokens');
  console.log('orquestrador lê ' + total + ' tokens');
});

test('guide roda pelo kit num projeto instalado', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guia kit '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = (...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  assert.equal(node(here('./install.mjs'), dir).status, 0);
  const stage = node('.agent-kit/kit.mjs', 'guide', 'review');
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /\| review \| flow-review \|/);
  const missing = node('.agent-kit/kit.mjs', 'guide', 'orquestracao', 'nao-existe');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Guia: Nenhuma seção casa/);
  assert.match(node('.agent-kit/kit.mjs', 'guide', '--help').stdout, /guide <etapa>/);
});

test('instruções mandam o caminho curto em fix e maintenance, e as seções citadas existem', () => {
  const agents = readFileSync(here('./template/AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /Em todo ciclo de desenvolvimento/);
  // A primeira instrução é ler a etapa pelo guide, não abrir o fluxo inteiro.
  assert.match(agents, /Antes de uma mudança, leia a etapa em que o trabalho está com `node \.agent-kit\/kit\.mjs guide <etapa>`/);
  for (const rel of ['./template/AGENTS.md', './template/.claude/agents/flow-orchestrator.md', './template/.codex/agents/flow-orchestrator.toml']) {
    const text = readFileSync(here(rel), 'utf8');
    assert.match(text, /fix.{1,5}ou.{1,5}maintenance.{1,5}pequeno e local/, rel);
    // O caminho curto diz o que o código exige: frente só em descoberta e revisão, e os comandos do fluxo continuam.
    assert.match(text, /uma frente em descoberta e em revisão; os comandos do fluxo \(`new`, `record-parallel`, `approve`, `scope`/, rel);
    // Toda seção que as instruções citam pelo guide precisa existir, senão o agente recebe um erro no lugar da regra.
    for (const [, doc, term] of text.matchAll(/kit\.mjs guide (orquestracao|comunicacao|agent-flow|concord-chamadas) ([a-z ]+)`/g)) {
      assert.doesNotThrow(() => guide([doc, ...term.split(' ')]), rel + ': ' + doc + ' ' + term);
    }
  }
  assert.match(guide(['orquestracao', 'minimo']), /^## O mínimo para uma correção pequena/);
});
