import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withProjectConcord } from './concord.mjs';
import { worktreesWith } from './snapshot.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, '.agent-flow', 'panel.html');
const refreshSeconds = 10;
// Nome original do cliente; identificadores desconhecidos aparecem como vieram.
const clients = {
  'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor', gemini: 'Gemini CLI',
  'copilot-cli': 'GitHub Copilot CLI', hermes: 'Hermes', opencode: 'OpenCode', goose: 'Goose', grok: 'Grok Build', devin: 'Devin',
};

// Resumos, mensagens e ids vêm de outros agentes: tudo passa por aqui antes de entrar na página.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
// O Concord manda data em ISO; a linha do tempo local grava milissegundos.
const time = (value) => (value ? new Date(value).getTime() : NaN);
const when = (value) => (Number.isNaN(time(value)) ? '' : new Date(value).toLocaleString('pt-BR'));
const list = (value) => (Array.isArray(value) ? value : []);

function table(head, rows, empty) {
  if (!rows.length) return '<p class="empty">' + esc(empty) + '</p>';
  return '<div class="scroll"><table><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
const badge = (text, tone) => '<span class="badge ' + tone + '">' + esc(text) + '</span>';

export function localEvents(base = path.join(root, '.agent-flow', 'live')) {
  if (!existsSync(base)) return [];
  const events = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    // Pastas com ponto são controle interno do live (registro de pedidos abertos), não linha do tempo.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const file of readdirSync(path.join(base, entry.name)).filter((name) => name.endsWith('.json'))) {
      try { events.push({ request: entry.name, ...JSON.parse(readFileSync(path.join(base, entry.name, file), 'utf8')) }); }
      catch { /* evento em escrita ou ilegível: fica fora desta leitura */ }
    }
  }
  return events;
}

// Nome que o Concord dá ao projeto nas mensagens: host/dono/repositório do remoto.
export function projectName(remote) {
  return String(remote ?? '').trim().replace(/^[a-z+]+:\/\/([^@/]*@)?/i, '').replace(/^[^@/]*@([^:/]+):/, '$1/').replace(/\.git$/i, '').replace(/\/$/, '');
}

// O MCP só entrega a caixa da própria sessão; a troca entre todos os agentes vem da CLI do Concord, que só lê.
// shortcut: o projeto é deduzido do remoto origin, sem remoto as conversas ficam fora; trocar quando o Concord expuser o nome do projeto.
export function projectMessages(dir = root) {
  const run = (name, args, shim = false, cwd = dir) => spawnSync(shim ? 'cmd.exe' : name, shim ? ['/d', '/c', name + '.cmd', ...args] : args,
    { cwd, encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const project = projectName(run('git', ['remote', 'get-url', 'origin']).stdout);
  if (!project) return { error: 'Projeto sem remoto origin: não dá para saber quais mensagens do Concord são dele.' };
  // Fora do projeto: no Windows o cmd.exe procura o .cmd primeiro na pasta atual, e um concord.cmd do repositório não deve rodar aqui.
  const cli = run('concord', ['messages', '--json', '--limit', '2000'], process.platform === 'win32', homedir());
  try {
    if (cli.status !== 0) throw Error(cli.error?.message || cli.stderr?.trim() || 'concord messages falhou.');
    const all = JSON.parse(cli.stdout);
    if (!Array.isArray(all)) throw Error('formato inesperado de concord messages --json.');
    return { messages: all.filter((message) => message?.project === project) };
  } catch (failure) { return { error: 'A CLI do Concord não listou as mensagens: ' + failure.message }; }
}

// Conversas: cada pergunta com as respostas embaixo, a conversa mais recente primeiro.
function threads(messages) {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const rootOf = (message, hops = 0) => {
    const parent = byId.get(message.replyToMessageId);
    return parent && hops < 50 ? rootOf(parent, hops + 1) : message.messageId;
  };
  const groups = new Map();
  for (const message of [...messages].sort((a, b) => (time(a.createdAt) || 0) - (time(b.createdAt) || 0))) {
    const id = rootOf(message);
    groups.set(id, [...(groups.get(id) ?? []), message]);
  }
  return [...groups.values()].sort((a, b) => (time(b.at(-1).createdAt) || 0) - (time(a.at(-1).createdAt) || 0));
}
const receipts = { sent: ['enviada', 'wait'], delivered: ['entregue', 'wait'], read: ['lida', 'on'], replied: ['respondida', 'on'], failed: ['falhou', 'warn'] };
// Pedido vencido não aguarda mais ninguém.
const waiting = (message) => message.expectsReply && !message.repliedAt && !['failed', 'replied'].includes(message.status) && !(time(message.expiresAt) < Date.now());
const clip = (text, max = 600) => (String(text ?? '').length > max ? String(text).slice(0, max) + '…' : String(text ?? ''));

function conversation(group) {
  return '<div class="thread">' + group.map((message, index) => {
    const [label, tone] = Object.hasOwn(receipts, message.status) ? receipts[message.status] : [message.status, 'off'];
    return '<div class="msg' + (index ? ' reply' : '') + '"><div class="head"><span class="id">' + esc(message.senderAgentId) + '</span> → <span class="id">'
      + esc(message.recipientAgentId) + '</span> ' + badge(label, tone) + (waiting(message) ? ' ' + badge('aguarda resposta', 'wait') : '')
      + ' <span class="muted">' + esc(when(message.createdAt)) + (message.taskId ? ' · ' + esc(message.taskId) : '') + '</span></div><p>'
      + esc(clip(message.content)) + (message.errorDetail ? ' <span class="warn">' + esc(clip(message.errorDetail, 200)) + '</span>' : '') + '</p></div>';
  }).join('') + '</div>';
}

export function render({ workspace, view, events, error, generatedAt, refresh, messages, messagesError }) {
  const reachable = new Map(list(view?.communications).map((item) => [item.agentId, item.promptable === true]));
  // O Concord devolve a presença da organização inteira; o painel é só deste projeto.
  // Até o 0.22 a presença trazia present e workspaces; o 0.23 traz liveness e não diz o projeto de cada agente.
  const scoped = list(view?.presence).some((agent) => Array.isArray(agent?.workspaces));
  const all = list(view?.presence).filter((agent) => agent && (!scoped || list(agent.workspaces).includes(workspace)))
    .map((agent) => ({ ...agent, present: agent.present ?? agent.liveness === 'live' }));
  const talks = threads(list(messages).filter(Boolean));
  const shownTalks = talks.slice(0, 30);
  const questions = list(view?.open_questions).filter(Boolean);
  const agents = all.sort((a, b) => Number(b.present) - Number(a.present) || String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, 50);
  const tasks = [
    ...list(view?.active).filter(Boolean).map((task) => [task, badge(task.status ?? 'active', 'on')]),
    ...list(view?.review_ready).filter(Boolean).map((task) => [task, badge('review_ready', 'wait')]),
    ...list(view?.stale_claims).filter(Boolean).map((task) => [task, badge('posse parada', 'warn')]),
  ];
  const activity = list(events).filter(Boolean).sort((a, b) => (time(b.at) || 0) - (time(a.at) || 0)).slice(0, 100);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="' + refreshSeconds + '">' : ''}
<title>Painel do projeto</title>
<style>
:root { --bg:#f7f7f5; --card:#fff; --text:#1c1c1a; --muted:#6b6b66; --line:#e3e3de; --on:#1a7f4b; --wait:#8a5a00; --warn:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --text:#ececea; --muted:#a0a09a; --line:#33332f; --on:#5fd39a; --wait:#f0b84a; --warn:#ff8a7a; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:16px; margin:0 0 12px; }
.meta { color:var(--muted); margin:0 0 20px; overflow-wrap:anywhere; }
.counts { display:flex; flex-wrap:wrap; gap:12px; margin:0 0 20px; padding:0; list-style:none; }
.counts li { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 16px; min-width:120px; }
.counts b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin:0 0 16px; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:13px; white-space:nowrap; }
tr:last-child td { border-bottom:0; }
td.id, .id { font-family:ui-monospace, Consolas, monospace; font-size:13px; overflow-wrap:anywhere; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid currentColor; font-size:12px; white-space:nowrap; }
.on { color:var(--on); } .wait { color:var(--wait); } .warn { color:var(--warn); } .off { color:var(--muted); }
.empty { color:var(--muted); margin:0; }
.error { border-color:var(--warn); color:var(--warn); }
.muted { color:var(--muted); font-size:13px; }
.thread { border-top:1px solid var(--line); padding:10px 0; }
.thread:first-of-type { border-top:0; padding-top:0; }
.msg p { margin:4px 0 8px; white-space:pre-wrap; overflow-wrap:anywhere; }
.msg.reply { margin-left:20px; padding-left:12px; border-left:2px solid var(--line); }
</style>
</head>
<body>
<main>
<h1>Painel do projeto</h1>
<p class="meta">${esc(workspace || 'workspace não confirmado')} · gerado em ${esc(when(generatedAt))}${refresh ? ' · atualiza a cada ' + refreshSeconds + ' s' : ''}</p>
${error ? '<section class="error">Concord não respondeu: ' + esc(error) + ' Agentes e tarefas não foram lidos; as atividades locais continuam abaixo.</section>' : ''}
<p class="meta">Mostra o Concord e a linha do tempo dos pedidos (live). A etapa do Agent Flow deste projeto não entra aqui: veja com <code>node .agent-kit/kit.mjs flow status</code>.</p>
<ul class="counts">
<li><b>${agents.filter((agent) => agent.present).length}</b>agentes presentes</li>
<li><b>${list(view?.active).length}</b>tarefas ativas</li>
<li><b>${list(view?.review_ready).length}</b>aguardando revisão</li>
<li><b>${list(view?.stale_claims).length}</b>posses paradas</li>
<li><b>${questions.length}</b>perguntas abertas</li>
<li><b>${list(messages).filter((message) => message && waiting(message)).length}</b>mensagens aguardando resposta</li>
<li><b>${list(messages).filter((message) => message?.status === 'failed').length}</b>mensagens que falharam</li>
</ul>
<section>
<h2>Agentes</h2>
${table(['Agente', 'Cliente', 'Estado', 'Recebe mensagem', 'O que está fazendo', 'Último sinal'], agents.map((agent) => [
    '<span class="id">' + esc(agent.agentId) + '</span>',
    esc(clients[agent.kind] ?? agent.kind),
    agent.present ? badge('presente', 'on') : badge('ausente', 'off'),
    reachable.get(agent.agentId) ? badge('sim', 'on') : badge('não', 'off'),
    esc(agent.summary),
    esc(when(agent.lastSeen)),
  ]), 'Nenhum agente neste projeto.')}
${all.length > agents.length ? '<p class="empty">Mais ' + (all.length - agents.length) + ' agentes ausentes não listados.</p>' : ''}
${all.length && !scoped ? '<p class="empty">Esta versão do Concord não informa o projeto de cada agente: a lista é de todos os agentes da máquina.</p>' : ''}
</section>
<section>
<h2>Conversas entre agentes</h2>
${messagesError ? '<p class="empty">' + esc(messagesError) + '</p>'
    : shownTalks.length ? shownTalks.map(conversation).join('') : '<p class="empty">Nenhuma mensagem entre agentes neste projeto.</p>'}
${talks.length > shownTalks.length ? '<p class="empty">Mais ' + (talks.length - shownTalks.length) + ' conversas antigas não listadas.</p>' : ''}
</section>
${questions.length ? '<section><h2>Perguntas abertas</h2>' + table(['Tarefa', 'Pergunta'], questions.map((question) => [
    '<span class="id">' + esc(question.taskId ?? question.task_id) + '</span>',
    esc(clip(typeof question === 'string' ? question : question.content ?? question.question ?? question.text ?? JSON.stringify(question))),
  ]), '') + '</section>' : ''}
<section>
<h2>Tarefas</h2>
${table(['Tarefa', 'Estado', 'Responsável', 'Branch', 'Atualizada'], tasks.map(([task, state]) => [
    '<span class="id">' + esc(task.taskId) + '</span>', state,
    '<span class="id">' + esc(task.agentId ?? task.assignedAgentId) + '</span>', esc(task.branch), esc(when(task.updatedAt)),
  ]), 'Nenhuma tarefa aberta.')}
</section>
<section>
<h2>Atividades</h2>
${table(['Quando', 'Pedido', 'Frente', 'Estado', 'Modelo', 'Mensagem'], activity.map((event) => [
    esc(when(event.at)), '<span class="id">' + esc(event.request) + '</span>', esc(event.task ?? event.type),
    event.state ? badge(event.state, event.state === 'blocked' || event.state === 'canceled' ? 'warn' : event.state === 'done' ? 'on' : 'wait') : '',
    esc([event.model, event.effort].filter(Boolean).join(' · ')),
    esc(event.message ?? event.owner),
  ]), 'Nenhuma atividade registrada na linha do tempo local (.agent-flow/live) desta worktree nem das outras.')}
</section>
</main>
</body>
</html>
`;
}

async function generate(refresh) {
  let workspace;
  let view;
  let error;
  try {
    view = await withProjectConcord(root, async (call, id) => {
      workspace = id;
      return call('inspect_work', { workspace_id: id });
    });
  } catch (failure) { error = failure.message; }
  // Frentes em outras worktrees gravam a linha do tempo lá: o painel junta todas.
  const live = path.join('.agent-flow', 'live');
  const events = [root, ...worktreesWith(root, live)].flatMap((dir) => localEvents(path.join(dir, live)));
  const talk = projectMessages();
  const html = render({ workspace, view, events, error, generatedAt: new Date().toISOString(), refresh, messages: talk.messages, messagesError: talk.error });
  mkdirSync(path.dirname(output), { recursive: true });
  // Troca atômica: o navegador nunca recarrega uma página pela metade.
  writeFileSync(output + '.tmp', html);
  renameSync(output + '.tmp', output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const watch = args[0] === '--watch';
    if (args.length > 1 || args.length === 1 && !watch) throw Error('Uso: panel [--watch]');
    await generate(watch);
    console.log(pathToFileURL(output).href + (watch ? '\nAtualizando a cada ' + refreshSeconds + ' s; Ctrl-C para parar.' : ''));
    while (watch) {
      await new Promise((resolve) => setTimeout(resolve, refreshSeconds * 1000));
      await generate(true);
    }
  } catch (error) {
    console.error('Painel: ' + error.message);
    process.exitCode = 1;
  }
}
