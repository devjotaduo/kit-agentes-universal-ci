import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { realPath } from './snapshot.mjs';

export const codexReviewTag = 'agent-flow-codex-subagent:';
const threadId = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const dayMs = 24 * 60 * 60 * 1000;

function transcript(id, userHome) {
  const codex = path.join(userHome, '.codex');
  const sessions = path.join(codex, 'sessions');
  if (![codex, sessions].every((dir) => lstatSync(dir, { throwIfNoEntry: false })?.isDirectory())) {
    throw Error('Histórico local do Codex indisponível neste host.');
  }
  const base = realPath(sessions);
  const time = Number.parseInt(id.slice(0, 13).replace('-', ''), 16);
  const files = [];
  // O diretório do rollout usa a data local. O UUID v7 traz a hora UTC.
  for (const offset of [-dayMs, 0, dayMs]) {
    const date = new Date(time + offset).toISOString().slice(0, 10).split('-');
    const folder = path.join(base, ...date);
    if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() || realPath(folder) !== folder) continue;
    for (const file of readdirSync(folder, { withFileTypes: true })) {
      if (file.isFile() && file.name.startsWith('rollout-') && file.name.endsWith('-' + id + '.jsonl')) {
        files.push(path.join(folder, file.name));
      }
    }
  }
  if (files.length !== 1) throw Error('Histórico local do subagente Codex ausente ou ambíguo. Confira a thread e aguarde o fim da revisão.');
  return files[0];
}

export async function verifyCodexReview(id, { root, workspace, taskId, owner, reference, validatedAt, recordedAt },
  { parent = process.env.CODEX_THREAD_ID, userHome = userInfo().homedir } = {}) {
  const parentActor = typeof parent === 'string' && 'codex:' + createHash('sha256').update(parent).digest('hex').slice(0, 8);
  if (!threadId.test(id) || !threadId.test(parent ?? '') || id === parent || parentActor !== owner) {
    throw Error('Use a thread nativa do subagente e registre a frente na sessão Codex dona da tarefa principal.');
  }
  // O agente que registra a frente não escolhe a fonte da prova por CODEX_HOME, HOME ou USERPROFILE.
  const file = transcript(id, userHome);
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let meta;
  let answer;
  let complete;
  try {
    for await (const line of lines) {
      if (!line) continue;
      const entry = JSON.parse(line);
      const data = entry.payload;
      if (!meta) {
        const spawn = data?.source?.subagent?.thread_spawn;
        if (entry.type !== 'session_meta' || data?.id !== id || spawn?.parent_thread_id !== parent || spawn.depth !== 1
          || typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd) || realPath(data.cwd) !== realPath(root)) {
          throw Error('O histórico não comprova um subagente direto desta sessão na mesma worktree.');
        }
        if (!(Date.parse(data.timestamp) >= Date.parse(validatedAt))) {
          throw Error('Abra um subagente novo depois da validação para garantir uma revisão independente.');
        }
        meta = data;
      } else if (entry.type === 'response_item' && data?.type === 'message' && data.role === 'assistant' && data.phase === 'final_answer') {
        answer = Array.isArray(data.content) ? data.content.map((part) => part?.text ?? '').join('') : undefined;
        complete = undefined;
      } else if (entry.type === 'event_msg' && ['task_started', 'turn_aborted'].includes(data?.type)) {
        answer = undefined;
        complete = undefined;
      } else if (entry.type === 'event_msg' && data?.type === 'task_complete') {
        complete = answer && data.last_agent_message === answer ? Date.parse(entry.timestamp) : undefined;
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw Error('Histórico do subagente Codex incompleto ou ilegível. Aguarde a conclusão e tente novamente.');
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  const marker = `agent-flow-codex-review ${workspace} ${taskId} ${reference} accepted`;
  if (!(complete >= Date.parse(meta?.timestamp) && complete <= Date.parse(recordedAt))
    || answer?.trimEnd().split(/\r?\n/).at(-1) !== marker) {
    throw Error('O parecer final do subagente não comprova aceite para esta frente, workspace e conteúdo validado antes do registro no Concord.');
  }
  return { reviewer: id, source: 'codex-subagent', recordedBy: owner };
}
