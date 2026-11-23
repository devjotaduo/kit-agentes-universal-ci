import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Os documentos de docs/ são longos e cada agente precisa de uma parte: este comando entrega só a seção ou a etapa pedida.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = ['agent-flow', 'orquestracao', 'comunicacao', 'concord-chamadas'];
const stages = ['discover', 'specify', 'slice', 'implement', 'validate', 'review', 'ready'];
// Comando que o papel da etapa precisa e que só está na seção Comandos do fluxo.
const stageCommand = { implement: 'flow scope', review: 'flow review-reference' };
const command = 'node .agent-kit/kit.mjs guide';
// Sem acento, em minúsculas e só com letras e números: "Aceite do plano" casa com "aceite".
const plain = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// shortcut: 4 caracteres por token, só para comparar tamanhos; trocar se a ordem de grandeza passar a importar.
const tokens = (text) => Math.ceil(text.length / 4);
function fromDisk(doc) {
  try { return readFileSync(path.join(root, 'docs', doc + '.md'), 'utf8'); } catch {
    throw Error('docs/' + doc + '.md não existe neste projeto.');
  }
}

// Seções de nível 2; o texto antes da primeira fica em "Início" e as de nível 3 ficam dentro da sua seção.
export function sections(markdown) {
  const out = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('```')) fenced = !fenced;
    // "## " dentro de bloco de código é exemplo, não título.
    const title = fenced ? undefined : line.match(/^## (.+)/)?.[1];
    if (title || !out.length) out.push({ title: title ?? 'Início', lines: [] });
    out.at(-1).lines.push(line);
  }
  return out.map(({ title, lines }) => ({ title, text: lines.join('\n').trim() }));
}

// A linha da etapa na tabela de etapas do fluxo, com o cabeçalho, e o comando que o papel dela usa.
function stage(markdown, name) {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('| Etapa |'));
  const row = lines.find((line) => line.startsWith('| ' + name + ' |'));
  if (header < 0 || !row) throw Error('Etapa ' + name + ' não encontrada na tabela de etapas de docs/agent-flow.md.');
  const extra = stageCommand[name] ? lines.filter((line) => line.includes(stageCommand[name])) : [];
  return [lines[header], lines[header + 1], row, ...(extra.length ? ['', ...extra] : [])].join('\n');
}

export function guide(args, read = fromDisk) {
  const [first, ...rest] = args;
  const list = (all) => all.map((s) => '  ' + s.title + ' (~' + tokens(s.text) + ' tokens)');
  if (!first) {
    return ['Leia só o que a situação pede:', '  ' + command + ' <' + stages.join('|') + '>: uma etapa do fluxo',
      '  ' + command + ' <documento> <palavra do título>: uma seção', '',
      ...docs.flatMap((doc) => {
        // Um documento que falta não derruba o índice dos outros.
        let all;
        try { all = sections(read(doc)); } catch { return [doc + ' (docs/' + doc + '.md ausente neste projeto)', '']; }
        return [doc + ' (docs/' + doc + '.md, ~' + tokens(all.map((s) => s.text).join('\n')) + ' tokens inteiro)', ...list(all), ''];
      })].join('\n').trimEnd();
  }
  if (stages.includes(first) && !rest.length) {
    return stage(read('agent-flow'), first) + '\n\nSkills da etapa: node .agent-kit/kit.mjs skills guide ' + first
      + '. Rota, aceite do plano e os outros comandos: ' + command + ' agent-flow inicio e ' + command + ' agent-flow comandos.';
  }
  if (!docs.includes(first)) throw Error('Use guide [' + stages.join('|') + '] ou guide <' + docs.join('|') + '> [palavra do título].');
  const all = sections(read(first));
  const term = plain(rest.join(' '));
  if (!term) return 'Seções de docs/' + first + '.md:\n' + list(all).join('\n');
  const found = all.filter((s) => plain(s.title) === term);
  const match = found.length ? found : all.filter((s) => plain(s.title).includes(term));
  if (match.length !== 1) {
    throw Error((match.length ? 'Mais de uma seção casa com' : 'Nenhuma seção casa com') + ' "' + rest.join(' ') + '" em docs/' + first + '.md.'
      + (stages.includes(term) ? ' Para a etapa, use ' + command + ' ' + term + '.' : '') + ' Seções:\n' + list(all).join('\n'));
  }
  return match[0].text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(guide(process.argv.slice(2))); } catch (error) {
    console.error('Guia: ' + error.message);
    process.exitCode = 1;
  }
}
