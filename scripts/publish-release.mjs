import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KIT } from '../template/.codex/hooks/update.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const remote = `https://github.com/${KIT.repository}.git`;
const repo = `repos/${KIT.repository}`;
const sha = /^[a-f0-9]{40}$/;

export function publishRelease({ version, commit, pr, reviewed, visibility }, run = spawnSync) {
  if (version !== KIT.version || !sha.test(commit) || !sha.test(reviewed)
    || !/^[1-9]\d*$/.test(pr) || !['private', 'public'].includes(visibility)) {
    throw Error(`Informe a versão ${KIT.version}, os dois SHAs completos, o número do PR e private ou public.`);
  }
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const invoke = (command, args, input) => run(command, args, {
    cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, input,
  });
  const checked = (result, description) => {
    if (result.status !== 0) throw Error(`${description}. ${result.error?.message ?? result.stderr?.trim() ?? ''}`.trim());
    return result.stdout.trim();
  };
  const git = (...args) => checked(invoke('git', args), `Falha em git ${args[0]}`);
  const get = (endpoint) => JSON.parse(checked(invoke('gh', ['api', '--hostname', 'github.com', endpoint]), `Falha ao consultar ${endpoint}`));
  const release = () => {
    const result = invoke('gh', ['api', '--hostname', 'github.com', '--include', `${repo}/releases/tags/${tag}`]);
    if (result.status === 1 && /^HTTP\/\S+ 404\b/.test(result.stdout)) return null;
    const response = checked(result, `Falha ao consultar a release ${tag}`);
    const headers = /\r?\n\r?\n/.exec(response);
    if (!headers) throw Error(`Resposta HTTP inválida ao consultar ${tag}.`);
    return JSON.parse(response.slice(headers.index + headers[0].length));
  };
  const remoteTag = () => {
    const refs = new Map(git('ls-remote', remote, ref, `${ref}^{}`).split('\n').filter(Boolean)
      .map((line) => line.split(/\s+/).reverse()));
    if (!refs.has(ref)) return false;
    if (refs.get(`${ref}^{}`) !== commit) throw Error(`A tag remota ${tag} precisa ser anotada e apontar para ${commit}.`);
    return true;
  };

  if (get(repo).visibility !== visibility) throw Error(`A visibilidade de ${KIT.repository} diverge do plano (${visibility}).`);
  const pull = get(`${repo}/pulls/${pr}`);
  if (!pull.merged || pull.base?.ref !== KIT.branch || pull.merge_commit_sha !== commit || pull.head?.sha !== reviewed) {
    throw Error(`O PR #${pr} precisa ligar o commit revisado ao commit informado da ${KIT.branch}.`);
  }
  const existingTag = remoteTag();
  const existing = release();
  if (existing) {
    if (!existingTag || existing.tag_name !== tag || existing.draft !== false || existing.prerelease !== false || !existing.html_url) {
      throw Error(`A release existente para ${tag} diverge da publicação estável autorizada.`);
    }
    return existing.html_url;
  }

  if (get(`${repo}/git/ref/heads/${KIT.branch}`).object?.sha !== commit) {
    throw Error(`O commit autorizado precisa ser o HEAD remoto da ${KIT.branch} antes de publicar.`);
  }
  const { statuses } = get(`${repo}/commits/${reviewed}/status`);
  if (statuses?.find(({ context }) => context === 'ci-publico')?.state !== 'success') {
    throw Error('O commit revisado precisa do status ci-publico aprovado.');
  }
  const changelog = git('show', `${commit}:CHANGELOG.md`);
  const entry = changelog.split(/^## (?=\[\d+\.\d+\.\d+\])/m)[1];
  const [heading, ...lines] = entry?.split(/\r?\n/) ?? [];
  const notes = lines.join('\n').trim();
  if (!heading?.startsWith(`[${version}] - `) || !notes) {
    throw Error(`O CHANGELOG do commit autorizado precisa ter uma entrada para ${version} no topo.`);
  }
  if (!existingTag) {
    if (!git('tag', '--list', tag)) git('tag', '-a', tag, commit, '-m', `Kit Universal de agentes ${version}`);
    const tagObject = git('rev-parse', '--verify', ref);
    if (git('cat-file', '-t', tagObject) !== 'tag' || git('rev-parse', `${tagObject}^{commit}`) !== commit) {
      throw Error(`A tag local ${tag} precisa ser anotada e apontar para ${commit}.`);
    }
    git('push', remote, `${tagObject}:${ref}`);
  }
  if (!remoteTag()) throw Error(`A tag ${tag} ainda não foi encontrada no GitHub.`);
  return checked(invoke('gh', ['release', 'create', tag, '--repo', `github.com/${KIT.repository}`, '--verify-tag', '--latest',
    '--title', version, '--notes-file', '-'], `${notes}\n`), `Falha ao publicar ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [version, commit, pr, reviewed, visibility, ...rest] = process.argv.slice(2);
  try {
    if (rest.length) throw Error('Uso: node scripts/publish-release.mjs <versão> <commit-main> <número-PR> <commit-revisado> <private|public>');
    console.log(publishRelease({ version, commit, pr, reviewed, visibility }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
