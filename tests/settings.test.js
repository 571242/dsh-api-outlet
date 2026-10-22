import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsRoutes, mountSettingsBridge } from '../lib/settings.js';
import { ApiError, invalid } from '../lib/errors.js';

function fixture() {
  let settings = { allowedProviders: null, allowedModels: null };
  let writes = 0;
  const store = { getSettings: () => settings, getUsage: () => ({ since: 1, totals: { totalTokens: 12 }, clients: [] }), adminToken: 'private-admin-token' };
  const gateway = {
    catalog: async () => [{ id: 'demo/model', provider: 'demo', model: 'model', name: 'Demo' }],
    updateSettings: async value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Settings must be an object.');
      settings = value; writes++; return value;
    },
  };
  const routes = createSettingsRoutes({ store, gateway });
  return { store, gateway, routes, writes: () => writes };
}
test('settings: catalog supplies a usable display name when upstream omits it', async () => {
  const { createGateway } = await import('../lib/gateway.js');
  const { store } = fixture();
  const gateway = createGateway({ llm: { listProviders: async () => [{ id: 'demo' }], listModels: async () => [{ id: 'unnamed' }] }, store, ctx: {}, cfg: { modelCacheMs: 1000 } });
  assert.equal((await gateway.catalog())[0].name, 'unnamed');
});
const url = 'http://127.0.0.1:19387/api/dsh-api-outlet';
const post = (body, headers = {}) => new Request(`${url}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('settings: returns only public snapshot with no admin token', async () => {
  const { routes } = fixture();
  const result = await routes[0].fetch(new Request(`${url}/snapshot`));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  const text = await result.text();
  assert.equal(text.includes('private-admin-token'), false);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['settings', 'catalog', 'usage']);
});

test('settings: saves explicit empty lists and returns updated snapshot', async () => {
  const { routes, writes } = fixture();
  const result = await routes[1].fetch(post({ allowedProviders: [], allowedModels: [] }, { origin: 'http://127.0.0.1:19387' }));
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).settings, { allowedProviders: [], allowedModels: [] });
  assert.equal(writes(), 1);
});

test('settings: uses the validated Host when the real carrier supplies a synthetic Fetch URL', async () => {
  const { routes, writes } = fixture();
  const request = origin => new Request('http://dsh.internal/api/dsh-api-outlet/settings', {
    method: 'POST', headers: { host: '127.0.0.1:19387', origin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal((await routes[1].fetch(request('http://127.0.0.1:19387'))).status, 200);
  assert.equal((await routes[1].fetch(request('https://127.0.0.1:19387'))).status, 200);
  assert.equal((await routes[1].fetch(request('https://evil.invalid'))).status, 403);
  assert.equal(writes(), 2);
});

test('settings: supports same-authority TLS edge without trusting forwarding headers', async () => {
  const { routes } = fixture();
  assert.equal((await routes[1].fetch(post({}, { origin: 'https://127.0.0.1:19387' }))).status, 200);
  assert.equal((await routes[1].fetch(post({}, { origin: 'https://untrusted.invalid', 'x-forwarded-host': 'untrusted.invalid' }))).status, 403);
});

for (const headers of [{ origin: 'https://evil.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'http://127.0.0.1:9999' }]) {
  test(`settings: rejects cross-origin ${JSON.stringify(headers)}`, async () => {
    const { routes, writes } = fixture();
    assert.equal((await routes[1].fetch(post({}, headers))).status, 403);
    assert.equal(writes(), 0);
  });
}

for (const [name, request, status] of [
  ['wrong media type', post('{}', { 'content-type': 'text/plain' }), 415],
  ['malformed JSON', post('{'), 400],
  ['array settings', post([]), 400],
  ['oversized body', post('x'.repeat(65537)), 413],
  ['declared oversized body', post('{}', { 'content-length': '65537' }), 413],
]) {
  test(`settings: rejects ${name} before updating`, async () => {
    const { routes, writes } = fixture();
    assert.equal((await routes[1].fetch(request)).status, status);
    assert.equal(writes(), 0);
  });
}

test('settings: never forwards internal persistence errors or secrets', async () => {
  const { gateway, store } = fixture();
  gateway.updateSettings = async () => { throw new Error('private-admin-token /private/secret/file'); };
  const result = await createSettingsRoutes({ store, gateway })[1].fetch(post({}));
  assert.equal(result.status, 500);
  assert.equal((await result.text()).includes('private-admin-token'), false);
});

test('settings: forwards only deliberate API errors', async () => {
  const { gateway, store } = fixture();
  gateway.updateSettings = async () => { throw new ApiError(400, 'invalid_request', 'Unknown provider.'); };
  const result = await createSettingsRoutes({ store, gateway })[1].fetch(post({}));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.message, 'Unknown provider.');
});

test('settings: mount uses owner-protected Connection registry, never raw webServer', () => {
  const { gateway, store } = fixture();
  const registered = [];
  let configured = false;
  mountSettingsBridge({ fiber: {}, inject: (names, callback) => {
    if (names.includes('connection')) callback({ connection: { fetch: { register: route => registered.push(route) } } });
    else callback({ effect: init => init(), settings: { configure: value => { configured = value.auto === false; } } });
  } }, { store, gateway });
  assert.deepEqual(registered.map(route => route.path), [`/api/dsh-api-outlet/snapshot`, `/api/dsh-api-outlet/settings`]);
  assert.equal(registered[1].requestBody, 'streaming');
  assert.equal(configured, true);
});

test('settings: real DSH Connection denies non-owner exact route access', async () => {
  const { HostConnectionService } = await import('/srv/oracle-ai/dsh-home/profiles/cloud/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js');
  const { routes } = fixture();
  const receiver = { fetchRoutes: new Map(routes.map(route => [route.path, { ...route, methods: new Set(route.methods) }])), interceptors: new Map() };
  const carrier = HostConnectionService.prototype.createSharedFetchHandler.call(receiver, '/api');
  const request = new Request(`${url}/snapshot`);
  assert.equal((await carrier.fetch(request, { principal: { kind: 'guest' } })).status, 403);
  assert.equal((await carrier.fetch(request, { principal: { kind: 'owner' } })).status, 200);
  const admission = HostConnectionService.prototype.admit.call({ isTrusted: () => true, disposed: false, owner: { get: () => ({ protocol: 'http:' }) }, browserAuth: { isAuthenticated: () => false, authenticateApi: () => undefined }, peers: new Map() }, { headers: { authorization: 'Bearer downstream-only' } });
  assert.deepEqual(admission, { rejection: 401 });
});
