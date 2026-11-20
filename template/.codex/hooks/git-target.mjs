export const protectedBranches = ['main', 'master', 'develop', 'production', 'prod', 'release', 'staging', 'trunk'];

// Dono e nome de um remoto do GitHub, só com o host exatamente github.com, em https ou ssh.
export function repoFromRemote(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  const match = text.match(/^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9][\w.-]{0,38})\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], name: match[2], full: match[1] + '/' + match[2] } : null;
}

export function checkBranch(branch, defaultBranch) {
  if (!branch || !/^[\w./-]{1,200}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw Error('Branch atual inválida para push.');
  }
  if (!defaultBranch) throw Error('Não foi possível confirmar a branch padrão do origin. Push fica com o usuário.');
  const base = branch.toLowerCase();
  if (base === defaultBranch.toLowerCase() || protectedBranches.includes(base) || /^release\//.test(base)) {
    throw Error('A branch ' + branch + ' é a padrão ou protegida: crie uma branch de trabalho. Push nela fica com o usuário.');
  }
  return branch;
}
