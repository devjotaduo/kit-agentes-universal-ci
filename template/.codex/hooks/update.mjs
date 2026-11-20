// Avisa os projetos quando o repositório do kit tem uma versão mais nova que a instalada.
// O início de sessão só lê o cache local; a consulta ao GitHub roda em segundo plano, no máximo uma vez por dia.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Suba a versão a cada mudança no template que os projetos devam receber.
export const KIT = { version: '3.1.1', repository: 'devjotaduo/kit-agentes-universal', branch: 'main' };
export const CONCORD = { version: '0.23.0', package: '@concord-ai/concord-mcp' };

const day = 24 * 60 * 60 * 1000;
const root = fileURLToPath(new URL('../../', import.meta.url));
const cacheFile = (dir) => path.join(dir, '.agent-flow', 'update-check.json');
const semver = (value) => (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null);

export function newer(latest, current) {
  const [a, b] = [semver(latest), semver(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function readCache(dir) {
  try {
    const file = cacheFile(dir);
    if (!lstatSync(path.dirname(file)).isDirectory() || !lstatSync(file).isFile()) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return typeof data.checkedAt === 'number' ? data : null;
  } catch { return null; }
}

// A publicação da release confirma que a versão está disponível para instalação.
export function fetchLatest(run = spawnSync) {
  const result = run('gh', ['api', 'repos/' + KIT.repository + '/releases/latest', '--jq', '.tag_name'],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.trim().match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

// Grava o cache só dentro de uma .agent-flow real: pasta ou cache que seja link não é seguido.
// Escreve num temporário exclusivo e troca pelo nome final, que substitui um link em vez de gravar no destino dele.
export function writeCache(dir, data, file = cacheFile(dir)) {
  const folder = path.dirname(file);
  mkdirSync(folder, { recursive: true });
  if (lstatSync(folder).isSymbolicLink()) return false;
  const tmp = path.join(folder, '.' + path.basename(file, '.json') + '-' + process.pid + '-' + Date.now() + '.tmp');
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

export function refresh(dir, latest = fetchLatest(), now = Date.now()) {
  const previous = readCache(dir);
  const data = { checkedAt: now, latest: latest ?? previous?.latest ?? null, ok: latest !== null };
  writeCache(dir, data);
  return data;
}

// Trava exclusiva entre sessões: só quem cria o arquivo de trava agenda a consulta. Uma trava com mais de
// dez minutos é de uma consulta que morreu e pode ser retomada. Depois de travar, o cache é lido de novo.
const lockFile = (dir) => path.join(dir, '.agent-flow', 'update-check.lock');
const lockTtl = 10 * 60 * 1000;

export function reserve(dir, now = Date.now()) {
  const folder = path.dirname(lockFile(dir));
  mkdirSync(folder, { recursive: true });
  if (lstatSync(folder).isSymbolicLink()) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile(dir), String(now), { flag: 'wx' });
      const cache = readCache(dir);
      if (cache && now - cache.checkedAt <= day) { releaseLock(dir); return false; }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let since = 0;
      try { since = Number(readFileSync(lockFile(dir), 'utf8')) || 0; } catch { /* sumiu: tenta de novo */ }
      if (now - since <= lockTtl) return false;
      rmSync(lockFile(dir), { force: true });
    }
  }
  return false;
}

export const releaseLock = (dir) => rmSync(lockFile(dir), { force: true });

export function message(latest) {
  return 'Atualização obrigatória do Kit Universal: v' + latest + ' disponível; este projeto usa ' + KIT.version
    + '. Pause a execução e preserve o estado da tarefa. Use um checkout da tag v' + latest
    + ' e rode node <kit>/install.mjs --dry-run "<raiz do projeto>". Com o aceite vigente e a prévia conferida,'
    + ' repita sem --dry-run, recarregue a sessão e retome a tarefa registrada.';
}

export function requiredKitUpdate(dir) {
  const latest = readCache(dir)?.latest;
  return newer(latest, KIT.version) ? message(latest) : null;
}

export function concordUpdateMessage(installed, required = CONCORD.version) {
  return 'Atualização obrigatória do Concord: versão ' + installed + ', versão requerida ' + required
    + '. Pause e preserve o estado da tarefa. Confira a versão no npm oficial, atualize com npm install -g ' + CONCORD.package + '@' + required
    + ', confira concord --version e reabra a sessão para carregar o MCP atualizado.';
}

// Texto do aviso, ou null. Agenda a consulta quando o cache tem mais de um dia.
export function notice(dir, now = Date.now(), schedule = scheduleRefresh) {
  const cache = readCache(dir);
  if ((!cache || now - cache.checkedAt > day) && process.env.AGENT_KIT_NO_UPDATE_CHECK !== '1' && reserve(dir, now)) schedule(dir);
  return requiredKitUpdate(dir);
}

function scheduleRefresh(dir) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'refresh'],
    { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* consulta falhou: tenta de novo no dia seguinte */ });
  child.unref();
}

function main([command, client]) {
  if (command === 'refresh') {
    try { refresh(root); } finally { releaseLock(root); }
    return;
  }
  if (command === 'check') {
    const data = refresh(root);
    if (!data.ok) {
      console.log('Kit ' + KIT.version + '. Não foi possível consultar ' + KIT.repository + '; confira gh auth status.');
      process.exitCode = 1;
    } else console.log(newer(data.latest, KIT.version) ? message(data.latest) : 'Kit ' + KIT.version + ' está atualizado.');
    return;
  }
  if (command === 'notice' && ['claude', 'codex'].includes(client)) {
    // Hook de início de sessão: nunca falha nem atrasa a sessão.
    let text = null;
    try { text = notice(root); } catch { /* sem aviso */ }
    console.log(JSON.stringify(text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {}));
    return;
  }
  console.error('Use update <check|notice claude|notice codex>.');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
