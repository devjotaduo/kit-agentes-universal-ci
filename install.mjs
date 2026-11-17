import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const template = fileURLToPath(new URL('./template/', import.meta.url));
const manifest = '.agent-flow/install-manifest.json';
const transaction = '.agent-flow/install-transaction';
const fixedFiles = [
  '.agent-flow/.gitignore', '.codex/hooks.json', '.codex/live-policy.json', '.codex/rules/kit.rules',
  'AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json',
  '.agent-kit/kit.mjs', '.agent-kit/concord-mcp.mjs',
  'docs/agent-flow.md', 'docs/comunicacao.md', 'docs/concord-chamadas.md', 'docs/orquestracao.md',
];
// Já foram distribuídos e hoje são do projeto: saem do manifesto e continuam no disco.
const retiredFiles = ['.codex/model-routing.json'];
const hashPattern = /^[a-f0-9]{64}$/;
const hash = (bytes) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const absolute = (root, file) => path.join(root, ...file.split('/'));
const instructionFiles = new Set(['AGENTS.md', 'CLAUDE.md']);
const instructionMarker = /<!-- agent-kit:instructions-(?:begin|end)\b/g;
const instructionBlock = /^<!-- agent-kit:instructions-begin sha256=([a-f0-9]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- agent-kit:instructions-end -->(?=\r?$)/m;
const toLf = (text) => text.replaceAll('\r\n', '\n');

function entryAt(file) {
  try { return lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isSkill(file) {
  return /^\.agents\/skills\/(?:LICENSE-mattpocock|LICENSE-addyosmani|ADDYOSMANI\.md|MATTPOCOCK\.md|[a-z][a-z0-9-]*\/(?:[\w.-]+\.(?:md|sh)|agents\/[\w.-]+\.yaml|scripts\/[\w.-]+\.sh))$/.test(file);
}

function isDistributed(file) {
  return fixedFiles.includes(file) || isSkill(file)
    || /^\.codex\/agents\/flow-[a-z-]+\.toml$/.test(file)
    || /^\.claude\/agents\/flow-[a-z-]+\.md$/.test(file)
    || /^\.codex\/hooks\/[a-z-]+\.mjs$/.test(file);
}

function distribution(skillsOnly) {
  const files = new Set(skillsOnly ? ['.agent-flow/.gitignore'] : fixedFiles);
  function listSkills(dir) {
    for (const entry of readdirSync(absolute(template, dir), { withFileTypes: true })) {
      const file = dir + '/' + entry.name;
      if (entry.isDirectory() && /^\.agents\/skills\/[a-z][a-z0-9-]*(?:\/(?:agents|scripts))?$/.test(file)) {
        listSkills(file);
      } else if (isSkill(file)) files.add(file);
    }
  }
  listSkills('.agents/skills');
  if (!skillsOnly) {
    for (const folder of ['.codex/agents', '.codex/hooks', '.claude/agents']) {
      for (const name of readdirSync(absolute(template, folder))) {
        const file = folder + '/' + name;
        if (isDistributed(file)) files.add(file);
      }
    }
  }
  return [...files].sort();
}

function readSafe(root, file) {
  const segments = file.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = entryAt(current);
    if (!entry) return null;
    const last = index === segments.length - 1;
    if (entry.isSymbolicLink() || (last ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error('Caminho incompatível: ' + segments.slice(0, index + 1).join('/'));
    }
  }
  return readFileSync(current);
}

function readManifest(bytes) {
  if (bytes === null) return {};
  const data = JSON.parse(bytes.toString());
  if (data?.version !== 1 || !data.files || Array.isArray(data.files) || typeof data.files !== 'object'
    || Object.entries(data.files).some(([file, value]) => !isDistributed(file) && !retiredFiles.includes(file)
      || typeof value !== 'string' || !hashPattern.test(value))) {
    throw new Error('Manifesto de instalação inválido: ' + manifest);
  }
  return data.files;
}

function mergeInstructions(file, current, expected) {
  if (!isUtf8(current) || current.includes(0)) throw new Error('O arquivo de instruções precisa estar em UTF-8.');
  const text = current.toString('utf8');
  const content = toLf(expected.toString('utf8')).trimEnd();
  const eol = text.match(/\r?\n/)?.[0] ?? '\n';
  const block = [
    '<!-- agent-kit:instructions-begin sha256=' + hash(content) + ' -->',
    content.replaceAll('\n', eol),
    '<!-- agent-kit:instructions-end -->',
  ].join(eol);
  const markers = [...text.matchAll(instructionMarker)];
  if (!markers.length) {
    if (file === 'CLAUDE.md' && /^\uFEFF?@(?:\.\/)?AGENTS\.md[ \t]*\r?$/m.test(text)) return current;
    const separator = !text ? '' : text.endsWith(eol) ? eol : eol + eol;
    return Buffer.from(text + separator + block + eol);
  }
  const previous = text.match(instructionBlock);
  if (markers.length !== 2 || !previous
    || hash(toLf(previous[2])) !== previous[1]) {
    throw new Error('O bloco do Kit está alterado ou tem marcadores inválidos.');
  }
  return Buffer.from(text.slice(0, previous.index) + block + text.slice(previous.index + previous[0].length));
}

function installationPlan(target, skillsOnly) {
  const baseline = readSafe(target, manifest);
  const prior = readManifest(baseline);
  const next = { ...prior };
  const changes = [];
  const actions = [];
  const conflicts = [];
  for (const file of distribution(skillsOnly)) {
    const expected = readSafe(template, file);
    if (!expected) throw new Error('Arquivo de distribuição ausente: ' + file);
    const expectedHash = hash(expected);
    let current;
    try { current = readSafe(target, file); } catch (error) {
      conflicts.push(error.message);
      continue;
    }
    const currentHash = hash(current);
    const sameInstructions = current !== null && instructionFiles.has(file) && isUtf8(current)
      && toLf(current.toString('utf8')) === toLf(expected.toString('utf8'));
    if (currentHash === expectedHash || sameInstructions) {
      if (prior[file] !== currentHash) actions.push('Adotar: ' + file);
      next[file] = currentHash;
      continue;
    }
    if (currentHash === (prior[file] ?? null)) {
      actions.push((current === null ? 'Adicionar: ' : 'Atualizar: ') + file);
      changes.push({ file, before: current, after: expected });
    } else if (instructionFiles.has(file) && !prior[file]) {
      try {
        const merged = mergeInstructions(file, current, expected);
        if (!current.equals(merged)) {
          actions.push('Mesclar: ' + file);
          changes.push({ file, before: current, after: merged });
        }
      } catch (error) {
        conflicts.push(file + ' — ' + error.message);
      }
      // A merged document is project-owned. Older installers must not replace it.
      continue;
    } else {
      conflicts.push(file);
      continue;
    }
    next[file] = expectedHash;
  }
  for (const file of skillsOnly ? [] : retiredFiles.filter((name) => name in prior)) {
    let current;
    try { current = readSafe(target, file); } catch (error) {
      conflicts.push(error.message);
      continue;
    }
    // A cópia intacta do kit antigo fixava modelos; a que o projeto alterou é dele e fica como está.
    if (current !== null && hash(current) === prior[file]) {
      actions.push('Esvaziar: ' + file);
      changes.push({ file, before: current, after: Buffer.from('{}\n') });
    }
    delete next[file];
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const updated = Buffer.from(JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n');
  if (hash(baseline) !== hash(updated)) changes.push({ file: manifest, before: baseline, after: updated });
  return { actions, changes, conflicts };
}

function writeAtomic(file, bytes, journal, index) {
  const folder = path.dirname(file);
  mkdirSync(folder, { recursive: true });
  const temporary = path.join(journal, 'working-' + index);
  const previous = entryAt(temporary);
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('Arquivo temporário incompatível.');
    unlinkSync(temporary);
  }
  writeFileSync(temporary, bytes, { flag: 'wx' });
  try { renameSync(temporary, file); } finally {
    if (entryAt(temporary)) unlinkSync(temporary);
  }
}

function createTransaction(target, changes, skillsOnly) {
  const journal = absolute(target, transaction);
  mkdirSync(path.dirname(journal), { recursive: true });
  const pending = mkdtempSync(path.join(path.dirname(journal), 'install-stage-'));
  try {
    const steps = changes.map(({ file, before, after }, index) => {
      if (before !== null) writeFileSync(path.join(pending, index + '-before'), before);
      writeFileSync(path.join(pending, index + '-after'), after);
      return { file, before: hash(before), after: hash(after) };
    });
    writeFileSync(path.join(pending, 'plan.json'), JSON.stringify({ version: 1, skillsOnly, steps }));
    writeFileSync(path.join(pending, 'owner-0'), String(process.pid));
    renameSync(pending, journal);
    return { steps, skillsOnly };
  } finally {
    if (entryAt(pending)) removeJournal(pending);
  }
}

function removeJournal(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:plan\.json|owner-\d+|working-\d+|\d+-(?:before|after)|claim-[a-f0-9-]+)$/.test(entry.name)) {
      unlinkSync(path.join(dir, entry.name));
    }
  }
  rmdirSync(dir);
}

function readTransaction(target) {
  const bytes = readSafe(target, transaction + '/plan.json');
  if (bytes === null) {
    if (entryAt(absolute(target, transaction))) throw new Error('Transação de instalação sem plano.');
    return null;
  }
  const plan = JSON.parse(bytes.toString());
  if (plan?.version !== 1 || typeof plan.skillsOnly !== 'boolean' || !Array.isArray(plan.steps)
    || !plan.steps.length || new Set(plan.steps.map((step) => step?.file)).size !== plan.steps.length
    || plan.steps.some((step) => !step || typeof step.file !== 'string'
      || (!isDistributed(step.file) && !retiredFiles.includes(step.file) && step.file !== manifest)
      || (step.before !== null && (typeof step.before !== 'string' || !hashPattern.test(step.before)))
      || typeof step.after !== 'string' || !hashPattern.test(step.after))) {
    throw new Error('Plano de instalação inválido: ' + transaction);
  }
  return plan;
}

function claimTransaction(journal) {
  const current = Math.max(...readdirSync(journal).filter((name) => /^owner-\d+$/.test(name))
    .map((name) => Number(name.slice('owner-'.length))));
  if (!Number.isSafeInteger(current)) throw new Error('Transação sem registro de posse.');
  const owner = Number(readSafe(journal, 'owner-' + current)?.toString());
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Posse de instalação inválida.');
  try { process.kill(owner, 0); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    const temporary = path.join(journal, 'claim-' + randomUUID());
    writeFileSync(temporary, String(process.pid), { flag: 'wx' });
    try { linkSync(temporary, path.join(journal, 'owner-' + (current + 1))); } finally {
      unlinkSync(temporary);
    }
    return;
  }
  throw new Error('Já existe uma instalação em andamento (processo ' + owner + ').');
}

function transactionWrites(target, plan, rollback) {
  const ordered = plan.steps.map((step, index) => ({ ...step, index }));
  if (rollback) ordered.reverse();
  const conflicts = [];
  const writes = [];
  for (const step of ordered) {
    const actual = hash(readSafe(target, step.file));
    const desired = rollback ? step.before : step.after;
    if (actual === desired) continue;
    if (actual !== (rollback ? step.after : step.before)) {
      conflicts.push(step.file);
      continue;
    }
    const data = desired === null ? null : readSafe(target,
      transaction + '/' + step.index + (rollback ? '-before' : '-after'));
    if (hash(data) !== desired) throw new Error('Cópia de recuperação inválida para ' + step.file);
    writes.push({ file: step.file, index: step.index, actual, data });
  }
  if (conflicts.length) throw new Error('Arquivos alterados desde a transação; nenhuma ação aplicada:\n- ' + conflicts.join('\n- '));
  return writes;
}

function applyTransaction(target, plan, rollback) {
  const journal = absolute(target, transaction);
  for (const { file, index, actual, data } of transactionWrites(target, plan, rollback)) {
    if (hash(readSafe(target, file)) !== actual) throw new Error('Arquivo mudou durante a instalação: ' + file);
    if (data === null) unlinkSync(absolute(target, file));
    else writeAtomic(absolute(target, file), data, journal, index);
  }
  const finished = path.join(path.dirname(journal), 'install-finished-' + randomUUID());
  renameSync(journal, finished);
  removeJournal(finished);
}

function main(args) {
  const usage = 'Uso: node install.mjs [--dry-run] [--skills-only | --rollback] "<raiz do projeto existente>"';
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(usage);
    return;
  }
  const flags = args.slice(0, -1);
  const dest = args.at(-1);
  const dry = flags.includes('--dry-run');
  const skillsOnly = flags.includes('--skills-only');
  const rollback = flags.includes('--rollback');
  if (!dest || dest.startsWith('--') || flags.some((flag) => !['--dry-run', '--skills-only', '--rollback'].includes(flag))
    || new Set(flags).size !== flags.length || (skillsOnly && rollback)) throw new Error(usage);
  const target = realpathSync(dest);
  if (!lstatSync(target).isDirectory()) throw new Error('O destino deve ser uma pasta existente.');
  if (target === realpathSync(template)) throw new Error('O template do próprio kit não pode ser destino.');
  const pending = readTransaction(target);
  if (pending) {
    if (!rollback && pending.skillsOnly !== skillsOnly) {
      throw new Error('Repita o modo da instalação pendente ou use --rollback.');
    }
    console.log((rollback ? 'Reverter' : 'Retomar') + ' instalação pendente em ' + target);
    if (dry) {
      for (const step of transactionWrites(target, pending, rollback)) console.log(step.file);
      return;
    }
    claimTransaction(absolute(target, transaction));
    applyTransaction(target, pending, rollback);
    console.log(rollback ? 'Instalação pendente revertida.' : 'Instalação pendente concluída.');
    return;
  }
  if (rollback) throw new Error('Não há instalação pendente para reverter.');
  const { actions, changes, conflicts } = installationPlan(target, skillsOnly);
  console.log((dry ? 'Simulação em ' : 'Instalação em ') + target);
  if (actions.length) console.log(actions.join('\n'));
  if (conflicts.length) throw new Error(
    'Nada copiado. Integre manualmente os caminhos existentes:\n- ' + [...new Set(conflicts)].join('\n- '));
  if (!changes.length) console.log('Sem alterações.');
  else if (!dry) {
    const created = createTransaction(target, changes, skillsOnly);
    applyTransaction(target, created, false);
    console.log('Instalação concluída.');
  }
}

try { main(process.argv.slice(2)); } catch (error) {
  console.error('Agent Flow: ' + error.message);
  process.exitCode = 1;
}
