// Adaptador do Antigravity CLI (agy). O agy já lê AGENTS.md e .agents/skills; aqui ficam a guarda de edição,
// traduzida para a guarda comum do kit, e os arquivos de hook e MCP que ele lê em .agents/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// O hook ouve todas as ferramentas e decide aqui: a documentação cita write_to_file e replace_file_content,
// mas a CLI 1.5.5 edita com edit_file e manda o caminho em Path. Uma ferramenta que escreve é reconhecida
// pelo nome; o caminho vem de uma destas chaves (nunca de Target, que no edit_file é o texto a trocar).
const matcher = '.*';
const knownWrites = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'write_file', 'create_file'];
const verbs = 'edit|write|create|replace|delete|remove|move|rename|patch|insert|append|overwrite|update|modify|save|apply'
  + '|copy|duplicate|mkdir|touch|download|upload|put|set';
const writeVerb = new RegExp('(?:^|_)(?:' + verbs + ')(?:_|$)');
// Nome todo em minúsculas e sem separador (writefile, multiedit, strreplace): o verbo em qualquer posição.
// put e set, curtos, só no começo: em qualquer posição pegariam output, input e reset.
const glued = new RegExp('^(?:put|set)|' + verbs.split('|').filter((verb) => verb !== 'put' && verb !== 'set').join('|'));
// Ferramentas do Concord (start_work, update_work...) não escrevem arquivo: passam mesmo com o verbo no nome.
const concordTool = /^mcp_+(?:concord|concord-kit)_+(?:start|update|finish|transfer|inspect)_work$/i;
export const acceptedKeys = 'Path, TargetFile, file_path, Destination, Dest, Target, Source ou outra chave terminada em Path'
  + ' ou File, também dentro de objetos e listas de args (texto ou lista de textos; caminho absoluto ou file://),'
  + ' com args em objeto ou em texto JSON';

// writeFile, WriteToFile e write-file viram write_file antes de procurar o verbo.
const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
export const isWriteTool = (name) => typeof name === 'string' && !concordTool.test(name)
  && (knownWrites.includes(name) || writeVerb.test(words(name)) || /^[a-z]+$/.test(name) && glued.test(name));

// Chave de destino: Path, File, Dest, Destination, Target, Source (ou plural) ou terminada em Path/File (NotebookPath,
// TargetFile, file_path). Profile e afins não entram: em camelCase o sufixo precisa começar em maiúscula.
// No edit_file, Target é o texto a trocar, não o caminho.
const isKey = (key, name) => (name !== 'edit_file' || !/^targets?$/i.test(key))
  && (/^(?:paths?|files?|dests?|destinations?|targets?|sources?)$/i.test(key) || /(?:Paths?|Files?)$/.test(key)
    || /_(?:paths?|files?)$/i.test(key));
// Chave com cara de destino que a guarda não sabe ler (OutputDir, Folder, Uri, To, NewName, FileName): a chamada
// conta como sem destino.
const looksLikeKey = (key) => /dir|folder|uri|location|output|dest|file_?name|^to$|^new_?(?:name|path)$|^name$/i.test(key);
// Chave de texto a gravar ou a trocar: um valor dela que pareça caminho não é destino.
const contentKey = /content|text|replacement|code|body|instruction|description|old|new_?string|target|message|query|command/i;
// Valor em outra chave que é caminho absoluto ou file:// também é destino. /* e // no começo são código.
const absolute = (value) => !/[\r\n]/.test(value)
  && (/^file:/i.test(value) || path.isAbsolute(value) && !/^\/[/*]/.test(value));
const asPath = (value) => {
  if (!/^file:/i.test(value)) return value;
  try { return fileURLToPath(value); } catch { return null; }
};

// Destinos da chamada, procurados também em objetos e listas aninhados, ou null quando uma chave de destino traz
// algo ilegível (a chamada conta como sem destino).
export function targetsOf(args, name) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (args === null || args === undefined) return [];
  if (typeof args !== 'object' || Array.isArray(args)) return null;
  const targets = [];
  const walk = (value, key = '') => {
    if (typeof value === 'string') {
      if (contentKey.test(key) || !absolute(value)) return true;
      const file = asPath(value);
      if (file) targets.push(file);
      return Boolean(file);
    }
    if (Array.isArray(value)) return value.every((item) => walk(item, key));
    if (value === null || typeof value !== 'object') return true;
    for (const [key, item] of Object.entries(value)) {
      if (isKey(key, name)) {
        for (const one of Array.isArray(item) ? item : [item]) {
          const file = typeof one === 'string' && one.trim() ? asPath(one) : null;
          if (!file) return false;
          targets.push(file);
        }
      } else if (looksLikeKey(key) && (typeof item === 'string' || Array.isArray(item))) return false;
      else if (!walk(item, key)) return false;
    }
    return true;
  };
  return walk(args) ? targets : null;
}

// O agy roda o hook com a pasta .agents como diretório atual e não respeita aspas no comando (conferido numa
// sessão real do agy 1.5.5). Por isso o comando é node agent-flow-hook.cjs, um script que o setup grava em .agents
// e que procura o kit só na pasta de cima dele: subir mais acharia o kit de outro projeto, com outra tarefa.
const hookScript = `// Gerado pelo Kit Universal (node .agent-kit/kit.mjs --client antigravity setup). Não edite.
// O agy roda este hook com a pasta .agents como diretório atual; o kit fica na pasta de cima.
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const kit = path.join(__dirname, '..', '.agent-kit', 'kit.mjs');
if (existsSync(kit)) {
  const child = spawnSync(process.execPath, [kit, 'hook', 'antigravity'], { stdio: 'inherit', windowsHide: true });
  process.exitCode = child.status ?? 1;
} else {
  console.log(JSON.stringify({ decision: 'deny', reason: 'Agent Flow: kit não encontrado em ' + kit
    + '. Reinstale o kit ou rode node .agent-kit/kit.mjs --client antigravity setup na raiz do projeto.' }));
}
`;
const hookCommand = 'node agent-flow-hook.cjs';
const hook160 = { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'node ../.agent-kit/kit.mjs hook antigravity', timeout: 10 }] }] };

export function projectFiles() {
  return {
    '.agents/hooks.json': { 'agent-flow': { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }] } },
    '.agents/agent-flow-hook.cjs': hookScript,
    '.agents/mcp_config.json': { mcpServers: { 'concord-kit': { command: 'node', args: ['.agent-kit/concord-mcp.mjs'] } } },
  };
}

// Entrada do agy para o formato que a guarda do kit já entende (o mesmo do Claude Code).
export function toCommon(input, file) {
  return {
    // O hooks.json só registra PreToolUse: o evento não vem da carga, que poderia trazer outro nome.
    hook_event_name: 'PreToolUse',
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

// Prazo total de 8 s para todos os destinos, abaixo dos 10 s do hook no agy.
function guard(input, file, deadline) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw Error();
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('flow.mjs', import.meta.url)), 'hook', 'antigravity'],
    { cwd: root, input: JSON.stringify(toCommon(input, file)), encoding: 'utf8', timeout, windowsHide: true });
  if (child.status !== 0) throw Error();
  return fromCommon(JSON.parse(child.stdout));
}

function hook() {
  let response;
  const deadline = Date.now() + 8000;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
    const name = input?.toolCall?.name;
    // Carga em outro formato (outra versão do agy, por exemplo) recusa tudo, para a guarda não se desligar calada.
    if (typeof name !== 'string' || !name.trim()) {
      response = { decision: 'deny', reason: 'Agent Flow: formato de hook não reconhecido (falta toolCall.name).'
        + ' Confira a versão do agy e compare .agents/hooks.json com node .agent-kit/kit.mjs antigravity-config.' };
    } else if (!isWriteTool(name)) response = { decision: 'allow' };
    else {
      const targets = targetsOf(input.toolCall.args, name);
      if (!targets?.length) {
        // Sem destino, a guarda comum decide pelo estado do fluxo: sem tarefa ativa passa, com tarefa recusa.
        response = guard(input, undefined, deadline);
        if (response.decision !== 'allow') {
          response = { decision: 'deny', reason: 'Agent Flow: não foi possível ler o destino de ' + name
            + '. A guarda lê o destino de ' + acceptedKeys + '.' };
        }
      } else {
        // Cada destino passa pela guarda; a primeira recusa vale.
        for (const file of targets) {
          response = guard(input, file, deadline);
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

// agy no PATH, com as extensões do Windows quando há PATHEXT.
function onPath(env) {
  const exts = ['', ...(env.PATHEXT ?? '').split(';').filter(Boolean)];
  return (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
    .some((dir) => exts.some((ext) => existsSync(path.join(dir, 'agy' + ext))));
}

// Linha que começa com AVISO diz o que ficou sem instalar; sem a guarda, o setup sai com código 1.
export function setup(dir = root, home = homedir(), env = process.env) {
  const lines = [];
  const compare = 'Compare com node .agent-kit/kit.mjs antigravity-config e ajuste à mão.';
  const warn = (file, problem, what) => lines.push('AVISO: ' + file + ': ' + problem + ' ' + what + ' não ficou instalad'
    + (what.startsWith('A ') ? 'a' : 'o') + '. ' + compare);
  for (const [file, data] of Object.entries(projectFiles())) {
    const target = path.join(dir, file);
    if (file.endsWith('mcp_config.json') && globalConcord(home)) {
      lines.push(file + ': não criado; o Antigravity já tem um servidor Concord do usuário. Use esse com o workspace do kit.');
      continue;
    }
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
      lines.push(file + ': criado.');
      continue;
    }
    const text = readFileSync(target, 'utf8').replace(/^﻿/, '');
    if (typeof data === 'string') {
      // O script do hook é do kit: qualquer diferença (fora o fim de linha) fica para o usuário resolver.
      if (text.replace(/\r\n/g, '\n') === data) lines.push(file + ': já atualizado.');
      else warn(file, 'já existe com outro conteúdo; não alterado.', 'A guarda de edição');
      continue;
    }
    const guardFile = file.endsWith('hooks.json');
    const [entry, what] = guardFile ? ['agent-flow', 'A guarda de edição'] : ['concord-kit', 'O Concord do kit'];
    const read = (current) => guardFile ? current?.[entry] : current?.mcpServers?.[entry];
    let current;
    try { current = JSON.parse(text); } catch { current = undefined; }
    let problem;
    if (current === undefined) problem = 'JSON inválido; não alterado.';
    else if (isDeepStrictEqual(current, data)) lines.push(file + ': já atualizado.');
    else if (isDeepStrictEqual(read(current), read(data))) lines.push(file + ': já tem a entrada ' + entry + ' do kit; o resto do arquivo é do projeto.');
    else if (read(current) === undefined) problem = 'falta a entrada ' + entry + '; não alterado.';
    else if (guardFile && JSON.stringify(read(current)).includes('replace_file_content|')) {
      problem = 'a entrada agent-flow é a do kit 0.5.0, com matcher só para três ferramentas, que deixa passar o edit_file; não alterado.';
    } else if (guardFile && isDeepStrictEqual(read(current), hook160)) {
      // A entrada da 1.6.0 guarda igual: o agy roda o hook em .agents, e de lá ../.agent-kit é o kit do projeto.
      lines.push(file + ': a entrada agent-flow é a da versão 1.6.0 do kit, que continua guardando; não alterado. ' + compare);
    } else problem = 'a entrada ' + entry + ' difere da do kit; não alterado.';
    if (problem) warn(file, problem, what);
  }
  if (!onPath(env)) lines.push('AVISO: agy não encontrado no PATH. Instale o Antigravity CLI antes de abrir o projeto com ele.');
  return lines;
}

function main([command]) {
  if (command === 'hook') hook();
  else if (command === 'setup') {
    const lines = setup();
    for (const line of lines) console.log('Antigravity: ' + line);
    if (lines.some((line) => line.includes('A guarda de edição não ficou instalada.'))) process.exitCode = 1;
  }
  else if (command === 'config') console.log(JSON.stringify(projectFiles(), null, 2));
  else {
    console.error('Use antigravity <hook|setup|config>.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
