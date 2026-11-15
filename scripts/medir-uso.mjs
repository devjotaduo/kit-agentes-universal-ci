#!/usr/bin/env node
// Ferramenta de quem mantém o kit (não vai para template/): mede, nas transcrições locais do Claude Code e do Codex,
// quantas sessões que usam o kit tiveram cada dificuldade do PLANO-USO-REAL.md. Imprime só contagens e padrões.
// Uso: node scripts/medir-uso.mjs [--claude <pasta>] [--codex <pasta>] [--desde AAAA-MM-DD]
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Sessão que usa o kit: menciona o comando, o Agent Flow ou o Agent Live fora das instruções iniciais, e não roda
// no repositório do kit nem numa worktree dele (ali o kit é lido ou desenvolvido, não usado).
const KIT = /\.agent-kit\/kit\.mjs|Agent Flow:|Agent Live:/;

// Textos novos (KIT-18) e antigos (antes dele) juntos, para comparar antes e depois.
// Fora por não terem sinal textual estável: B (start_work recusado vem do Concord, texto varia), J ("ENOENT" é genérico demais),
// D (os erros de validação do Concord, "InputValidationError" e "task not found", também aparecem em outras ferramentas e a linha do resultado não traz o nome da ferramenta), K (limite do Codex no Windows, sem mensagem do kit) e L (guarda global de worktrees, fora do kit).
const DIFICULDADES = {
  A: 'Posse ausente, expirada ou substituída|Credencial ausente: defina AGENT_FLOW_LEASE|Posse expirada em|Posse substituída:|Vínculo inválido|Credencial não corresponde a nenhuma posse deste pedido|Prazo total atingido em|O prazo total foi atingido',
  C: 'destino da edição inválido ou fora do projeto|Agent Flow: destino recusado',
  E: 'Identidade da sessão indisponível',
  F: 'HEAD ou o índice Git mudou|Evidência ausente ou alterada',
  G: 'A revisão precisa de frentes distintas|Registre as frentes independentes do Concord com record-parallel|Confirme as frentes no Concord',
  H: 'needs agent_id',
  I: 'not delivered yet',
};

function opcao(args, nome) {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

function* arquivos(pasta) {
  let itens;
  try { itens = readdirSync(pasta, { withFileTypes: true }); } catch { return; }
  for (const item of itens) {
    const caminho = join(pasta, item.name);
    if (item.isDirectory()) yield* arquivos(caminho);
    else if (item.name.endsWith('.jsonl')) yield caminho;
  }
}

// O nome do repositório no caminho cobre worktrees já apagadas (ficam em .../worktree/kit-agentes-universal/<nome>).
const doKit = (dir) => typeof dir === 'string' && (dir.split(/[\\/]/).includes('kit-agentes-universal')
  || existsSync(join(dir, 'install.mjs')) && existsSync(join(dir, 'template', '.codex', 'hooks', 'flow.mjs')));

// Suposição do Codex: as instruções iniciais (AGENTS.md incluso) vêm no `session_meta` e em mensagens `developer` ou `user`
// de `response_item`; só o resto (chamadas, resultados, respostas do agente) vale como sinal. Conferido só pela estrutura local.
const instrucao = (j) => j.type === 'session_meta' || j.type === 'turn_context' || (j.type === 'response_item' && ['developer', 'user'].includes(j.payload?.role));

// Linha a linha; linha que não é JSON é lida como texto. No máximo uma ocorrência por linha, porque o Claude repete
// o resultado da ferramenta na mesma linha.
async function medir(arquivo, regexes) {
  let kit = false, cwd;
  const sessao = {};
  const rl = createInterface({ input: createReadStream(arquivo, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const linha of rl) {
    let ignorar = false;
    if (cwd === undefined || linha.includes('"session_meta"')) {
      try {
        const j = JSON.parse(linha);
        cwd ??= j.cwd ?? j.payload?.cwd;
        ignorar = instrucao(j);
      } catch { /* texto solto */ }
    } else if (linha.includes('"response_item"') || linha.includes('"turn_context"')) {
      try { ignorar = instrucao(JSON.parse(linha)); } catch { /* texto solto */ }
    }
    if (ignorar) continue;
    if (!kit && KIT.test(linha)) kit = true;
    for (const [id, re] of regexes) if (re.test(linha)) sessao[id] = (sessao[id] ?? 0) + 1;
  }
  return { kit: kit && !doKit(cwd), sessao };
}

const args = process.argv.slice(2);
const desde = opcao(args, '--desde');
if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) { console.error('Use --desde AAAA-MM-DD com uma data válida.'); process.exit(1); }
const limite = desde ? Date.parse(desde + 'T00:00:00') : 0;
if (desde && (!Number.isFinite(limite) || new Date(limite).toLocaleDateString('sv') !== desde)) {
  console.error('Use --desde AAAA-MM-DD com uma data válida.');
  process.exit(1);
}
const pastas = [opcao(args, '--claude') ?? join(homedir(), '.claude', 'projects'), opcao(args, '--codex') ?? join(homedir(), '.codex', 'sessions')];
const regexes = Object.entries(DIFICULDADES).map(([id, p]) => [id, new RegExp(p)]);

let total = 0;
const sessoes = Object.fromEntries(regexes.map(([id]) => [id, 0]));
const ocorrencias = { ...sessoes };
for (const pasta of pastas) {
  for (const arquivo of arquivos(pasta)) {
    try { if (statSync(arquivo).mtimeMs < limite) continue; } catch { continue; }
    let r;
    try { r = await medir(arquivo, regexes); } catch { continue; }
    if (!r.kit) continue;
    total++;
    for (const [id, n] of Object.entries(r.sessao)) { sessoes[id]++; ocorrencias[id] += n; }
  }
}

const taxa = (n) => total ? (100 * n / total).toFixed(1) + '%' : '-';
console.log('| # | Padrão | Sessões com ocorrência | Sessões do kit | Taxa | Linhas com ocorrência |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const [id, p] of Object.entries(DIFICULDADES)) {
  console.log(`| ${id} | \`${p.replaceAll('|', '\\|')}\` | ${sessoes[id]} | ${total} | ${taxa(sessoes[id])} | ${ocorrencias[id]} |`);
}
console.log(`\nTotal de ocorrências: ${Object.values(ocorrencias).reduce((a, b) => a + b, 0)}`);
