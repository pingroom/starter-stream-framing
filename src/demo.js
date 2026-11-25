import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportAnalysis } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const input = await readJson(new URL('../examples/chunks.json', import.meta.url), 65536);
for (const choice of ['u16be', 'u16le', 'u32be-total', 'unknown']) {
  const directory = await mkdtemp(join(tmpdir(), 'framing-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    assert.equal((await step(options)).status, 'pending');
    api.answer(id(1), choice); const result = await step(options);
    if (choice === 'unknown') { assert.equal(result.analysis, null); await assert.rejects(exportAnalysis(directory, input)); }
    else { const exported = await exportAnalysis(directory, input); assert.equal(exported.analysis.preset, choice); }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ choice, status: result.status, parseStatus: result.analysis?.parseStatus ?? null,
      frames: result.analysis?.frames ?? null, diagnostic: result.analysis?.diagnostic ?? null }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
