import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { bundleClient } from '../scripts/build-client.mjs';

const root = new URL('../', import.meta.url);
const [source, css, built] = await Promise.all([
  readFile(new URL('client/index.cjs', root), 'utf8'),
  readFile(new URL('client/styles.css', root), 'utf8'),
  readFile(new URL('client/client.js', root), 'utf8'),
]);
let registration;
new Function('window', built)({ __ModuleLoader__: { load(value) { registration = value; } } });
const reactStub = { createElement() {} };
const client = registration.factory(name => {
  if (name === 'react') return reactStub;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
  throw new Error(`Unexpected runtime dependency: ${name}`);
});

function metrics(overrides = {}) {
  return { requests: 0, failedRequests: 0, unknownUsageRequests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, ...overrides };
}
function fixture() {
  return {
    settings: { allowedProviders: null, allowedModels: null },
    catalog: [
      { id: 'source-a/model-a', provider: 'source-a', model: 'model-a', name: '模型 A', input_modalities: ['text', 'image'], reasoning_efforts: ['low', 'high'] },
      { id: 'source-a/model-a@high', base_model: 'source-a/model-a', provider: 'source-a', model: 'model-a', name: '模型 A（high）', input_modalities: ['text'], reasoning_efforts: ['low', 'high'] },
      { id: 'source-b/model-b', provider: 'source-b', model: 'model-b', name: '模型 B', input_modalities: ['text'], reasoning_efforts: [] },
    ],
    usage: {
      since: '2026-01-01T00:00:00.000Z',
      totals: metrics({ requests: 3, failedRequests: 1, unknownUsageRequests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 37 }),
      clients: [{ id: 'client-a', label: '编辑器', revoked: false, ...metrics({ requests: 3, failedRequests: 1, unknownUsageRequests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 37 }) }],
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('client build is deterministic and has only official runtime dependencies', () => {
  assert.equal(built, bundleClient(source, css));
  assert.equal(registration.id, '@oracle-ai/dsh-api-outlet');
  assert.throws(() => bundleClient('no stylesheet import', ''), /exactly one/);
});

test('configuration registers inside this bundle detail, not a standalone settings page', () => {
  let slot, descriptor, component, effect;
  const ctx = {
    effect(callback) { effect = callback; },
    slots: {
      inject(name, callback) { slot = name; callback(); },
      register(options, view) { descriptor = options; component = view; return () => {}; },
    },
  };
  client.apply(ctx);
  assert.equal(slot, 'plugins.bundle.config');
  assert.equal(descriptor.name, slot);
  assert.equal(descriptor.key, '@oracle-ai/dsh-api-outlet');
  assert.equal(component, client.OutletPanel);
  assert.equal(typeof descriptor.inject().loadSnapshot, 'function');
  assert.equal(typeof descriptor.inject().saveSettings, 'function');
  assert.equal(typeof effect, 'function');
  assert.deepEqual(client.inject, ['slots']);
});

test('null and [] stay distinct; individual edits retain an explicit allowlist', () => {
  assert.equal(client.sameSettings({ allowedProviders: null, allowedModels: null }, { allowedProviders: [], allowedModels: [] }), false);
  assert.deepEqual(client.toggleSelection(null, 'a', false, ['a', 'b']), ['b']);
  assert.deepEqual(client.toggleSelection(['b'], 'a', true, ['a', 'b']), ['b', 'a']);
  assert.deepEqual(client.toggleSelection(['offline', 'b'], 'b', false, ['a', 'b']), ['offline']);
  assert.equal(client.sameSettings({ allowedProviders: ['a', 'b'], allowedModels: [] }, { allowedProviders: ['b', 'a'], allowedModels: [] }), true);
  assert.equal(client.sameSettings({ allowedProviders: ['a', 'a'], allowedModels: [] }, { allowedProviders: ['a', 'b'], allowedModels: [] }), false);
});

test('canonical list hides effort variants and effective models intersect enabled sources', () => {
  const models = client.canonicalModels(fixture().catalog);
  assert.deepEqual(models.map(model => model.id), ['source-a/model-a', 'source-b/model-b']);
  assert.equal(client.effectiveCount(models, { allowedProviders: ['source-b'], allowedModels: ['source-a/model-a'] }), 0);
  assert.equal(client.effectiveCount(models, { allowedProviders: ['source-b'], allowedModels: null }), 1);
  assert.equal(client.effectiveCount(models, { allowedProviders: null, allowedModels: null }), 2);
  assert.equal(client.effectiveCount(models, { allowedProviders: [], allowedModels: null }), 0);
});

test('snapshot boundary rejects missing usage instead of manufacturing zero tokens', () => {
  const invalid = fixture();
  delete invalid.usage.totals.totalTokens;
  assert.throws(() => client.validateSnapshot(invalid), /数据不完整/);
  const malformed = fixture();
  malformed.settings.allowedProviders = 'all';
  assert.throws(() => client.validateSnapshot(malformed), /数据不完整/);
  const invalidDate = fixture();
  invalidDate.usage.since = 'not-a-date';
  assert.throws(() => client.validateSnapshot(invalidDate), /数据不完整/);
  const duplicate = fixture();
  duplicate.usage.clients.push({ ...duplicate.usage.clients[0] });
  assert.throws(() => client.validateSnapshot(duplicate), /数据不完整/);
  const extra = fixture();
  extra.adminToken = 'must-not-be-kept';
  extra.usage.clients[0].key = 'must-not-be-kept';
  const accepted = client.validateSnapshot(extra);
  assert.equal('adminToken' in accepted, false);
  assert.equal('key' in accepted.usage.clients[0], false);
  extra.settings.allowedProviders = ['new'];
  assert.equal(accepted.settings.allowedProviders, null);
});

test('loading errors expose retryable state and do not produce a fake snapshot', async () => {
  const store = client.createPanelStore({ loadSnapshot: async () => { throw new Error('网络未连接。'); } });
  await store.load();
  assert.equal(store.getSnapshot().snapshot, null);
  assert.equal(store.getSnapshot().busy, null);
  assert.equal(store.getSnapshot().error.kind, 'load');
  assert.match(store.getSnapshot().error.message, /加载失败/);
});

test('manual refresh updates the server snapshot without overwriting staged policy', async () => {
  let latest = fixture();
  const store = client.createPanelStore({ loadSnapshot: async () => latest });
  await store.load();
  store.edit('allowedProviders', ['source-b']);
  latest = fixture();
  latest.settings.allowedProviders = [];
  await store.load();
  assert.deepEqual(store.getSnapshot().snapshot.settings.allowedProviders, []);
  assert.deepEqual(store.getSnapshot().draft.allowedProviders, ['source-b']);
  assert.match(store.getSnapshot().notice, /已保留/);
  store.discard();
  assert.deepEqual(store.getSnapshot().draft.allowedProviders, []);
});

test('saving submits a detached draft and accepts only the confirmed snapshot', async () => {
  const response = deferred();
  let submitted, calls = 0;
  const store = client.createPanelStore({ loadSnapshot: async () => fixture(), saveSettings: settings => { submitted = settings; calls++; return response.promise; } });
  await store.load();
  store.edit('allowedModels', ['source-a/model-a']);
  const save = store.save();
  assert.equal(store.getSnapshot().busy, 'saving');
  assert.equal(store.getSnapshot().snapshot.settings.allowedModels, null);
  store.edit('allowedModels', []);
  assert.deepEqual(store.getSnapshot().draft.allowedModels, ['source-a/model-a']);
  await store.save();
  assert.equal(calls, 1);
  submitted.allowedModels.push('only-mutated-in-transport');
  assert.deepEqual(store.getSnapshot().draft.allowedModels, ['source-a/model-a']);
  const confirmed = fixture();
  confirmed.settings.allowedModels = ['source-a/model-a'];
  response.resolve(confirmed);
  await save;
  assert.equal(store.getSnapshot().busy, null);
  assert.equal(client.sameSettings(store.getSnapshot().draft, store.getSnapshot().snapshot.settings), true);
  assert.match(store.getSnapshot().notice, /已保存/);
});

test('failed save preserves both the draft and last accepted service settings', async () => {
  const store = client.createPanelStore({ loadSnapshot: async () => fixture(), saveSettings: async () => { throw new Error('写入失败。'); } });
  await store.load();
  store.edit('allowedModels', []);
  await store.save();
  assert.deepEqual(store.getSnapshot().draft.allowedModels, []);
  assert.equal(store.getSnapshot().snapshot.settings.allowedModels, null);
  assert.equal(store.getSnapshot().busy, null);
  assert.equal(store.getSnapshot().error.kind, 'save');
  assert.match(store.getSnapshot().error.message, /刷新确认服务状态/);
});

test('cancelled loads cannot replace a newer mount snapshot', async () => {
  const first = deferred();
  let calls = 0;
  const store = client.createPanelStore({ loadSnapshot: () => ++calls === 1 ? first.promise : Promise.resolve(fixture()) });
  const pending = store.load();
  store.cancel();
  await store.load();
  const stale = fixture();
  stale.settings.allowedProviders = [];
  first.resolve(stale);
  await pending;
  assert.equal(store.getSnapshot().snapshot.settings.allowedProviders, null);
});

test('same-origin API uses no secrets and validates both load and save responses', async () => {
  const calls = [];
  const api = client.createApi(async (path, init) => { calls.push({ path, init }); return { ok: true, json: async () => fixture() }; });
  await api.loadSnapshot();
  await api.saveSettings({ allowedProviders: [], allowedModels: null, apiKey: 'ignored' });
  assert.equal(calls[0].path, '/api/dsh-api-outlet/snapshot');
  assert.equal(calls[1].path, '/api/dsh-api-outlet/settings');
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.cache, 'no-store');
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), { allowedProviders: [], allowedModels: null });
  await assert.rejects(client.createApi(async () => ({ ok: false, status: 401 })).loadSnapshot(), /重新登录/);
  await assert.rejects(client.createApi(async () => ({ ok: false, status: 403 })).loadSnapshot(), /权限/);
  await assert.rejects(client.createApi(async () => { throw new Error('private backend credentials'); }).loadSnapshot(), /无法连接宿主/);
});

// Use NODE_PATH pointing at the already-installed Host dependencies for the optional React SSR check.
const require = createRequire(import.meta.url);
let React, renderToStaticMarkup;
try { React = require('react'); ({ renderToStaticMarkup } = require('react-dom/server')); } catch {}

test('rendered panel has labels, canonical choices, policy intersection and real usage caveat', { skip: !React && 'React is not installed in the test environment.' }, () => {
  const h = React.createElement;
  const primitives = {
    Button: ({ children, variant, size, ...props }) => h('button', props, children),
    Input: props => h('input', props),
    Checkbox: ({ checked, onChange, label, ...props }) => h('label', null, h('input', { ...props, type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }), label),
  };
  const view = registration.factory(name => name === 'react' ? React : primitives);
  const snapshot = client.validateSnapshot(fixture());
  const draft = { allowedProviders: ['source-b'], allowedModels: null };
  const html = renderToStaticMarkup(h(view.OutletView, { state: { snapshot, draft, busy: null, error: null, notice: '' }, onEdit() {}, onSave() {}, onDiscard() {}, onReload() {} }));
  assert.match(html, /服务已确认/);
  assert.match(html, /待保存预览/);
  assert.match(html, /模型与已开启来源取交集/);
  assert.match(html, /来源未选，保存后不开放/);
  assert.match(html, /未报告 usage/);
  assert.match(html, /不补造历史用量/);
  assert.match(html, /<label for="[^"]+"[^>]*>搜索模型或来源<\/label>/);
  assert.match(html, /<label for="[^"]+"[^>]*>查看下游客户端<\/label>/);
  assert.match(html, /编辑器/);
  assert.match(html, /总 token/);
  assert.doesNotMatch(html, /model-a@high/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4);
  assert.match(html, /保存开放范围/);
});

test('selected downstream view uses that client metrics and retains revoked history', { skip: !React && 'React is not installed in the test environment.' }, () => {
  const usage = fixture().usage;
  usage.totals.totalTokens = 136;
  usage.clients.push({ id: 'revoked-client', label: '旧编辑器', revoked: true, ...metrics({ inputTokens: 99, totalTokens: 99 }) });
  // The view's only local state is the selected id; exercise its selected render without a DOM dependency.
  const selectedReact = { ...React, useState: () => ['revoked-client', () => {}] };
  const view = registration.factory(name => name === 'react' ? selectedReact : { Button: ({ children, size, variant, ...props }) => React.createElement('button', props, children) });
  const html = renderToStaticMarkup(React.createElement(view.UsageSection, { usage, disabled: false, onReload() {}, idPrefix: 'selected' }));
  assert.match(html, /<option value="revoked-client" selected="">/);
  assert.match(html, /客户端已撤销/);
  assert.match(html, /<dd>99<\/dd>/);
  assert.doesNotMatch(html, /<dd>136<\/dd>/);
  assert.doesNotMatch(html, /未报告 usage/);
});

test('empty catalog and load failures offer recovery without synthetic usage', { skip: !React && 'React is not installed in the test environment.' }, () => {
  const view = registration.factory(name => name === 'react' ? React : { Button: ({ children, size, variant, ...props }) => React.createElement('button', props, children) });
  const html = renderToStaticMarkup(React.createElement(view.OutletView, { state: { snapshot: null, draft: null, busy: null, error: { kind: 'load', message: '加载失败，请重试。' }, notice: '' }, onReload() {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /重新加载/);
  assert.doesNotMatch(html, /总 token/);
});
