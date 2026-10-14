import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProfiles, saveProfile } from '../src/profiles.js';
import { usageFetch, usageSummary } from '../src/usage.js';

test('local profiles support bounded edits, revision conflicts and read-only mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pistache-profile-test-'));
  try {
    writeFileSync(join(dir, 'USER.md'), 'Synthetic preferences');
    const original = listProfiles(dir, true).files.find(file => file.name === 'USER.md');
    assert.throws(() => saveProfile(dir, 'USER.md', { content: 'Changed', revision: original.revision }, false), /disabled/);
    saveProfile(dir, 'USER.md', { content: 'Changed', revision: original.revision }, true);
    assert.equal(readFileSync(join(dir, 'USER.md'), 'utf8'), 'Changed');
    assert.throws(() => saveProfile(dir, 'USER.md', { content: 'Overwrite', revision: original.revision }, true), /changed/);
    assert.throws(() => saveProfile(dir, '../secret', { content: '', revision: null }, true), /Unknown/);
    assert.throws(() => saveProfile(dir, 'profile.json', { content: 'bad json', revision: null }, true), /JSON/);
    assert.throws(() => saveProfile(dir, 'MEMORY.md', { content: 'x'.repeat(8001), revision: null }, true), /Invalid/);
    saveProfile(dir, 'MEMORY.md', { content: 'A synthetic memory', revision: null }, true);
    assert.equal(listProfiles(dir, true).files.find(file => file.name === 'MEMORY.md').exists, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('profile API refuses linked files and hides known credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pistache-profile-test-'));
  try {
    writeFileSync(join(dir, 'USER.md'), 'Synthetic-secret-value');
    const file = listProfiles(dir, true, ['Synthetic-secret-value']).files.find(file => file.name === 'USER.md');
    assert.equal(file.hidden, true); assert.equal(file.content, null); assert.equal(file.editable, false);
    assert.throws(() => saveProfile(dir, 'USER.md', { content: 'remove', revision: file.revision }, true, ['Synthetic-secret-value']), /credentials/);
    linkSync(join(dir, 'USER.md'), join(dir, 'SOUL.md'));
    assert.throws(() => listProfiles(dir, true), /Linked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stream usage preserves bytes and counts each request once without inventing prices', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [];
  const bytes = 'data: {"usage":{"cost":0.003,"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } });
  try {
    const response = await usageFetch(entries)('https://example.invalid');
    assert.equal(await response.text(), bytes);
    assert.deepEqual(usageSummary(entries), { requests: 1, prompt_tokens: 20, completion_tokens: 5, cost_usd: 0.003 });
    globalThis.fetch = async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await (await usageFetch(entries)('https://example.invalid')).text();
    assert.equal(usageSummary(entries).cost_usd, null);
  } finally { globalThis.fetch = originalFetch; }
});
