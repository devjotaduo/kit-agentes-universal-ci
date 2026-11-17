import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectConcordLaunch } from '../.codex/hooks/concord.mjs';

try {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const launch = projectConcordLaunch(root, true);
  if (launch.enabledTools || launch.disabledTools) {
    throw Error('Aplique a lista de ferramentas na configuração MCP do cliente.');
  }
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd, env: launch.env, stdio: 'inherit', windowsHide: true,
  });
  child.once('error', () => {
    console.error('Não foi possível abrir o MCP Concord. Rode o setup do Kit na raiz do projeto.');
    process.exitCode = 1;
  });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
