// Diagnóstico só de leitura: confere a configuração global dos clientes contra o kit deste projeto.
// Imprime só nomes de seções, arquivos e scripts. Nunca valores de env, cabeçalhos ou argumentos.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION as githubVersion, binary as githubBinary } from './github-mcp.mjs';
import { codexCatalog } from './route-model.mjs';

const events = ['SessionStart', 'PreToolUse', 'Stop'];
// shortcut: lista fixa de skills nativas do Claude Code sem prefixo; ampliar quando outra colidir com .agents/skills.
const nativeClaudeSkills = ['code-review'];

// shortcut: compara caminhos sem diferenciar maiúsculas, como no Windows; rever se um projeto depender disso no Linux.
const norm = (value) => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const text = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const list = (value) => (Array.isArray(value) ? value : []);
const dirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

// JSON ausente devolve null; ilegível devolve null e avisa, sem repassar a mensagem do parser (ela cita o conteúdo).
function json(file, out, label) {
  const raw = text(file);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch { /* cai no aviso */ }
  out?.push({ level: 'warn', text: label + ': arquivo ' + path.basename(file) + ' ilegível; itens que dependem dele não foram conferidos.' });
  return null;
}

// shortcut: leitor de TOML por linha, só para tabelas [a.b] com chaves simples; tabela inline e chave pontilhada
// não são lidas. Trocar por um parser se o kit passar a depender de outros formatos.
// Uma linha sem comentários e sem o conteúdo de strings multilinha (""" ou '''), que são valores e nunca
// viram cabeçalho nem chave. Strings de uma linha ficam como estão; escapes contam em "" e """.
function scanLine(line, open) {
  let text = '';
  let i = 0;
  let from = -1;
  // String multilinha que abre e fecha na mesma linha vira texto de uma linha, para continuar legível como valor.
  const close = (quote) => {
    if (from >= 0) text += quote[0] + line.slice(from, i) + quote[0];
    from = -1;
  };
  const basicEnd = (from) => {
    let j = from;
    while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
    return Math.min(j, line.length - 1);
  };
  while (i < line.length) {
    if (open === '"""') {
      if (line[i] === '\\') i += 2;
      else if (line.startsWith('"""', i)) { close(open); open = null; i += 3; }
      else i += 1;
    } else if (open === "'''") {
      if (line.startsWith("'''", i)) { close(open); open = null; i += 3; } else i += 1;
    } else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      open = line.slice(i, i + 3);
      i += 3;
      from = i;
    } else if (line[i] === '#') break;
    else if (line[i] === '"') { const end = basicEnd(i + 1); text += line.slice(i, end + 1); i = end + 1; }
    else if (line[i] === "'") {
      const end = line.indexOf("'", i + 1) < 0 ? line.length - 1 : line.indexOf("'", i + 1);
      text += line.slice(i, end + 1);
      i = end + 1;
    } else { text += line[i]; i += 1; }
  }
  return { text: text.trim(), open };
}

function sections(toml) {
  const out = [];
  let current;
  let open = null;
  for (const raw of toml.split(/\r?\n/)) {
    const startedOpen = open !== null;
    const scanned = scanLine(raw, open);
    open = scanned.open;
    const header = startedOpen ? null : scanned.text.match(/^\[(.+)\]$/);
    if (header) {
      const name = header[1].trim();
      out.push(current = { name, segments: segments(name), body: [] });
    } else if (scanned.text) current?.body.push(scanned.text);
  }
  return out;
}

// Segmentos de uma chave pontilhada; pontos dentro de aspas fazem parte do nome.
function segments(name) {
  const parts = [];
  for (const [, double, single, bare] of name.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+))\s*(?:\.|$)/g)) {
    parts.push(double !== undefined ? double.replaceAll('\\\\', '\\') : single ?? bare);
  }
  return parts;
}

// Valor de uma chave de texto, com ou sem aspas, ou a lista de textos de uma chave de array numa linha só.
const stringValue = (table, key) => {
  for (const line of table.body) {
    const match = line.match(new RegExp('^' + key + '\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|\'([^\']*)\')'));
    if (match) return match[1] ?? match[2];
  }
  return undefined;
};
// Array que pode continuar nas linhas seguintes até o ']'.
const arrayValue = (table, key) => {
  const start = table.body.findIndex((item) => new RegExp('^' + key + '\\s*=\\s*\\[').test(item));
  if (start < 0) return [];
  let joined = '';
  for (const line of table.body.slice(start)) {
    joined += ' ' + line;
    if (line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').includes(']')) break;
  }
  return [...joined.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2]);
};

// Chave de tabela TOML depois do prefixo: aspas simples são literais, aspas duplas escapam a barra.
function tableKey(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const raw = name.slice(prefix.length);
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
  if (/^".*"$/.test(raw)) return raw.slice(1, -1).replaceAll('\\\\', '\\');
  return raw;
}

const value = (table, key) => table.body.map((line) => line.match(new RegExp('^' + key + '\\s*=\\s*["\']?([^"\'#\\s]+)')))
  .find(Boolean)?.[1];

// Pasta do projeto, raiz Git e worktree principal: os clientes registram confiança por uma delas.
function projectRoots(root) {
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
    return result.status === 0 ? result.stdout : null;
  };
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  const main = git(root, ['worktree', 'list', '--porcelain', '-z'])?.split('\0')[0];
  // Ordem fixa: pasta do projeto, raiz Git, worktree principal. Sem Git, a pasta se repete.
  return [root, top ?? root, main?.startsWith('worktree ') ? main.slice('worktree '.length) : top ?? root].map(norm);
}

// Um script por hook: o próprio executável, se for um script, ou o primeiro argumento que não é opção
// depois de um interpretador conhecido. Uma opção sem "=" leva junto a palavra seguinte, que pode ser o
// valor dela. Nunca repete um argumento que possa ser segredo. Chave: caminho completo normalizado.
const interpreters = /^(?:node|bun|deno|python3?|py|sh|bash|pwsh|powershell|cmd)(?:\.exe)?$/i;
const isScript = (word) => /^[\w.-]+\.(?:mjs|cjs|js|cmd|sh|ps1|py)$/.test(word.split(/[\\/]/).pop());

function scriptPaths(hooks, event) {
  const found = new Map();
  for (const entry of list(hooks?.[event])) {
    for (const hook of list(entry?.hooks)) {
      const words = [...(String(hook?.command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []), ...list(hook?.args).map(String)]
        .map((word) => word.replace(/^["']|["']$/g, ''));
      let script = words.length && isScript(words[0]) ? words[0] : null;
      if (!script && words.length && interpreters.test(words[0].split(/[\\/]/).pop())) {
        for (let i = 1; i < words.length; i += 1) {
          if (words[i].startsWith('-')) { if (!words[i].includes('=')) i += 1; continue; }
          if (isScript(words[i])) script = words[i];
          break;
        }
      }
      if (script) found.set(norm(script), script);
    }
  }
  return [...found.values()];
}

const scripts = (hooks, event) => [...new Set(scriptPaths(hooks, event).map((file) => file.split(/[\\/]/).pop()))];

// shortcut: classifica a guarda pelo texto do script, não pelo que ela faz de fato; um script que esconda
// a lógica em outro arquivo passa sem classificação. Por isso o aviso diz "parece". Comentários são ignorados,
// e a ferramenta precisa aparecer dentro de uma expressão regular, não num texto de exemplo.
const tools = '(?:jest|vitest|tsc|tsgo)';
const inRegex = new RegExp('\\/[^/\\n]*\\b' + tools + '\\b[^/\\n]*\\/[gimsuy]*\\s*\\.test\\(|(?:RegExp\\(|String\\.raw)[^\\n]*\\b' + tools + '\\b');
const guardKinds = {
  PreToolUse: [/permissionDecision/, /['"]deny['"]/, inRegex],
  Stop: [/decision['"]?\s*:\s*['"]block['"]/, /\bgit\b/, /\b(?:commit|push)\b/],
};
const guardText = {
  PreToolUse: 'parece recusar comandos de teste ou de checagem; ao validar um projeto do kit, siga a mensagem da guarda',
  Stop: 'parece impedir o fim do turno com trabalho não commitado ou não enviado; o kit não trata isso como autorização para commit',
};
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

function readScript(file) {
  try {
    const info = statSync(file);
    return info.isFile() && info.size <= 512 * 1024 ? readFileSync(file, 'utf8') : null;
  } catch { return null; }
}

function guards(client, hooks) {
  const out = [];
  for (const event of Object.keys(guardKinds)) {
    for (const file of scriptPaths(hooks, event)) {
      const source = path.isAbsolute(file) ? readScript(file) : null;
      if (source && guardKinds[event].every((pattern) => pattern.test(stripComments(source)))) {
        out.push({ level: 'warn', text: client + ': a guarda global ' + file.split(/[\\/]/).pop() + ' (' + event + ') ' + guardText[event] + '.' });
      }
    }
  }
  return out;
}

function globalHooks(client, hooks) {
  const found = events.map((event) => [event, scripts(hooks, event)]).filter(([, names]) => names.length);
  if (!found.length) return [];
  return [{ level: 'warn', text: client + ': hooks globais rodam junto com os do kit e podem recusar comandos ou bloquear o fim do turno. '
    + found.map(([event, names]) => event + ': ' + names.join(', ')).join('; ') + '.' }, ...guards(client, hooks)];
}

// Hooks que o Concord instala (concord hook ..., concord inbox ...). Sem timeout, o cliente espera o limite padrão
// (10 minutos no Claude Code e no Codex) a cada chamada quando o Concord Cloud demora; foi o caso das sessões de 15 a 17/11/2026.
// shortcut: reconhece concord, concord.cmd e concord.exe seguidos de hook ou inbox; opção antes do subcomando,
// .ps1/.bat e hook em tabela TOML inline passam sem aviso. Ampliar se o Concord passar a gravar outro formato.
const concordHook = /(?:^|[\s\\/"'])concord(?:\.cmd|\.exe)?["']?\s+(?:hook|inbox)\b/i;

const jsonHooks = (hooks) => Object.entries(hooks && typeof hooks === 'object' ? hooks : {})
  .flatMap(([event, entries]) => list(entries).flatMap((entry) => list(entry?.hooks)
    .map((hook) => ({ event, command: [hook?.command, ...list(hook?.args)].map(String).join(' '), timeout: hook?.timeout }))));

// [[hooks.<Evento>.hooks]] do config.toml: o leitor de seções guarda o nome com o colchete interno.
const tomlHooks = (tables) => tables.map((table) => [table, table.name.match(/^\[hooks\.([A-Za-z]+)\.hooks\]$/)?.[1]])
  .filter(([, event]) => event)
  .map(([table, event]) => ({ event, command: stringValue(table, 'command') ?? '', timeout: value(table, 'timeout') }));

function concordTimeouts(client, file, hooks) {
  const missing = [...new Set(hooks.filter((hook) => concordHook.test(hook.command) && !(Number(hook.timeout) > 0))
    .map((hook) => hook.event))];
  if (!missing.length) return [];
  return [{ level: 'warn', text: client + ': hooks do Concord sem timeout em ' + file + ' (' + missing.join(', ') + ').'
    + ' Com o Concord lento ou fora do ar, cada chamada pode segurar a sessão até o limite padrão do cliente (10 minutos).'
    + ' Ponha timeout de alguns segundos em cada um.' }];
}

// Pastas com SKILL.md até a profundidade dada; os plugins aninham por versão e categoria. Não desce abaixo
// de uma skill e para depois de um orçamento de pastas por raiz, marcando a busca como incompleta.
function skillNames(dir, depth, budget = 2000) {
  const names = new Set();
  let left = budget;
  const walk = (current, level) => {
    if (left-- <= 0) return;
    if (existsSync(path.join(current, 'SKILL.md'))) { names.add(path.basename(current)); return; }
    if (level > 0) for (const child of dirs(current)) walk(path.join(current, child), level - 1);
  };
  walk(dir, depth);
  names.incomplete = left < 0;
  return names;
}

const tilde = (home, dir) => '~/' + path.relative(home, dir).replaceAll('\\', '/');

// Skills do usuário entram sem prefixo e competem com as do kit; as de plugin entram com o prefixo do plugin.
function skillClashes(client, home, local, userDirs, plugins) {
  const out = [];
  for (const dir of userDirs) {
    const names = skillNames(dir, 1);
    if (names.incomplete) out.push({ level: 'warn', text: client + ': busca de skills interrompida por tamanho em ' + tilde(home, dir) + '.' });
    const same = [...names].filter((name) => local.includes(name));
    if (same.length) {
      out.push({ level: 'warn', text: client + ': skills do usuário em ' + tilde(home, dir) + ' com o mesmo nome de skills do kit: '
        + same.join(', ') + '. O cliente pode abrir a do usuário; cite o caminho .agents/skills/<nome>/SKILL.md.' });
    }
  }
  const found = plugins.map(([name, dir]) => [name, skillNames(dir, 4)]);
  const byPlugin = found.map(([name, names]) => [name, [...names].filter((skill) => local.includes(skill)).length]).filter(([, count]) => count);
  if (byPlugin.length) {
    out.push({ level: 'warn', text: client + ': plugins com skills de mesmo nome que as do kit: '
      + byPlugin.map(([name, count]) => name + ' (' + count + ')').join(', ') + '. Aparecem com o prefixo do plugin; prefira a do repositório.' });
  }
  const partial = found.filter(([, names]) => names.incomplete).map(([name]) => name);
  if (partial.length) out.push({ level: 'warn', text: client + ': busca de skills interrompida por tamanho em ' + partial.join(', ') + '.' });
  return out;
}

// Servidores MCP que abrem o Concord: pelo nome, ou pelo executável ou pacote do comando de lançamento.
// Só command e args contam; env, cabeçalhos e comentários nunca.
const concordProgram = /(?:^|[\\/@])concord-mcp(?:\.cmd|\.exe|\.m?js)?(?:@[\w.-]+)?$/i;
const opensConcord = (name, command, args = []) => name === 'concord'
  || [command, ...args].some((item) => typeof item === 'string' && concordProgram.test(item));

function skillVersions(client, versions, local) {
  if (!local || !versions.length || versions.every((version) => version === local)) return [];
  return [{ level: 'warn', text: client + ': plugin global de skills na versão ' + [...new Set(versions)].join(', ')
    + '; o kit traz ' + local + ' em .agents/skills. Prefira a cópia local ou atualize o plugin.' }];
}

const cachedVersions = (home, folder) => {
  const cache = path.join(home, folder, 'plugins', 'cache');
  return dirs(cache).flatMap((market) => dirs(path.join(cache, market, 'mattpocock-skills')));
};

function codex(root, roots, home, catalog, localSkills) {
  if (!existsSync(path.join(home, '.codex'))) return [];
  const out = [];
  const tables = sections(text(path.join(home, '.codex', 'config.toml')) ?? '');

  const projects = tables.map((table) => [tableKey(table.name, 'projects.'), value(table, 'trust_level')])
    .filter(([key]) => key !== null).map(([key, level]) => [norm(key), level]);
  const exact = projects.filter(([key]) => roots.includes(key));
  const above = projects.some(([key, level]) => level === 'trusted' && roots.some((item) => item.startsWith(key + '/')));
  if (exact.some(([, level]) => level === 'untrusted')) {
    out.push({ level: 'block', text: 'Codex: pasta do projeto marcada como não confiável; os hooks do kit não carregam.' });
  } else if (exact.some(([, level]) => level === 'trusted')) {
    out.push({ level: 'ok', text: 'Codex: pasta do projeto confiável.' });
  } else if (above) {
    out.push({ level: 'warn', text: 'Codex: só uma pasta acima do projeto é confiável; o Codex pode não estender essa confiança. Abra o projeto e confirme.' });
  } else {
    out.push({ level: 'block', text: 'Codex: pasta do projeto não é confiável; os hooks do kit não carregam. Abra o projeto no Codex e confie na pasta.' });
  }

  // Servidores de primeiro nível: [mcp_servers.<nome>], com o nome possivelmente entre aspas e com pontos.
  const servers = tables.filter((table) => table.segments.length === 2 && table.segments[0] === 'mcp_servers');
  const concord = servers.find((table) => table.segments[1] === 'concord');
  if (!concord) {
    out.push({ level: 'block', text: 'Codex: MCP Concord não encontrado em config.toml. Rode kit.mjs --client codex setup, ou confira com codex mcp get concord se o cadastro usa outro formato.' });
  } else if (value(concord, 'enabled') === 'false') {
    out.push({ level: 'block', text: 'Codex: MCP Concord desativado no cadastro global (mcp_servers.concord). Reative ou confirme que é intencional.' });
  } else out.push({ level: 'ok', text: 'Codex: MCP Concord cadastrado e ativo.' });

  const concordServers = servers
    .filter((table) => opensConcord(table.segments[1], stringValue(table, 'command'), arrayValue(table, 'args'))
      && value(table, 'enabled') !== 'false')
    .map((table) => table.segments[1]);
  if (concordServers.length > 1) {
    out.push({ level: 'warn', text: 'Codex: mais de um servidor MCP ativo abre o Concord: ' + concordServers.join(', ')
      + '. A mesma sessão pode aparecer como dois agentes; deixe só um ativo.' });
  }

  const sources = [...new Set(tables.map((table) => tableKey(table.name, 'hooks.state.'))
    .filter((key) => key !== null).map((key) => key.replace(/:[a-z_]+:\d+:\d+$/, '')))];
  const mine = roots.map((item) => item + '/.codex/hooks.json');
  // O Codex grava a aprovação pelo caminho do hooks.json: a da worktree principal não vale numa worktree.
  // Sem aprovação os hooks do projeto são pulados, inclusive em codex exec (conferido no Codex 0.167, 14/11/2026).
  const own = mine.slice(0, 2);
  if (sources.some((source) => own.includes(norm(source)))) {
    out.push({ level: 'ok', text: 'Codex: há registro de aprovação para os hooks desta pasta (o hash não é recalculado aqui; confira em /hooks depois de atualizar o kit).' });
  } else if (!own.includes(mine[2]) && sources.some((source) => norm(source) === mine[2])) {
    out.push({ level: 'warn', text: 'Codex: a aprovação gravada é a dos hooks da worktree principal (veja git worktree list); o Codex grava a aprovação pelo caminho do hooks.json, então ela não deve valer nesta worktree. Sem aprovação os hooks do kit são pulados, inclusive em codex exec: aprove em /hooks numa sessão aberta aqui.' });
  } else {
    out.push({ level: 'warn', text: 'Codex: sem registro de aprovação para os hooks do projeto; eles são pulados, inclusive em codex exec, até você aprovar em /hooks.' });
  }

  const routing = json(path.join(root, '.codex', 'model-routing.json'), out, 'Codex') ?? {};
  if (catalog === null) {
    if (Object.keys(routing).length) out.push({ level: 'warn', text: 'Codex: catálogo de modelos não consultado; roteamento não conferido.' });
  } else {
    for (const [profile, preferred] of Object.entries(routing)) {
      if (!catalog.includes(preferred?.model)) {
        // Preferência do projeto, não requisito: sem o modelo, route-model desce de nível ou herda o da sessão.
        out.push({ level: 'warn', text: 'Codex: modelo ' + String(preferred?.model) + ' do perfil ' + profile + ' não está no catálogo; route-model usa a preferência de um nível abaixo ou herda o modelo da sessão. Ajuste .codex/model-routing.json.' });
      }
    }
  }

  const globalFile = norm(path.join(home, '.codex', 'hooks.json'));
  const codexHooks = json(path.join(home, '.codex', 'hooks.json'), out, 'Codex')?.hooks;
  out.push(...globalHooks('Codex', codexHooks));
  out.push(...concordTimeouts('Codex', '~/.codex/config.toml', tomlHooks(tables)),
    ...concordTimeouts('Codex', '~/.codex/hooks.json', jsonHooks(codexHooks)));
  // Aprovações de hooks.json de outros projetos não interessam aqui; ficam config.toml e plugins.
  const others = sources.filter((source) => !mine.includes(norm(source)) && norm(source) !== globalFile)
    .map((source) => (/^[\w.-]+@[\w.-]+:/.test(source) ? source.split(':')[0] : path.basename(source)))
    .filter((source) => source !== 'hooks.json');
  if (others.length) {
    out.push({ level: 'warn', text: 'Codex: há hooks aprovados em outras fontes, não detalhados aqui: ' + [...new Set(others)].join(', ') + '.' });
  }
  out.push(...skillVersions('Codex', cachedVersions(home, '.codex'), localSkills));
  const cache = path.join(home, '.codex', 'plugins', 'cache');
  const codexPlugins = dirs(cache).flatMap((market) => dirs(path.join(cache, market)).map((name) => [name, path.join(cache, market, name)]));
  out.push(...skillClashes('Codex', home, dirs(path.join(root, '.agents', 'skills')),
    [path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')], codexPlugins));
  return out;
}

// Servidor do Concord de uma sessão do Claude: o do usuário, quando existe, senão o concord-kit do projeto.
// Um só por sessão, para não registrar dois agentes. O início da sessão e o doctor dizem o mesmo.
export function claudeConcord(root, home, roots = projectRoots(root), out = []) {
  const settings = json(path.join(home, '.claude', 'settings.json'), out, 'Claude') ?? {};
  const user = json(path.join(home, '.claude.json'), out, 'Claude') ?? {};
  // O Claude grava confiança e aprovação por caminho: a worktree principal (último item) não vale para outra worktree.
  const own = roots.slice(0, 2).map(norm);
  const entry = Object.entries(user.projects ?? {}).find(([key]) => own.includes(norm(key)))?.[1];
  const kit = json(path.join(root, '.mcp.json'), out, 'Claude')?.mcpServers?.['concord-kit'];
  const projectSettings = json(path.join(root, '.claude', 'settings.json'), out, 'Claude');
  // Aprovação e recusa dos servidores do .mcp.json valem de qualquer camada: ~/.claude.json do projeto, settings do
  // usuário e .claude/settings.json e settings.local.json do próprio projeto.
  const layers = [entry, settings, projectSettings, json(path.join(root, '.claude', 'settings.local.json'), out, 'Claude')].filter(Boolean);
  const kitDisabled = layers.some((layer) => list(layer.disabledMcpjsonServers).includes('concord-kit'));
  const kitEnabled = layers.some((layer) => list(layer.enabledMcpjsonServers).includes('concord-kit') || layer.enableAllProjectMcpServers === true);
  const servers = { ...user.mcpServers, ...entry?.mcpServers, ...settings.mcpServers };
  const concordServers = Object.entries(servers).filter(([name, server]) => name !== 'concord-kit'
    && opensConcord(name, server?.command, list(server?.args))).map(([name]) => name);
  // O concord-kit só sobe com o projeto aberto e o servidor aprovado; antes disso não há o que nomear.
  const use = concordServers[0] ?? (kit && !kitDisabled && entry && kitEnabled ? 'concord-kit' : null);
  return { settings, entry, kit, projectSettings, kitDisabled, kitEnabled, concordServers, use };
}

function claude(root, roots, home, localSkills) {
  if (!existsSync(path.join(home, '.claude'))) return [];
  const out = [];
  const { settings, entry, kit, projectSettings, kitDisabled, kitEnabled, concordServers, use } = claudeConcord(root, home, roots, out);
  // No piloto, com o Bash inteiro liberado pelo usuário, git add rodou sem pedir mesmo com regra "ask" no projeto
  // (com e sem o hook do rtk, em sessão claude -p). Só os bloqueios do projeto se mostraram confiáveis.
  const bashOpen = list(settings.permissions?.allow).some((rule) => rule === 'Bash' || rule === 'Bash(*)');
  const rewriter = list(settings.hooks?.PreToolUse).flatMap((entry) => list(entry?.hooks))
    .some((hook) => /\brtk(?:\.exe)?\s+hook\b/i.test(String(hook?.command ?? '')));
  if (bashOpen) {
    out.push({ level: 'warn', text: 'Claude: as permissões do usuário liberam o Bash inteiro; não conte com as confirmações do projeto:'
      + ' git add, commit e push crus podem rodar sem pedir. Só os bloqueios do projeto se mostraram confiáveis; use os comandos git do kit.'
      + (rewriter ? ' Um hook global (rtk) também reescreve os comandos antes da checagem.' : '') });
  }
  const kitServer = Boolean(kit);

  if (!entry) out.push({ level: 'warn', text: 'Claude: projeto ainda não aberto neste cliente; aceite a confiança da pasta e o .mcp.json na primeira sessão.' });
  else {
    out.push(entry.hasTrustDialogAccepted === true ? { level: 'ok', text: 'Claude: confiança da pasta aceita.' }
      : { level: 'block', text: 'Claude: confiança da pasta ainda não aceita; os hooks do kit não rodam em sessão interativa até aceitar.' });
  }
  // concord-kit desligado só é problema se não sobrar outro Concord; com o do usuário, é a configuração recomendada.
  if (kitServer && kitDisabled && concordServers.length) {
    out.push({ level: 'ok', text: 'Claude: concord-kit desligado neste projeto; a sessão usa o Concord do usuário (' + concordServers.join(', ') + ').' });
  } else if (kitServer && kitDisabled) {
    out.push({ level: 'block', text: 'Claude: concord-kit desligado neste projeto e nenhum outro servidor do Concord. Reative em /mcp.' });
  } else if (kitServer && entry && !kitEnabled) {
    out.push({ level: 'warn', text: 'Claude: servidor concord-kit do .mcp.json ainda não aprovado neste projeto.' });
  }

  const kitActive = kitServer && !kitDisabled;
  if (concordServers.length && kitActive) {
    out.push({ level: 'warn', text: 'Claude: há servidor do usuário que abre o Concord (' + concordServers.join(', ')
      + ') e o concord-kit do projeto. Esta sessão usa só o ' + use + ' (mcp__' + use + '__*), para não registrar dois agentes;'
      + ' desligue o concord-kit neste projeto em /mcp.' });
  } else if (concordServers.length > 1) {
    out.push({ level: 'warn', text: 'Claude: mais de um servidor do usuário abre o Concord: ' + concordServers.join(', ') + '. Deixe só um.' });
  }
  if (use) out.push({ level: 'ok', text: 'Claude: o Concord desta sessão é o servidor ' + use + ' (mcp__' + use + '__*).' });
  // Onde o node não está no PATH (ssh), o projeto põe o caminho absoluto nos hooks; o concord-kit com "node" cai.
  // shortcut: compara o texto do comando com o do primeiro hook do kit em .claude/settings.json (node e node.exe
  // diferem; settings.local.json não conta). Trocar por resolver os dois executáveis se aparecer falso aviso.
  const hookCommand = Object.values(projectSettings?.hooks ?? {}).flatMap(list).flatMap((group) => list(group?.hooks))
    .find((hook) => list(hook?.args).some((arg) => /[\\/]kit\.mjs$/.test(String(arg))))?.command;
  if (kitActive && typeof kit.command === 'string' && typeof hookCommand === 'string' && kit.command !== hookCommand) {
    out.push({ level: 'warn', text: 'Claude: o concord-kit abre com "' + kit.command + '" e os hooks do kit com "' + hookCommand
      + '". Use no .mcp.json o mesmo executável dos hooks; senão o servidor cai com CONNECTION_CLOSED onde "' + kit.command + '" não está no PATH.' });
  }
  out.push(...globalHooks('Claude', settings.hooks), ...concordTimeouts('Claude', '~/.claude/settings.json', jsonHooks(settings.hooks)));

  const installed = json(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), out, 'Claude')?.plugins ?? {};
  const active = Object.entries(installed).filter(([name]) => name.startsWith('mattpocock-skills@'))
    .flatMap(([, items]) => list(items).map((item) => String(item?.version))).filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  out.push(...skillVersions('Claude', active.length ? active : cachedVersions(home, '.claude'), localSkills));

  const claudePlugins = Object.entries(installed).flatMap(([name, items]) => list(items)
    .filter((item) => typeof item?.installPath === 'string').map((item) => [name.split('@')[0], item.installPath]));
  out.push(...skillClashes('Claude', home, dirs(path.join(root, '.agents', 'skills')),
    [path.join(home, '.claude', 'skills')], claudePlugins));

  const clash = dirs(path.join(root, '.agents', 'skills')).filter((name) => nativeClaudeSkills.includes(name));
  if (clash.length) {
    out.push({ level: 'warn', text: 'Claude: skill nativa com o mesmo nome de uma skill local: ' + clash.join(', ')
      + '. Cite o caminho .agents/skills/<nome>/SKILL.md.' });
  }
  return out;
}

function adapterStatus(adapters, present) {
  if (adapters === null) return [{ level: 'warn', text: 'Concord: estado dos adaptadores não consultado.' }];
  const out = [];
  for (const [, name, status] of adapters.matchAll(/^\s{2}(\S+)\s+(\S+)\s+\S+\s*$/gm)) {
    if (present.includes(name) && status !== 'installed') {
      out.push({ level: 'warn', text: 'Concord: adaptador ' + name + ' em ' + status + '; a entrega automática de mensagens pode não funcionar. Veja concord adapters status.' });
    }
  }
  return out;
}

// O PreToolUse do kit tem timeout de 5 s e onFailure block: passar disso recusa a edição. Metade é o sinal de folga curta.
const hookLimit = 5000;
function hookTime(ms) {
  if (ms === null) return [];
  if (ms === false) return [{ level: 'warn', text: 'Kit: o hook de edição não respondeu na medição; com onFailure block, toda edição seria recusada. Rode kit.mjs flow status.' }];
  // Medido sem escopo de sessão: com escopo declarado o hook ainda confere o snapshot Git, então é um limite inferior.
  const text = 'Kit: o hook de edição respondeu em ' + ms + ' ms, sem escopo de sessão (limite ' + hookLimit / 1000
    + ' s; ele não consulta o Concord, mas com escopo também confere o Git).';
  return [{ level: ms < hookLimit / 2 ? 'ok' : 'warn', text: ms < hookLimit / 2 ? text : text + ' Perto do limite: o cliente recusa a edição quando passa.' }];
}

// transport: null (não consultado), false (não abriu) ou o tipo de transporte que respondeu.
// hookMs: null (não medido), false (sem resposta válida) ou o tempo do hook de edição do kit.
export function diagnose({ root, home, catalog, adapters, transport = null, hookMs = null }) {
  const roots = projectRoots(root);
  const localSkills = text(path.join(root, '.agents', 'skills', 'MATTPOCOCK.md'))?.match(/versão (\d+\.\d+\.\d+)/)?.[1];
  const fromCodex = codex(root, roots, home, catalog, localSkills);
  const fromClaude = claude(root, roots, home, localSkills);
  const present = [fromCodex.length && 'codex', fromClaude.length && 'claude-code'].filter(Boolean);
  if (!present.length) return [{ level: 'warn', text: 'Nenhuma configuração global do Codex ou do Claude encontrada.' }];
  const concord = transport === null ? []
    : transport === false ? [{ level: 'block', text: 'Concord: o transporte do kit não abriu neste projeto. Rode kit.mjs concord check para ver o motivo.' }]
      : [{ level: 'ok', text: 'Concord: transporte ' + transport + ' do kit conectado.' }];
  const github = existsSync(githubBinary(home))
    ? { level: 'ok', text: 'GitHub MCP ' + githubVersion + ' instalado (servidor github-kit, só leitura).' }
    : { level: 'warn', text: 'GitHub MCP ' + githubVersion + ' não instalado; rode node .agent-kit/kit.mjs github-mcp install.' };
  return [...fromCodex, ...fromClaude, ...concord, github, ...adapterStatus(adapters, present), ...hookTime(hookMs)];
}

function main() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--offline')) {
    console.error('Use doctor [--offline].');
    process.exitCode = 1;
    return;
  }
  const offline = flags.includes('--offline');
  // Comando fixo pelo shell: no Windows o concord é um atalho .cmd.
  const run = (command) => {
    const result = spawnSync(command, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true });
    return result.status === 0 ? result.stdout : null;
  };
  const check = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('concord.mjs', import.meta.url)), 'check'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    try {
      const report = JSON.parse(result.stdout);
      return result.status === 0 && report.status === 'connected' && /^[a-z]+$/.test(report.transport) ? report.transport : false;
    } catch { return false; }
  };
  // Mede o caminho que o cliente roda numa edição: kit.mjs hook com um PreToolUse de Write. A decisão não grava nada.
  // Fica o menor de duas execuções: a primeira, a frio, pode passar da metade do limite só por antivírus ou disco.
  const measure = (root) => {
    const first = measureOnce(root);
    const second = first === false ? false : measureOnce(root);
    return second === false ? false : Math.min(first, second);
  };
  const measureOnce = (root) => {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: root, session_id: 'doctor', tool_name: 'Write',
      tool_input: { file_path: path.join(root, '.agent-flow', 'doctor-medicao.txt') } });
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, '.agent-kit', 'kit.mjs'), 'hook', 'claude'],
      { cwd: root, input, encoding: 'utf8', timeout: 2 * hookLimit, windowsHide: true });
    const ms = Date.now() - started;
    try { JSON.parse(result.stdout); } catch { return false; }
    return result.status === 0 ? ms : false;
  };
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const models = offline ? [] : codexCatalog().filter((model) => model.visibility !== 'hide');
  let items;
  try {
    items = diagnose({
      root: projectRoot,
      home: process.env.AGENT_KIT_HOME ?? homedir(),
      catalog: models.length ? models.map((model) => model.slug) : null,
      adapters: offline ? null : run('concord adapters status'),
      transport: offline ? null : check(),
      hookMs: measure(projectRoot),
    });
  } catch (error) {
    // Sem a mensagem: ela pode citar o conteúdo de um arquivo de configuração.
    console.error('Diagnóstico interrompido por ' + error.name + '. Confira o formato dos arquivos de configuração globais.');
    process.exitCode = 1;
    return;
  }
  const label = { block: 'BLOQUEIO', warn: 'AVISO', ok: 'OK' };
  for (const level of ['block', 'warn', 'ok']) {
    for (const item of items.filter((entry) => entry.level === level)) console.log(label[level] + ': ' + item.text);
  }
  if (items.some((item) => item.level === 'block')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
