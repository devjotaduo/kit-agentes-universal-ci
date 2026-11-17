import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConcordError, resolveConcord, withConcord } from './template/.codex/hooks/concord.mjs';

const wrapper = String.raw`
const readline = require('node:readline');
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const message = { jsonrpc: '2.0', id: request.id };
  if (request.params?.name === 'slow') {
    const overlap = busy;
    busy = true;
    setTimeout(() => { busy = false; message.result = { structuredContent: { overlap } }; console.log(JSON.stringify(message)); }, 30);
    return;
  }
  if (request.method === 'initialize') {
    message.result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };
  } else if (request.params.name === 'denied') {
    message.result = { isError: true, structuredContent: { error_code: 'unauthorized' } };
  } else if (request.params.name === 'invalid') {
    message.error = { code: -32602, message: 'Invalid arguments: expected string at title' };
  } else if (request.params.name === 'rejected') {
    message.error = { code: -32603, message: 'falha' };
  } else if (request.params.name === 'dropped') {
    process.exit(0);
  } else {
    message.result = { structuredContent: { cwd: process.cwd(), marker: process.env.KIT_FIXTURE_MARKER, arg: process.argv[1] } };
  }
  console.log(JSON.stringify(message));
});
`;

test('Concord transport honors configured command, arguments, cwd and environment', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kit-concord-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launch = resolveConcord({ enabled: true, transport: {
    type: 'stdio', command: process.execPath, args: ['-e', wrapper, 'custom-arg'],
    cwd: root, env: { KIT_FIXTURE_MARKER: 'custom-environment' },
  } }, process.cwd());
  const response = await withConcord(process.cwd(), (call) => call('inspect_work', {}), launch);
  assert.equal(path.resolve(response.cwd), path.resolve(root));
  assert.equal(response.arg, 'custom-arg');
  assert.equal(response.marker, 'custom-environment');
  assert.equal(JSON.stringify(launch.description).includes('custom-environment'), false);
  assert.throws(() => resolveConcord({ enabled: true, transport: { type: 'streamable_http' } }, root),
    (error) => error instanceof ConcordError && !error.retryable && /stdio/.test(error.message));
  await assert.rejects(withConcord(root, (call) => call('denied', {}), launch),
    (error) => error.code === 'unauthorized' && !error.retryable);
  // A recusa dos dados diz o campo que o Concord recusou e não manda tirar o --workspace.
  await assert.rejects(withConcord(root, (call) => call('invalid', {}), launch),
    (error) => error.code === 'protocol' && /expected string at title/.test(error.message) && /não omita --workspace/.test(error.message));
  // Chamadas pedidas juntas chegam ao servidor uma por vez, mesmo depois de uma que falhou.
  const results = await withConcord(root, (call) => Promise.all([call('rejected', {}).catch(() => null),
    call('slow', {}), call('slow', {}), call('slow', {})]), launch);
  assert.deepEqual(results.slice(1).map((result) => result.overlap), [false, false, false]);
  await assert.rejects(withConcord(root, (call) => call('dropped', {}), launch),
    (error) => error.code === 'transport' && error.retryable);
});
