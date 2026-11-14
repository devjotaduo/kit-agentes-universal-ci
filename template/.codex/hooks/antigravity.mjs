// Adaptador do Antigravity CLI (agy). O agy já lê AGENTS.md e .agents/skills; aqui ficam a guarda de edição,
// traduzida para a guarda comum do kit, e os arquivos de hook e MCP que ele lê em .agents/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// O hook ouve todas as ferramentas e decide aqui: a documentação cita write_to_file e replace_file_content,
// mas a CLI 1.5.5 edita com edit_file e manda o caminho em Path. Uma ferramenta que escreve é reconhecida
// pelo nome; o caminho vem de uma destas chaves (nunca de Target, que no edit_file é o texto a trocar).
const matcher = '.*';
const knownWrites = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'write_file', 'create_file'];
const writeVerb = /(?:^|_)(?:edit|write|create|replace|delete|remove|move|rename|patch|insert|append|overwrite)(?:_|$)/i;
const pathKeys = /^(?:TargetFile|Path|FilePath|AbsolutePath|DestinationPath|SourcePath|NewPath|OldPath|Destination|Source)$/i;

export const isWriteTool = (name) => typeof name === 'string' && (knownWrites.includes(name) || writeVerb.test(name));

export function targetsOf(args) {
  return Object.entries(args ?? {}).filter(([key, value]) => pathKeys.test(key) && typeof value === 'string' && value.trim())
    .map(([, value]) => value);
}

// O agy roda o hook com a pasta .agents como diretório atual e não respeita aspas no comando, então o comando
// é um caminho relativo sem aspas. Se o kit sumir, o node falha e o agy trata a falha do hook como erro da
// ferramenta, que não roda (conferido numa sessão real do agy 1.5.5).
const hookCommand = 'node ../.agent-kit/kit.mjs hook antigravity';

export function projectFiles() {
  return {
    '.agents/hooks.json': { 'agent-flow': { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }] } },
    '.agents/mcp_config.json': { mcpServers: { 'concord-kit': { command: 'node', args: ['.agent-kit/concord-mcp.mjs'] } } },
  };
}

// Entrada do agy para o formato que a guarda do kit já entende (o mesmo do Claude Code).
export function toCommon(input, file = targetsOf(input?.toolCall?.args)[0]) {
  return {
    hook_event_name: input?.hookEventName ?? 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file },
    session_id: input?.conversationId,
    cwd: input?.cwd ?? input?.workspacePaths?.[0],
  };
}

// Só duas respostas da guarda comum são conhecidas: {} (sem objeção) e a recusa. Qualquer outra forma é recusa.
// Sem objeção devolve decision "allow", que pela documentação do agy segue para o próximo hook e para a
// política de permissão normal; quem aprova sozinho é "auto_approve", que o kit não usa.
export function fromCommon(output) {
  const isObject = output !== null && typeof output === 'object' && !Array.isArray(output);
  if (isObject && Object.keys(output).length === 0) return { decision: 'allow' };
  const out = isObject ? output.hookSpecificOutput : null;
  if (out?.permissionDecision === 'deny' && typeof out.permissionDecisionReason === 'string') {
    return { decision: 'deny', reason: out.permissionDecisionReason };
  }
  return { decision: 'deny', reason: 'Agent Flow: resposta inesperada da guarda do kit. Rode node .agent-kit/kit.mjs flow status.' };
}

function hook() {
  let response;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
    const name = input?.toolCall?.name;
    if (!isWriteTool(name)) response = { decision: 'allow' };
    else {
      const targets = targetsOf(input.toolCall.args);
      if (!targets.length) {
        response = { decision: 'deny', reason: 'Agent Flow: não foi possível ler o destino de ' + String(name) + '.' };
      } else {
        // Cada destino passa pela guarda; a primeira recusa vale.
        for (const file of targets) {
          const guard = spawnSync(process.execPath, [fileURLToPath(new URL('flow.mjs', import.meta.url)), 'hook', 'claude'],
            { cwd: root, input: JSON.stringify(toCommon(input, file)), encoding: 'utf8', timeout: 8000, windowsHide: true });
          if (guard.status !== 0) throw Error();
          response = fromCommon(JSON.parse(guard.stdout));
          if (response.decision !== 'allow') break;
        }
      }
    }
  } catch {
    response = { decision: 'deny', reason: 'Agent Flow: a guarda do kit falhou. Rode node .agent-kit/kit.mjs flow status.' };
  }
  console.log(JSON.stringify(response));
}

// Concord do usuário no agy: o kit não acrescenta outro servidor, para a sessão não virar dois agentes.
function globalConcord(home) {
  try {
    const servers = JSON.parse(readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers ?? {};
    return Object.entries(servers).some(([name, server]) => name === 'concord' || /concord-mcp/.test(String(server?.command)));
  } catch { return false; }
}

export function setup(dir = root, home = homedir()) {
  const lines = [];
  for (const [file, data] of Object.entries(projectFiles())) {
    const target = path.join(dir, file);
    const text = JSON.stringify(data, null, 2) + '\n';
    if (file.endsWith('mcp_config.json') && globalConcord(home)) {
      lines.push(file + ': não criado; o Antigravity já tem um servidor Concord do usuário. Use esse com o workspace do kit.');
    } else if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
      lines.push(file + ': criado.');
    } else if (readFileSync(target, 'utf8') === text) lines.push(file + ': já atualizado.');
    else lines.push(file + ': já existe com outro conteúdo; não alterado. Compare com node .agent-kit/kit.mjs antigravity-config.');
  }
  return lines;
}

function main([command]) {
  if (command === 'hook') hook();
  else if (command === 'setup') for (const line of setup()) console.log('Antigravity: ' + line);
  else if (command === 'config') console.log(JSON.stringify(projectFiles(), null, 2));
  else {
    console.error('Use antigravity <hook|setup|config>.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
