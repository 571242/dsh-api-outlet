import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAdmin } from '../lib/admin.js';
import { normalizeConfig } from '../lib/config.js';
import { createGateway } from '../lib/gateway.js';
import { StateStore } from '../lib/keys.js';

const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url)).replace(/\/$/, '');
const defaults = { allowedProviders: null, allowedModels: null };
const zero = { requests: 0, failedRequests: 0, unknownUsageRequests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 };
const rawUsage = { inputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 5, totalTokens: 97 };
const metrics = { ...zero, requests: 1, ...rawUsage };
const badSettings = error => error.status === 400 && error.code === 'invalid_settings';

async function stateFixture(t, legacy) {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'access-usage-'));
  const path = join(dir, 'state.json');
  if (legacy) await writeFile(path, '\uFEFF' + JSON.stringify(legacy));
  const store = await new StateStore(path).load();
  t.after(async () => {
    await store.flushed().catch(() => {});
    assert.equal(dirname(dir), scratch);
    assert.ok(basename(dir).startsWith('access-usage-'));
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

async function serve(t, handler) {
  const pending = [];
  const server = createServer((req, res) => { pending.push(handler(req, res)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await Promise.allSettled(pending);
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, settled: () => Promise.all(pending) };
}

async function fixture(t, options = {}) {
  const store = await stateFixture(t);
  const client = await store.createClient('downstream');
  const calls = []; const warnings = [];
  let usage = Object.hasOwn(options, 'usage') ? options.usage : rawUsage;
  const cfg = normalizeConfig({
    requestsPerMinute: 1000,
    aliases: { quick: 'demo/reasoner@high', base: 'demo/reasoner', blocked: 'other/reasoner@high', plain: 'demo/plain' },
    ...options.cfg,
  });
  const llm = {
    listProviders: async () => [{ id: 'demo' }, { id: 'other' }, { id: 'empty' }],
    listModels: async provider => provider === 'empty' ? [] : [
      { id: 'reasoner', name: 'Reasoner', inputModalities: ['text'] },
      { id: 'plain', name: 'Plain' },
    ],
    resolveModelInfo: async (provider, model) => ({
      ...(model === 'reasoner' ? { reasoning: { efforts: ['low', 'high'].map(id => ({ id })), defaultEffort: 'low' } } : {}),
    }),
    prepareCall: async config => {
      calls.push(config);
      const currentUsage = usage;
      return { config, stream: options.source ?? (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' };
        if (currentUsage !== undefined) yield { type: 'usage', usage: currentUsage };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }) };
    },
  };
  const ctx = { logger: { warn: message => warnings.push(message) } };
  const gateway = createGateway({ llm, ctx, store, cfg });
  t.after(() => gateway.dispose());
  const server = await serve(t, gateway.handler);
  const headers = { authorization: `Bearer ${client.key}`, 'content-type': 'application/json' };
  const payload = (protocol, extra = {}) => ({ model: 'demo/reasoner', ...(protocol === 'chat' ? { messages: [{ role: 'user', content: 'hello' }] } : { input: 'hello' }), ...extra });
  const path = protocol => protocol === 'chat' ? '/v1/chat/completions' : '/v1/responses';
  const post = async (protocol, extra = {}, key = client.key) => {
    const response = await fetch(server.url + path(protocol), {
      method: 'POST', headers: { ...headers, authorization: `Bearer ${key}` }, body: JSON.stringify(payload(protocol, extra)),
    });
    const text = await response.text();
    await server.settled();
    return { status: response.status, text, body: extra.stream ? text : JSON.parse(text) };
  };
  return { ...server, store, client, calls, warnings, cfg, llm, gateway, headers, payload, path, post, setUsage: value => { usage = value; } };
}

test('old state migrates with open defaults, stable since, BOM support and private permissions', async t => {
  const key = 'sk-outlet-' + 'a'.repeat(32);
  const adminToken = 'oadmin-' + 'b'.repeat(32);
  const id = randomUUID();
  const store = await stateFixture(t, { version: 1, revision: 10, adminToken, clients: [{
    id, label: 'legacy', digest: createHash('sha256').update(key).digest('hex'), createdAt: new Date().toISOString(), lastUsedAt: null,
  }] });
  assert.deepEqual(store.getSettings(), defaults);
  assert.deepEqual(store.getUsage().totals, zero);
  assert.deepEqual(store.getUsage().clients, [{ id, label: 'legacy', revoked: false, ...zero }]);
  assert.equal(store.lookup(key).id, id);
  assert.equal(store.checkAdmin(adminToken), true);
  await store.flushed();
  const reopened = await new StateStore(store.stateFile).load();
  assert.deepEqual(reopened.getUsage(), store.getUsage());
  assert.deepEqual(reopened.getSettings(), defaults);
  assert.equal((await stat(store.stateFile)).mode & 0o777, 0o600);
});

test('settings preserve explicit empty lists and reject malformed updates without mutation', async t => {
  const store = await stateFixture(t);
  const input = { allowedProviders: ['demo'], allowedModels: [] };
  const saving = store.updateSettings(input);
  input.allowedProviders.push('other');
  const saved = await saving;
  assert.deepEqual(saved, { allowedProviders: ['demo'], allowedModels: [] });
  saved.allowedProviders.push('changed');
  store.getSettings().allowedModels.push('changed');
  const expected = { allowedProviders: ['demo'], allowedModels: [] };
  assert.deepEqual(store.getSettings(), expected);
  for (const invalid of [null, [], true, 'all', new Date(), { extra: [] }, { adminToken: 'no' },
    { allowedProviders: undefined }, { allowedModels: {} }, { allowedModels: [null] }, { allowedModels: Array(1) }, { allowedProviders: [''] },
    { allowedProviders: [' demo'] }, { allowedProviders: ['a\nb'] }, { allowedModels: ['demo/plain', 'demo/plain'] }]) {
    await assert.rejects(store.updateSettings(invalid), badSettings);
    assert.deepEqual(store.getSettings(), expected);
  }
  const reopened = await new StateStore(store.stateFile).load();
  assert.deepEqual(reopened.getSettings(), expected);
  assert.deepEqual(await store.updateSettings({ allowedModels: null }), { allowedProviders: ['demo'], allowedModels: null });
});

test('usage uses upstream total, known partial sums and distinguishes missing from reported zero', async t => {
  const store = await stateFixture(t);
  const client = await store.createClient('usage client');
  await store.recordUsage({ clientId: client.id, usage: rawUsage });
  await store.recordUsage({ clientId: client.id, usage: { outputTokens: 4 } });
  await store.recordUsage({ clientId: client.id, failed: true });
  await store.recordUsage({ clientId: client.id, usage: {} });
  await store.recordUsage({ clientId: client.id, usage: { totalTokens: 0 } });
  await store.recordUsage({ clientId: client.id, usage: { inputTokens: -1, totalTokens: '8' } });
  const expected = { ...rawUsage, requests: 6, failedRequests: 1, unknownUsageRequests: 3, outputTokens: 9, totalTokens: 101 };
  assert.deepEqual(store.getUsage().totals, expected);
  assert.deepEqual(store.getUsage().clients, [{ id: client.id, label: client.label, revoked: false, ...expected }]);
  const view = store.getUsage();
  view.clients[0].totalTokens = -1;
  view.totals.totalTokens = -1;
  assert.deepEqual(store.getUsage().totals, expected);
  const reopened = await new StateStore(store.stateFile).load();
  assert.deepEqual(reopened.getUsage(), store.getUsage());
});

test('serialized usage/settings writes cannot resurrect revoked or rotated keys', async t => {
  const store = await stateFixture(t);
  const old = await store.createClient('revoked history');
  const rotated = await store.createClient('rotated');
  const unused = await store.createClient('unused revoked');
  const writes = [store.recordUsage({ clientId: old.id, usage: rawUsage })];
  store.lookup(old.key);
  writes.push(store.rotateClient(old.id), store.updateSettings({ allowedProviders: [] }), store.revokeClient(old.id));
  writes.push(store.recordUsage({ clientId: old.id, usage: { outputTokens: 7 }, failed: true }));
  const rotate = store.rotateClient(rotated.id);
  for (let i = 0; i < 10; i++) writes.push(store.recordUsage({ clientId: rotated.id, usage: { totalTokens: 2 } }));
  writes.push(store.revokeClient(unused.id));
  const creating = store.createClient('new client');
  await Promise.all(writes);
  const [newKey, newClient] = await Promise.all([rotate, creating]);
  await store.flushed();
  const reopened = await new StateStore(store.stateFile).load();
  assert.equal(reopened.lookup(old.key), undefined);
  assert.equal(reopened.lookup(rotated.key), undefined);
  assert.equal(reopened.lookup(newKey.key).id, rotated.id);
  assert.equal(reopened.lookup(newClient.key).id, newClient.id);
  assert.equal(reopened.clientCount(), 2);
  assert.deepEqual(reopened.getSettings(), { allowedProviders: [], allowedModels: null });
  const usage = reopened.getUsage();
  assert.deepEqual(usage.clients.find(c => c.id === old.id), { id: old.id, label: old.label, revoked: true,
    ...rawUsage, requests: 2, failedRequests: 1, unknownUsageRequests: 0, outputTokens: 12, totalTokens: 104 });
  assert.deepEqual(usage.clients.find(c => c.id === unused.id), { id: unused.id, label: unused.label, revoked: true, ...zero });
  assert.equal(usage.totals.totalTokens, 124);
  assert.equal(usage.totals.requests, 12);
  assert.equal(JSON.stringify(usage).includes('digest'), false);
  assert.equal(JSON.stringify(usage).includes('adminToken'), false);
  assert.equal(JSON.stringify(usage).includes(old.key), false);
  await reopened.flushed();
});

test('a failed persist does not poison later key or usage writes', async t => {
  const store = await stateFixture(t);
  const client = await store.createClient('recover');
  const original = store.stateFile;
  store.stateFile = join(original, 'not-a-directory');
  await assert.rejects(store.recordUsage({ clientId: client.id, usage: rawUsage }));
  store.stateFile = original;
  const rotated = await store.rotateClient(client.id);
  const reopened = await new StateStore(original).load();
  assert.equal(reopened.lookup(client.key), undefined);
  assert.equal(reopened.lookup(rotated.key).id, client.id);
  assert.deepEqual(reopened.getUsage().totals, metrics);
  await reopened.flushed();
});

test('catalog stays unfiltered with reasoning metadata while models uses live selection', async t => {
  const f = await fixture(t);
  const catalog = await f.gateway.catalog();
  assert.equal(await f.gateway.models(), catalog);
  assert.deepEqual(catalog[0].reasoning_efforts, ['low', 'high']);
  assert.equal(catalog[0].default_reasoning_effort, 'low');
  assert.equal(catalog[2].base_model, 'demo/reasoner');
  await f.gateway.updateSettings({ allowedProviders: [] });
  assert.deepEqual(await f.gateway.models(), []);
  assert.equal(await f.gateway.catalog(), catalog);
  await f.gateway.updateSettings({ allowedProviders: ['demo'], allowedModels: ['demo/reasoner'] });
  assert.deepEqual((await f.gateway.models()).map(m => m.id), ['demo/reasoner', 'demo/reasoner@low', 'demo/reasoner@high']);
  await f.gateway.updateSettings({ allowedProviders: ['empty'], allowedModels: null });
  assert.deepEqual(await f.gateway.models(), []);
});

for (const protocol of ['chat', 'responses']) {
  test(`${protocol}: raw ids, variants and aliases all obey provider/model intersection`, async t => {
    const f = await fixture(t);
    await f.gateway.updateSettings({ allowedProviders: ['demo'], allowedModels: ['demo/reasoner'] });
    for (const model of ['demo/reasoner', 'demo/reasoner@high', 'base', 'quick']) {
      assert.equal((await f.post(protocol, { model })).status, 200);
      assert.equal(f.calls.at(-1).provider, 'demo');
      assert.equal(f.calls.at(-1).model, 'reasoner');
    }
    for (const model of ['other/reasoner', 'other/reasoner@high', 'blocked', 'demo/plain', 'plain']) {
      const before = f.calls.length;
      assert.equal((await f.post(protocol, { model })).status, 404);
      assert.equal(f.calls.length, before);
    }
    await f.gateway.updateSettings({ allowedProviders: ['other'] });
    assert.deepEqual(await f.gateway.models(), []);
    assert.equal((await f.post(protocol, { model: 'quick' })).status, 404);
    await f.gateway.updateSettings({ allowedProviders: null, allowedModels: [] });
    assert.deepEqual(await f.gateway.models(), []);
    assert.equal((await f.post(protocol, { model: 'other/reasoner@high' })).status, 404);
    await f.gateway.updateSettings({ allowedModels: null });
    assert.equal((await f.post(protocol, { model: 'blocked' })).status, 200);
    await f.gateway.updateSettings({ allowedProviders: [] });
    assert.equal((await f.post(protocol, { model: 'quick' })).status, 404);
    const response = await fetch(`${f.url}/v1/models`, { headers: f.headers });
    assert.deepEqual((await response.json()).data, []);
    await f.settled();
    assert.equal(f.store.getUsage().totals.requests, 13);
    assert.equal(f.store.getUsage().totals.failedRequests, 8);
  });
}

test('gateway validates true providers and canonical models, not variants or aliases', async t => {
  const f = await fixture(t);
  for (const invalid of [{ allowedProviders: ['missing'] }, { allowedProviders: ['demo/reasoner'] },
    { allowedModels: ['missing/model'] }, { allowedModels: ['reasoner'] }, { allowedModels: ['quick'] },
    { allowedModels: ['demo/reasoner@high'] }, { allowedModels: ['demo/reasoner@max'] },
    { allowedProviders: false }, { allowedModels: [1] }, { unknown: null }]) {
    await assert.rejects(f.gateway.updateSettings(invalid), badSettings);
    assert.deepEqual(f.store.getSettings(), defaults);
  }
  const reopened = await new StateStore(f.store.stateFile).load();
  assert.deepEqual(reopened.getSettings(), defaults);
});

test('real canonical ids containing @ win collisions and cannot inherit another model admission', async t => {
  const f = await fixture(t);
  f.llm.listModels = async provider => provider === 'demo' ? [
    { id: 'reasoner', name: 'Reasoner' }, { id: 'reasoner@high', name: 'Canonical @ model' },
  ] : [];
  await f.gateway.updateSettings({ allowedModels: ['demo/reasoner@high'] });
  assert.deepEqual((await f.gateway.models()).map(m => m.id), ['demo/reasoner@high']);
  assert.equal((await f.post('chat', { model: 'demo/reasoner@high' })).status, 200);
  assert.equal(f.calls.at(-1).model, 'reasoner@high');
  await f.gateway.updateSettings({ allowedModels: ['demo/reasoner'] });
  assert.equal((await f.post('chat', { model: 'demo/reasoner@high' })).status, 404);
  assert.equal((await f.post('chat', { model: 'demo/reasoner@low' })).status, 200);
});

test('selection is rechecked immediately before prepareCall', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.store.getSettings = () => ++reads === 1 ? defaults : { allowedProviders: [], allowedModels: null };
  assert.equal((await f.post('chat')).status, 404);
  assert.equal(f.calls.length, 0);
});

for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) {
  test(`${protocol} ${stream ? 'stream' : 'nonstream'}: records original DSH usage per client without changing wire format`, async t => {
    const f = await fixture(t);
    const extra = { stream, ...(protocol === 'chat' && stream ? { stream_options: { include_usage: true } } : {}) };
    const result = await f.post(protocol, extra);
    assert.equal(result.status, 200);
    if (stream) {
      assert.ok(result.text.includes('"total_tokens":97'));
      assert.ok(result.text.includes('[DONE]'));
    } else {
      assert.deepEqual(result.body.usage, protocol === 'chat'
        ? { prompt_tokens: 16, completion_tokens: 5, total_tokens: 97 }
        : { input_tokens: 16, output_tokens: 5, total_tokens: 97 });
    }
    assert.deepEqual(f.store.getUsage().totals, metrics);
    const second = await f.store.createClient('second');
    await f.post(protocol, extra, second.key);
    assert.deepEqual(f.store.getUsage().clients.map(({ id, label, revoked, ...counts }) => counts), [metrics, metrics]);
    assert.equal(f.store.getUsage().totals.totalTokens, 194);
    const status = f.gateway.status().usage;
    assert.equal(status.calls, 2);
    assert.equal(status.totalTokens, 194);
    assert.equal(status.inputTokens, 22);
    assert.equal(status.withoutUsage, 0);
    const reopened = await new StateStore(f.store.stateFile).load();
    assert.deepEqual(reopened.getUsage(), f.store.getUsage());
  });

  test(`${protocol} ${stream ? 'stream' : 'nonstream'}: missing usage is unknown, explicit zero is known`, async t => {
    const f = await fixture(t, { usage: undefined });
    await f.post(protocol, { stream });
    f.setUsage({});
    await f.post(protocol, { stream });
    f.setUsage(null);
    assert.equal((await f.post(protocol, { stream })).status, 200);
    f.setUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    await f.post(protocol, { stream });
    f.setUsage({ inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 4 });
    await f.post(protocol, { stream });
    assert.deepEqual(f.store.getUsage().totals, { ...zero, requests: 5, unknownUsageRequests: 3,
      inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 4, totalTokens: 10 });
    assert.equal(f.gateway.status().usage.withoutUsage, 3);
    assert.equal(f.gateway.status().usage.totalTokens, 10);
  });

  test(`${protocol} ${stream ? 'stream' : 'nonstream'}: failures keep already-reported usage`, async t => {
    const f = await fixture(t, { source: async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' };
      yield { type: 'usage', usage: rawUsage };
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_FAILED' } } };
    } });
    const result = await f.post(protocol, { stream });
    assert.equal(result.status, stream ? 200 : 502);
    assert.ok(result.text.includes('UPSTREAM_FAILED'));
    assert.deepEqual(f.store.getUsage().totals, { ...metrics, failedRequests: 1 });
    assert.equal(f.gateway.status().usage.failed, 1);
    f.llm.prepareCall = async () => { throw new Error('private upstream detail'); };
    const failed = await f.post(protocol, { stream });
    assert.equal(failed.status, 502);
    assert.equal(failed.text.includes('private upstream detail'), false);
    assert.deepEqual(f.store.getUsage().totals, { ...metrics, requests: 2, failedRequests: 2, unknownUsageRequests: 1 });
  });

  test(`${protocol} ${stream ? 'stream' : 'nonstream'}: client cancellation records once with partial usage`, async t => {
    const started = Promise.withResolvers();
    const f = await fixture(t, { source: async function* ({ signal }) {
      yield { type: 'usage', usage: rawUsage };
      yield { type: 'text-delta', index: 0, text: 'partial' };
      started.resolve();
      if (!signal.aborted) await once(signal, 'abort');
      throw signal.reason;
    } });
    const controller = new AbortController();
    const pending = fetch(f.url + f.path(protocol), { method: 'POST', headers: f.headers,
      body: JSON.stringify(f.payload(protocol, { stream })), signal: controller.signal,
    }).then(response => response.text()).catch(error => error);
    await started.promise;
    controller.abort();
    await pending;
    await f.settled();
    assert.deepEqual(f.store.getUsage().totals, { ...metrics, failedRequests: 1 });
    assert.equal(f.gateway.status().active, 0);
  });
}

test('timeout and request rejection record unknown usage, but discovery/auth failures do not', async t => {
  const f = await fixture(t, { cfg: { timeoutMs: 30 }, source: async function* ({ signal }) {
    if (!signal.aborted) await once(signal, 'abort');
    throw signal.reason;
  } });
  assert.equal((await f.post('chat')).status, 504);
  assert.equal((await f.post('chat', { model: 'missing' })).status, 404);
  assert.equal((await f.post('chat', {}, 'wrong-key')).status, 401);
  assert.equal((await fetch(`${f.url}/v1/models`, { headers: f.headers })).status, 200);
  await f.settled();
  assert.deepEqual(f.store.getUsage().totals, { ...zero, requests: 2, failedRequests: 2, unknownUsageRequests: 2 });
});

test('rate-limited requests record a failed unknown request without starting upstream', async t => {
  const f = await fixture(t, { cfg: { requestsPerMinute: 1 } });
  assert.equal((await f.post('chat')).status, 200);
  assert.equal((await f.post('chat')).status, 429);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.store.getUsage().totals, { ...metrics, requests: 2, failedRequests: 1, unknownUsageRequests: 1 });
});

test('revocation during a call preserves its eventual usage under the historical label', async t => {
  const started = Promise.withResolvers(); const release = Promise.withResolvers();
  const f = await fixture(t, { source: async function* () {
    started.resolve();
    await release.promise;
    yield { type: 'usage', usage: rawUsage };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  const pending = f.post('chat');
  await started.promise;
  await f.store.revokeClient(f.client.id);
  release.resolve();
  assert.equal((await pending).status, 200);
  assert.deepEqual(f.store.getUsage().clients, [{ id: f.client.id, label: f.client.label, revoked: true, ...metrics }]);
  assert.equal((await f.post('chat')).status, 401);
});

for (const stream of [false, true]) {
  test(`usage persistence failure cannot turn a successful ${stream ? 'stream' : 'nonstream'} into an error`, async t => {
    const f = await fixture(t);
    f.store.recordUsage = async () => { throw new Error('disk failure with private path'); };
    const result = await f.post('chat', { stream });
    assert.equal(result.status, 200);
    assert.ok(result.text.includes('ok'));
    assert.equal(result.text.includes('upstream_error'), false);
    assert.equal(result.text.includes('private path'), false);
    assert.equal(f.gateway.status().usage.failed, 0);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0].includes('private path'), false);
  });
}

test('admin catalog/settings/usage stay protected and sanitized; health and key lifecycle stay compatible', async t => {
  const f = await fixture(t, { cfg: { bodyLimit: 256 } });
  const admin = await serve(t, createAdmin({ store: f.store, gateway: f.gateway, cfg: f.cfg }));
  const headers = { 'x-outlet-admin': f.store.adminToken, 'content-type': 'application/json' };
  const get = async (path, auth = true, extra = {}) => {
    const response = await fetch(admin.url + path, { headers: { ...(auth ? headers : {}), ...extra } });
    const text = await response.text();
    await admin.settled();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const post = async (path, body, auth = true) => {
    const response = await fetch(admin.url + path, { method: 'POST', headers: auth ? headers : {}, body: JSON.stringify(body) });
    const text = await response.text();
    await admin.settled();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  assert.deepEqual((await get('/healthz', false)).body, { ok: true, clients: 1 });
  for (const path of ['/catalog', '/settings', '/usage', '/clients', '/models', '/status']) {
    assert.equal((await get(path, false)).status, 401);
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal(response.text.includes(f.store.adminToken), false);
    assert.equal(response.text.includes(f.client.key), false);
    assert.equal(response.text.includes('digest'), false);
    assert.equal(response.text.includes('adminToken'), false);
  }
  const untrustedHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(admin.url + '/settings', { headers: { ...headers, host: 'untrusted.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(untrustedHostStatus, 403);
  assert.equal((await post('/settings', { allowedProviders: [] }, false)).status, 401);
  assert.equal((await post('/settings', { allowedModels: ['quick'] })).status, 400);
  assert.equal((await post('/settings', [])).status, 400);
  assert.deepEqual((await post('/settings', { allowedProviders: [] })).body, { allowedProviders: [], allowedModels: null });
  assert.deepEqual((await get('/models')).body.data, []);
  assert.ok((await get('/catalog')).body.data.some(model => model.id === 'demo/reasoner@high'));
  assert.deepEqual((await get('/settings')).body, f.store.getSettings());
  assert.equal((await post('/settings', { allowedModels: ['x'.repeat(300)] })).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const request = httpRequest(admin.url + '/settings', { method: 'POST', headers }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    request.on('error', reject);
    request.write('{"allowedProviders":');
    request.end('null,"allowedModels":[]}');
  });
  await admin.settled();
  assert.equal(chunked.status, 200);
  assert.deepEqual(chunked.body, { allowedProviders: null, allowedModels: [] });
  const created = await post('/clients', { label: 'admin created' });
  assert.equal(created.status, 200);
  assert.equal(f.store.lookup(created.body.key).id, created.body.id);
  const rotated = await post('/clients/rotate', { id: created.body.id });
  assert.equal(rotated.status, 200);
  assert.equal(f.store.lookup(created.body.key), undefined);
  assert.equal(f.store.lookup(rotated.body.key).id, created.body.id);
  assert.deepEqual((await post('/clients/revoke', { id: created.body.id })).body, { ok: true });
  assert.equal(f.store.lookup(rotated.body.key), undefined);
  const usage = await get('/usage');
  assert.ok(usage.body.clients.some(client => client.id === created.body.id && client.revoked));
  const disk = JSON.parse(await readFile(f.store.stateFile, 'utf8'));
  assert.deepEqual(disk.settings, { allowedProviders: null, allowedModels: [] });
  assert.equal(usage.text.includes(rotated.body.key), false);
  await f.store.flushed();
});
