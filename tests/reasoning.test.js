import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { convertChatRequest } from '../lib/chat.js';
import { convertResponsesRequest } from '../lib/responses.js';
import { normalizeConfig } from '../lib/config.js';
import { createGateway } from '../lib/gateway.js';
import { ApiError } from '../lib/errors.js';

const cfg = normalizeConfig();
const base = {
  id: 'demo/reasoner', provider: 'demo', model: 'reasoner', name: 'Reasoner',
  input_modalities: ['text', 'image'], reasoning_efforts: ['off', 'low', 'high', 'max'],
  default_reasoning_effort: 'low',
};
const variant = { ...base, id: `${base.id}@high`, base_model: base.id, reasoning_effort: 'high', default_reasoning_effort: 'high' };
const plain = { id: 'demo/plain', provider: 'demo', model: 'plain', name: 'Plain', reasoning_efforts: [] };
const modelList = [base, variant, plain];
const protocols = [
  ['chat', convertChatRequest, { messages: [{ role: 'user', content: 'hello' }] }],
  ['responses', convertResponsesRequest, { input: 'hello' }],
];
const isBadRequest = error => error instanceof ApiError && error.status === 400;

for (const [name, convert, input] of protocols) {
  const run = extra => convert({ model: base.id, ...input, ...extra }, {}, cfg, modelList);
  test(`${name}: no effort preserves upstream default`, async () => {
    assert.equal(Object.hasOwn((await run({})).request, 'reasoningEffort'), false);
  });
  for (const effort of base.reasoning_efforts) {
    test(`${name}: forwards exact effort ${effort}`, async () => {
      assert.equal((await run({ reasoning_effort: effort })).request.reasoningEffort, effort);
    });
  }
  test(`${name}: model variant selects effort without renaming upstream model`, async () => {
    const converted = await run({ model: variant.id });
    assert.equal(converted.request.reasoningEffort, 'high');
    assert.equal(converted.request.provider, 'demo');
    assert.equal(converted.request.model, 'reasoner');
    assert.equal(converted.model, variant.id);
  });
  test(`${name}: explicit effort overrides model variant`, async () => {
    assert.equal((await run({ model: variant.id, reasoning_effort: 'low' })).request.reasoningEffort, 'low');
  });
  test(`${name}: configured aliases can target variants`, async () => {
    const converted = await convert({ model: 'quick', ...input }, {}, normalizeConfig({ aliases: { quick: variant.id } }), modelList);
    assert.equal(converted.request.reasoningEffort, 'high');
  });
  for (const value of [123, '', ' ', null, 'xhigh']) {
    test(`${name}: rejects invalid effort ${JSON.stringify(value)}`, async () => {
      await assert.rejects(run({ reasoning_effort: value }), isBadRequest);
    });
  }
  test(`${name}: rejects effort for known non-reasoning model`, async () => {
    await assert.rejects(run({ model: plain.id, reasoning_effort: 'high' }), isBadRequest);
  });
  test(`${name}: malformed JSON body fails as 400`, async () => {
    await assert.rejects(convert(null, {}, cfg, modelList), isBadRequest);
  });
  test(`${name}: effort fails before image admission`, async () => {
    let saves = 0;
    const ctx = { get: () => ({ saveImages: async () => { saves++; return []; } }) };
    const imageInput = name === 'chat'
      ? { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] }
      : { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] }] };
    await assert.rejects(convert({ model: base.id, ...imageInput, reasoning_effort: 123 }, ctx, cfg, modelList), isBadRequest);
    assert.equal(saves, 0);
  });
}

test('chat: accepts default top_p without forwarding unsupported sampling controls', async () => {
  for (const top_p of [undefined, null, 1]) {
    const converted = await convertChatRequest({
      model: base.id, messages: [{ role: 'user', content: 'hello' }],
      top_p, temperature: 0.7, store: false,
    }, {}, cfg, modelList);
    assert.equal(converted.request.temperature, 0.7);
    assert.equal(Object.hasOwn(converted.request, 'topP'), false);
    assert.equal(Object.hasOwn(converted.request, 'top_p'), false);
  }
});

test('chat: non-default and malformed top_p remain explicit errors', async () => {
  for (const top_p of [0, 0.5, 0.95, -1, 2, '1', true, {}, []]) {
    await assert.rejects(convertChatRequest({
      model: base.id, messages: [{ role: 'user', content: 'hello' }], top_p,
    }, {}, cfg, modelList), error => isBadRequest(error)
      && error.code === 'unsupported_field' && error.extra.field === 'top_p');
  }
});

test('responses: standard reasoning.effort and legacy field agree', async () => {
  for (const extra of [
    { reasoning: { effort: 'max' } },
    { reasoning: { effort: 'max' }, reasoning_effort: 'max' },
  ]) {
    const result = await convertResponsesRequest({ model: variant.id, input: 'hello', ...extra }, {}, cfg, modelList);
    assert.equal(result.request.reasoningEffort, 'max');
  }
});

test('responses: conflicting effort fields fail explicitly', async () => {
  await assert.rejects(convertResponsesRequest({ model: base.id, input: 'hello', reasoning_effort: 'low', reasoning: { effort: 'high' } }, {}, cfg, modelList), isBadRequest);
});

for (const reasoning of [null, [], 'high', { effort: 123 }, { effort: '' }, { summary: 'auto' }, { encrypted_content: 'test' }]) {
  test(`responses: rejects unsupported reasoning ${JSON.stringify(reasoning)}`, async () => {
    await assert.rejects(convertResponsesRequest({ model: base.id, input: 'hello', reasoning }, {}, cfg, modelList), isBadRequest);
  });
}

test('responses: empty reasoning object preserves default', async () => {
  const result = await convertResponsesRequest({ model: base.id, input: 'hello', reasoning: {} }, {}, cfg, modelList);
  assert.equal(Object.hasOwn(result.request, 'reasoningEffort'), false);
});

function fixture() {
  const calls = [];
  const llm = {
    listProviders: async () => [{ id: 'demo' }],
    listModels: async () => [
      { provider: 'demo', id: 'reasoner', name: 'Reasoner', inputModalities: ['text', 'image'] },
      { provider: 'demo', id: 'plain', name: 'Plain' },
    ],
    resolveModelInfo: async (provider, model) => ({
      provider, id: model, name: model,
      ...(model === 'reasoner' ? { reasoning: { efforts: ['low', 'high'].map(id => ({ id, name: id })), defaultEffort: 'low' } } : {}),
    }),
    prepareCall: async config => {
      calls.push(config);
      return { config, async *stream(options) {
        assert.equal(options.reasoningEffort, config.reasoningEffort);
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  };
  const gateway = createGateway({ llm, ctx: {}, store: { lookup: value => value === 'test-client' ? {} : undefined }, cfg });
  return { calls, llm, gateway };
}

test('discovery: publishes exact capabilities, defaults and selectable variants', async () => {
  const { gateway } = fixture();
  const models = await gateway.models();
  assert.deepEqual(models.map(model => model.id), ['demo/reasoner', 'demo/reasoner@low', 'demo/reasoner@high', 'demo/plain']);
  assert.deepEqual(models[0].reasoning_efforts, ['low', 'high']);
  assert.equal(models[0].default_reasoning_effort, 'low');
  assert.equal(models[2].default_reasoning_effort, 'high');
  assert.equal(models[2].base_model, 'demo/reasoner');
  assert.deepEqual(models[2].input_modalities, ['text', 'image']);
  assert.deepEqual(models[3].reasoning_efforts, []);
  assert.equal(await gateway.models(), models);
});

test('discovery: canonical models win over colliding variant ids', async () => {
  const { llm, gateway } = fixture();
  llm.listModels = async () => [
    { provider: 'demo', id: 'reasoner', name: 'Reasoner' },
    { provider: 'demo', id: 'reasoner@high', name: 'Real canonical model' },
  ];
  const models = await gateway.models();
  const match = models.filter(model => model.id === 'demo/reasoner@high');
  assert.equal(match.length, 1);
  assert.equal(match[0].name, 'Real canonical model');
  assert.equal(match[0].base_model, undefined);
});

test('discovery: failed or unavailable capability lookup keeps base models usable', async () => {
  for (const lookup of [undefined, async () => { throw new Error('offline'); }]) {
    const { llm, gateway } = fixture();
    llm.resolveModelInfo = lookup;
    const models = await gateway.models();
    assert.deepEqual(models.map(model => model.id), ['demo/reasoner', 'demo/plain']);
    assert.equal(models[0].reasoning_efforts, undefined);
  }
});

test('HTTP: authenticated discovery, both protocols, streaming and early rejection', async t => {
  const { calls, gateway } = fixture();
  const server = createServer(gateway.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer test-client', 'content-type': 'application/json' };
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  const models = await (await fetch(`${url}/v1/models`, { headers })).json();
  assert.ok(models.data.some(model => model.id === 'demo/reasoner@high'));
  for (const [path, input] of [
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
    ['/v1/responses', { input: 'hello' }],
  ]) {
    const defaults = path === '/v1/chat/completions' ? { top_p: 1, store: false } : {};
    for (const stream of [false, true]) {
      const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify({ model: 'demo/reasoner@high', ...input, ...defaults, stream }) });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes('ok'));
      assert.ok(text.includes('demo/reasoner@high'));
      assert.equal(text.includes('[DONE]'), stream);
      assert.equal(calls.at(-1).model, 'reasoner');
      assert.equal(calls.at(-1).reasoningEffort, 'high');
    }
  }
  const standard = await fetch(`${url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'demo/reasoner', input: 'hello', reasoning: { effort: 'low' } }) });
  assert.equal(standard.status, 200);
  await standard.text();
  assert.equal(calls.at(-1).reasoningEffort, 'low');
  const before = calls.length;
  const invalid = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'demo/reasoner', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'max' }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_request');
  assert.equal(calls.length, before);
});
