// GitHub MCP oficial, só leitura: binário fixado por versão e sha256, token do gh lido na hora e nunca gravado.
// Escrita no GitHub (PR, issue, merge) continua pelos comandos do kit, que garantem rascunho e guardas.
// Só módulos do Node: a instalação copia este arquivo para a pasta do usuário, de onde Codex e Hermes o abrem.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '2.2.0';
export const SERVER = 'github-kit';
const REPO = 'github/github-mcp-server';
// github-mcp-server_2.2.0_checksums.txt do release v2.2.0, conferido ao fixar a versão. Nova versão: trocar os dois juntos.
const SHA256 = {
  'Darwin_arm64.tar.gz': '5e46b05b87989d23267f0a69ee60a3acd1de51a72512ee5fcc2786ca60c54a6a',
  'Darwin_x86_64.tar.gz': 'a42e667b99915cf368b92aa419fd2f753549ea7133cb3572a3e7f3e2d4a8675b',
  'Linux_arm64.tar.gz': 'd21e4fca8603b59d99380f1c332aaea36d73033d52b389867adf2124ee150983',
  'Linux_i386.tar.gz': '6525a290cc6925ee3254221f3fd4dd4d151eaa1243494b54345756581588397d',
  'Linux_x86_64.tar.gz': '157c5664b273e5070126d414f88cbab765630acde588f75dafdf9998c2235c51',
  'Windows_arm64.zip': '9f2941e3eee6b4f87a2e26dc5bff609a7ce5d62f82c3b337476a0ce77ce860cb',
  'Windows_i386.zip': '19e0b1683fd1951a8942e19d3151b24899744dd695e1e27535892fd5a50e6556',
  'Windows_x86_64.zip': '6ecda644e8ea54b26acbc76e80379f4afb6ac1a4c2521366584f2a7f23e3a850',
};
export const ARGS = ['stdio', '--read-only', '--toolsets', 'default,actions'];

export function asset(platform = process.platform, arch = process.arch) {
  const system = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' }[platform];
  const cpu = { x64: 'x86_64', arm64: 'arm64', ia32: 'i386' }[arch];
  const name = system + '_' + cpu + (platform === 'win32' ? '.zip' : '.tar.gz');
  if (!system || !cpu || !SHA256[name]) throw Error('Sem binário do GitHub MCP para ' + platform + '/' + arch + '.');
  return { file: 'github-mcp-server_' + name, sha256: SHA256[name] };
}

const home = () => process.env.AGENT_KIT_HOME ?? homedir();
const folder = (base) => path.join(base, '.agent-kit', 'github-mcp');
export const binary = (base = home()) => path.join(folder(base), VERSION,
  'github-mcp-server' + (process.platform === 'win32' ? '.exe' : ''));
// shortcut: um lançador por usuário, do último kit instalado; com projetos em versões diferentes vale a mais recente.
export const launcher = (base = home()) => path.join(folder(base), 'github-mcp.mjs');

async function fetchAsset(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error('Download recusado (' + response.status + '): ' + url);
  return Buffer.from(await response.arrayBuffer());
}

function extract(archive, into) {
  // O tar do Windows (bsdtar) abre zip; o do Git Bash, que pode vir antes no PATH, não.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', archive, '-C', into], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (result.status !== 0) throw Error('Não foi possível extrair ' + path.basename(archive) + ': '
    + (result.error?.message ?? result.stderr?.trim()));
}

export async function install({ base = home(), download = fetchAsset } = {}) {
  const target = binary(base);
  if (!existsSync(target)) {
    const { file, sha256 } = asset();
    const bytes = await download('https://github.com/' + REPO + '/releases/download/v' + VERSION + '/' + file);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw Error('O checksum de ' + file + ' não confere com o fixado no kit; nada foi instalado.');
    }
    mkdirSync(folder(base), { recursive: true });
    const temp = mkdtempSync(path.join(folder(base), 'baixando-'));
    try {
      writeFileSync(path.join(temp, file), bytes);
      extract(path.join(temp, file), temp);
      const extracted = path.join(temp, path.basename(target));
      if (!existsSync(extracted)) throw Error('O pacote ' + file + ' não trouxe ' + path.basename(target) + '.');
      if (process.platform !== 'win32') chmodSync(extracted, 0o755);
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(extracted, target);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  copyFileSync(fileURLToPath(import.meta.url), launcher(base));
  return target;
}

function token() {
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) return process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const value = result.status === 0 ? result.stdout.trim() : '';
  if (!value) throw Error('Sem token do GitHub para o MCP. Rode gh auth login.');
  return value;
}

export function startEnv(env, value) {
  // As GITHUB_* passam por cima da linha de comando (toolsets, ferramentas, host): só ficam as que o kit define.
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GITHUB_/i.test(name)));
  return { ...out, GITHUB_PERSONAL_ACCESS_TOKEN: value, GITHUB_READ_ONLY: '1' };
}

function start() {
  const exe = binary();
  if (!existsSync(exe)) throw Error('GitHub MCP ' + VERSION + ' não instalado. Rode node .agent-kit/kit.mjs github-mcp install.');
  const child = spawn(exe, ARGS, { env: startEnv(process.env, token()), stdio: 'inherit', windowsHide: true });
  child.once('error', (error) => {
    console.error('Não foi possível abrir o GitHub MCP: ' + error.message);
    process.exitCode = 1;
  });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
}

function registerCodex() {
  const get = spawnSync('codex', ['mcp', 'get', SERVER, '--json'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (get.error?.code === 'ENOENT') {
    console.log('Codex fora do PATH: cadastre depois com codex mcp add ' + SERVER + ' -- node "' + launcher() + '" start.');
    return;
  }
  if (get.status === 0) {
    console.log('Codex: MCP ' + SERVER + ' já cadastrado; mantido como está.');
    return;
  }
  const add = spawnSync('codex', ['mcp', 'add', SERVER, '--', process.execPath, launcher(), 'start'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: 'inherit' });
  if (add.status !== 0) throw Error('O Codex recusou o cadastro do MCP ' + SERVER + '.');
  console.log('Codex: MCP ' + SERVER + ' cadastrado; abra uma nova sessão.');
}

async function main([command, ...rest]) {
  if (command === 'install' && !rest.length) {
    console.log('GitHub MCP ' + VERSION + ' (só leitura): ' + await install());
    if (process.env.AGENT_KIT_CLIENT === 'codex') registerCodex();
    if (process.env.AGENT_KIT_CLIENT === 'hermes') console.log('Hermes: o servidor ' + SERVER + ' vem no trecho de hermes-config.');
  } else if (command === 'start' && !rest.length) start();
  else if (command === 'check' && !rest.length) {
    const ok = existsSync(binary());
    console.log(ok ? 'GitHub MCP ' + VERSION + ' instalado.' : 'GitHub MCP ' + VERSION + ' não instalado; rode github-mcp install.');
    if (!ok) process.exitCode = 1;
  } else {
    console.log('Uso: node .agent-kit/kit.mjs github-mcp install | check | start');
    if (command && !['--help', '-h'].includes(command)) process.exitCode = 1;
  }
}

// realpath dos dois lados: junção, link e nome curto do Windows mudam o argv[1], não o import.meta.url.
const self = (file) => { try { return pathToFileURL(realpathSync(file)).href; } catch { return null; } };
if (process.argv[1] && self(fileURLToPath(import.meta.url)) === self(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('GitHub MCP: ' + error.message);
    process.exitCode = 1;
  });
}
