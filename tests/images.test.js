import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { convertChatRequest } from '../lib/chat.js';
import { convertResponsesRequest } from '../lib/responses.js';
import { normalizeConfig } from '../lib/config.js';
import { createGateway } from '../lib/gateway.js';

const cfg = normalizeConfig();
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const vision = { id: 'demo/vision', provider: 'demo', model: 'vision', input_modalities: ['text', 'image'] };
const textOnly = { id: 'demo/text', provider: 'demo', model: 'text', input_modalities: ['text'] };
const models = [vision, textOnly];
const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 68, width: 1, height: 1 };
const protocols = [
  ['chat', convertChatRequest, urls => ({ messages: urls.map(url => ({ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url } }] })) })],
  ['responses', convertResponsesRequest, urls => ({ input: urls.map(url => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'describe' }, { type: 'input_image', image_url: url }] })) })],
];

function attachments() {
  const batches = [];
  return { batches, ctx: { get: name => {
    assert.equal(name, 'attachments');
    return { saveImages: async images => { batches.push(images); return images.map(() => ({ ...ref })); } };
  } } };
}

for (const [name, convert, input] of protocols) {
  test(`${name}: mixed text/images preserve order and admit one request-level batch`, async () => {
    const { batches, ctx } = attachments();
    const { request } = await convert({ model: vision.id, ...input([png, png]) }, ctx, cfg, models);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    assert.deepEqual(Buffer.from(batches[0][0].data), Buffer.from(png.split(',')[1], 'base64'));
    for (const msg of request.messages) assert.deepEqual(msg.content, [{ type: 'text', text: 'describe' }, { type: 'image', attachment: ref }]);
  });
  test(`${name}: text-only models reject images before storage`, async () => {
    const { batches, ctx } = attachments();
    await assert.rejects(convert({ model: textOnly.id, ...input([png]) }, ctx, cfg, models), e => e.status === 400 && e.code === 'image_unsupported');
    assert.equal(batches.length, 0);
  });
  test(`${name}: image budgets apply across messages and fail before storage`, async () => {
    const { batches, ctx } = attachments();
    await assert.rejects(convert({ model: vision.id, ...input([png, png, png, png]) }, ctx, cfg, models), e => e.status === 413 && e.code === 'too_many_images');
    await assert.rejects(convert({ model: vision.id, ...input([png]) }, ctx, { ...cfg, maxImageBytes: 1 }, models), e => e.status === 413 && e.code === 'image_too_large');
    assert.equal(batches.length, 0);
  });
  test(`${name}: malformed later image and remote URLs cannot leave partial saves`, async () => {
    const { batches, ctx } = attachments();
    for (const bad of ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,aGk', '', null, 'http://127.0.0.1/private', 'https://example.com/photo.png']) {
      await assert.rejects(convert({ model: vision.id, ...input([png, bad]) }, ctx, cfg, models), e => e.status === 400);
    }
    assert.equal(batches.length, 0);
  });
  test(`${name}: missing attachment service fails clearly`, async () => {
    await assert.rejects(convert({ model: vision.id, ...input([png]) }, { get: () => undefined }, cfg, models), e => e.status === 502 && e.code === 'attachments_unavailable');
  });
}

test('chat: string image_url from compatible clients is accepted', async () => {
  const { ctx } = attachments();
  const { request } = await convertChatRequest({ model: vision.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: png }] }] }, ctx, cfg, models);
  assert.deepEqual(request.messages[0].content, [{ type: 'image', attachment: ref }]);
});

test('responses: standard input message can omit type with text and image content', async () => {
  const { ctx } = attachments();
  const { request } = await convertResponsesRequest({ model: vision.id, input: [{ role: 'user', content: [{ type: 'input_text', text: 'describe' }, { type: 'input_image', image_url: png }] }] }, ctx, cfg, models);
  assert.deepEqual(request.messages[0].content, [{ type: 'text', text: 'describe' }, { type: 'image', attachment: ref }]);
  for (const item of [{ role: 'user', content: 'hello' }, { role: 'developer', content: 'hello' }]) {
    assert.equal((await convertResponsesRequest({ model: vision.id, input: [item] }, ctx, cfg, models)).request.messages.length, 1);
  }
  for (const item of [{ content: 'hello' }, { type: 'unsupported', role: 'user', content: 'hello' }, { role: 'invalid', content: 'hello' }]) {
    await assert.rejects(convertResponsesRequest({ model: vision.id, input: [item] }, ctx, cfg, models), e => e.status === 400);
  }
});

test('HTTP: image refs reach the adapter in both protocols and streaming modes above 1 MiB', async t => {
  const { ctx, batches } = attachments();
  let calls = 0;
  const llm = {
    listProviders: async () => [{ id: 'demo' }],
    listModels: async () => [{ id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] }],
    prepareCall: async config => {
      calls++;
      return { config, async *stream(options) {
        const content = options.messages[0].content;
        assert.deepEqual(content.at(-1), { type: 'image', attachment: ref });
        assert.ok(content[0].text.length > 1048576);
        yield { type: 'text-delta', index: 0, text: 'image received' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  };
  const gateway = createGateway({ llm, ctx, cfg, store: { lookup: key => key === 'test-client' ? {} : undefined } });
  const server = createServer(gateway.handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const [name, , input] of protocols) {
    const payload = input([png]);
    const message = name === 'chat' ? payload.messages[0] : payload.input[0];
    if (name === 'responses') delete message.type;
    message.content[0].text = 'x'.repeat(1100000);
    for (const stream of [false, true]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${name === 'chat' ? 'chat/completions' : 'responses'}`, {
        method: 'POST', headers: { authorization: 'Bearer test-client', 'content-type': 'application/json' },
        body: JSON.stringify({ model: vision.id, ...payload, stream }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes('image received'));
      assert.equal(text.includes('[DONE]'), stream);
    }
  }
  assert.equal(calls, 4);
  assert.equal(batches.length, 4);
});
