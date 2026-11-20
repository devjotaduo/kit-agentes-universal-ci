import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const levels = ['light', 'standard', 'complex', 'critical'];
const effortOrder = ['high', 'medium', 'low'];

export function selectModel(request, profiles, catalog) {
  const index = levels.indexOf(request);
  if (index < 0) throw Error('Perfil inválido: ' + request);
  for (const profile of levels.slice(0, index + 1).reverse()) {
    const preferred = profiles[profile];
    if (!preferred || !effortOrder.includes(preferred.effort)) continue;
    const available = catalog.find((model) => model.slug === preferred.model && model.visibility !== 'hide');
    if (!available) continue;
    const supports = available.supported_reasoning_levels?.map((level) => level.effort);
    const effort = effortOrder.slice(effortOrder.indexOf(preferred.effort)).find((item) => supports?.includes(item));
    return { request, profile, model: preferred.model, ...(effort && { reasoning_effort: effort }) };
  }
  return { request, profile: 'inherit' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export function codexCatalog() {
  const cli = spawnSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (cli.status === 0) {
    try {
      const data = JSON.parse(cli.stdout);
      if (Array.isArray(data.models)) return data.models;
    } catch { /* Catalog is optional: inherit instead. */ }
  }
  return [];
}

// O que o orquestrador pode escolher agora: os modelos visíveis do catálogo e os esforços que cada um aceita.
export function available(catalog) {
  return catalog.filter((model) => model.visibility !== 'hide')
    .map((model) => ({ model: model.slug, efforts: model.supported_reasoning_levels?.map((level) => level.effort) ?? [] }));
}

function main() {
  try {
    const request = process.argv[2];
    // O kit não distribui preferências: o arquivo só existe se o projeto criou o dele.
    const file = new URL('../model-routing.json', import.meta.url);
    const profiles = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const catalog = codexCatalog();
    console.log(JSON.stringify({ ...selectModel(request, profiles, catalog), available: available(catalog) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
