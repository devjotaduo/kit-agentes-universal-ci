// Abre uma issue de sugestão em outro repositório do mesmo dono do projeto, sobre o que o trabalho atual
// encontrou lá: uma falha, uma melhoria ou uma funcionalidade que falta. Usa as mesmas regras do feedback:
// recusa segredo e caminho pessoal e mostra issues parecidas antes de criar outra.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { worktreeEnv } from './snapshot.mjs';
import { issue, parseOptions, publish, validate } from './feedback.mjs';
import { repoFromRemote } from './git-target.mjs';
import { requireLinkedWorktree } from './worktree.mjs';

export { repoFromRemote };

const root = fileURLToPath(new URL('../../', import.meta.url));
const usage = 'Use issue <dono/repositorio> <bug|melhoria|funcionalidade> "<título>" (--body "<texto>" | --body-file <arquivo>) [--dry-run] [--force].';

// Só repositórios do mesmo dono do projeto; o nome segue o formato do GitHub e não vira opção do gh.
export function checkTarget(target, project) {
  const match = typeof target === 'string' && target.match(/^([A-Za-z0-9][\w.-]{0,38})\/([\w.-]{1,100})$/);
  if (!match || match[2].startsWith('.') || match[2].includes('..')) throw Error('Repositório inválido: use dono/repositorio do GitHub.');
  if (!project) throw Error('O projeto não tem origin no GitHub; não há dono para conferir.');
  if (match[1].toLowerCase() !== project.owner.toLowerCase()) {
    throw Error('Só repositórios de ' + project.owner + ', o dono deste projeto. Para outro dono, peça ao usuário.');
  }
  return target;
}

// O gh não pode ser redirecionado para outro repositório pelo ambiente.
const env = worktreeEnv();
delete env.GH_REPO;
delete env.GH_HOST;
const gh = (args) => spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, windowsHide: true, env });

// Dono atual de um repositório no GitHub, depois de redirecionamentos por transferência.
function canonicalOwner(repo) {
  const view = gh(['repo', 'view', repo, '--json', 'owner,hasIssuesEnabled,isArchived', '--jq', '[.owner.login, .hasIssuesEnabled, .isArchived] | @tsv']);
  if (view.status !== 0) throw Error('Não foi possível abrir ' + repo + '. Confira o nome, gh auth status e o acesso.');
  const [owner, enabled, archived] = view.stdout.trim().split('\t');
  return { owner, enabled: enabled === 'true', archived: archived === 'true' };
}

function main(args) {
  const [target, ...rest] = args;
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  const project = remote.status === 0 ? repoFromRemote(remote.stdout) : null;
  const repo = checkTarget(target, project);
  const options = parseOptions(rest, usage);
  validate(options);
  const draft = issue({ ...options, client: process.env.AGENT_KIT_CLIENT, origin: project.full });
  if (options.dryRun) {
    console.log('Repositório: ' + repo + '\nTítulo: ' + draft.title + '\n\n' + draft.body);
    return;
  }
  requireLinkedWorktree(root);
  // O nome pode ter ido para outro dono por transferência: compara os donos atuais dos dois lados.
  const here = canonicalOwner(project.full);
  const there = canonicalOwner(repo);
  if (here.owner.toLowerCase() !== there.owner.toLowerCase()) {
    throw Error(repo + ' pertence hoje a ' + there.owner + ', não a ' + here.owner + '. Para outro dono, peça ao usuário.');
  }
  if (!there.enabled || there.archived) throw Error(repo + ' não aceita issues (desativadas ou arquivado).');
  publish(repo, draft, options.title, options.force);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
