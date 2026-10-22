import { randomUUID } from 'node:crypto';
import { ApiError, upstreamFailure } from './errors.js';
import { json, sseWrite } from './sse.js';
import { convertChatRequest } from './chat.js';
import { convertResponsesRequest } from './responses.js';
import { usageMetrics, validateSettings } from './keys.js';

/** Bearer check against a client key store. */
export function authenticated(header, store) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const key = header.slice(7);
  return store.lookup(key) !== undefined;
}

async function bodyOf(req, limit, signal) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'unsupported_media_type', 'Send application/json.');
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new ApiError(413, 'request_too_large', 'Request exceeds the configured body limit.');
  let size = 0; const parts = [];
  const abort = () => req.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const part of req) {
      size += part.length;
      if (size > limit) throw new ApiError(413, 'request_too_large', 'Request exceeds the configured body limit.');
      parts.push(part);
    }
  } finally { signal.removeEventListener('abort', abort); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_request', 'Invalid JSON body.'); }
}

export function createGateway({ llm, ctx, store, cfg }) {
  let active = 0;
  let count = 0;
  let windowStart = Date.now();
  let cache; let cacheAt = 0; let providerIds = new Set();
  const controllers = new Set();
  const stats = { calls: 0, failed: 0, withoutUsage: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, since: Date.now() };

  function tally(raw, failed) {
    const metrics = usageMetrics(raw, failed);
    stats.calls += metrics.requests;
    stats.failed += metrics.failedRequests;
    stats.withoutUsage += metrics.unknownUsageRequests;
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens']) stats[key] += metrics[key];
  }

  async function catalog() {
    if (cache && Date.now() - cacheAt < cfg.modelCacheMs) return cache;
    const providers = await llm.listProviders();
    const rows = await Promise.all(providers.map(async provider => {
      try {
        return await Promise.all((await llm.listModels(provider.id)).map(async model => {
          let info;
          // Capability lookup is advisory; an unavailable adapter must not hide its base models.
          try { info = await llm.resolveModelInfo?.(provider.id, model.id); } catch {}
          return {
            id: `${provider.id}/${model.id}`, object: 'model', created: 0, owned_by: provider.id,
            provider: provider.id, model: model.id, name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
            ...(model.description ? { description: model.description } : {}),
            ...(Array.isArray(model.inputModalities) ? { input_modalities: model.inputModalities } : {}),
            ...(info ? { reasoning_efforts: (info.reasoning?.efforts ?? []).map(effort => effort.id) } : {}),
            ...(info?.reasoning?.defaultEffort !== undefined ? { default_reasoning_effort: info.reasoning.defaultEffort } : {}),
          };
        }));
      } catch { return []; }
    }));
    const baseModels = rows.flat();
    const canonicalIds = new Set(baseModels.map(model => model.id));
    cache = baseModels.flatMap(model => [model, ...(model.reasoning_efforts ?? [])
      .filter(effort => !canonicalIds.has(`${model.id}@${effort}`))
      .map(effort => ({
        ...model, id: `${model.id}@${effort}`, name: `${model.name} (${effort})`,
        base_model: model.id, reasoning_effort: effort, default_reasoning_effort: effort,
      }))]);
    providerIds = new Set(providers.map(provider => provider.id));
    cacheAt = Date.now(); return cache;
  }

  function allowed(model, settings = store.getSettings?.() ?? { allowedProviders: null, allowedModels: null }) {
    return (settings.allowedProviders === null || settings.allowedProviders.includes(model.provider))
      && (settings.allowedModels === null || settings.allowedModels.includes(model.base_model ?? model.id));
  }

  async function models() {
    const all = await catalog();
    const settings = store.getSettings?.() ?? { allowedProviders: null, allowedModels: null };
    if (settings.allowedProviders === null && settings.allowedModels === null) return all;
    return all.filter(model => allowed(model, settings));
  }

  async function updateSettings(settings) {
    const patch = validateSettings(settings);
    const all = await catalog();
    const canonicalIds = new Set(all.filter(model => !model.base_model).map(model => model.id));
    if (patch.allowedProviders?.some(id => !providerIds.has(id))) throw new ApiError(400, 'invalid_settings', 'Unknown provider id.');
    if (patch.allowedModels?.some(id => !canonicalIds.has(id))) throw new ApiError(400, 'invalid_settings', 'Select canonical model ids from the catalog, not aliases or effort variants.');
    return store.updateSettings(patch);
  }

  async function handler(req, res) {
    let client; let tracked = false; let rawUsage; let ok = false;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const authz = req.headers.authorization;
      client = typeof authz === 'string' && authz.startsWith('Bearer ') ? store.lookup(authz.slice(7)) : undefined;
      if (!client) throw new ApiError(401, 'invalid_api_key', 'A valid Bearer API key is required.');

      if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: await models() });

      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) {
        throw new ApiError(404, 'not_found', 'Supported endpoints: GET /v1/models, POST /v1/chat/completions, POST /v1/responses.');
      }
      tracked = true;
      if (Date.now() - windowStart >= 60000) { count = 0; windowStart = Date.now(); }
      if (active >= cfg.maxConcurrent || count >= cfg.requestsPerMinute) {
        res.setHeader('retry-after', '60');
        throw new ApiError(429, 'rate_limit_exceeded', 'Outlet request limit reached.');
      }
      active++; count++;

      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(new ApiError(504, 'timeout', 'Request timed out.')), cfg.timeoutMs);
      const close = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', close);
      const setRawUsage = usage => { rawUsage = usage; };

      try {
        const body = await bodyOf(req, cfg.bodyLimit, controller.signal);
        const isChat = url.pathname === '/v1/chat/completions';
        const modelList = await models();
        const converted = isChat ? await convertChatRequest(body, ctx, cfg, modelList) : await convertResponsesRequest(body, ctx, cfg, modelList);
        // Image admission may await I/O; enforce the current selection again before calling upstream.
        if (!allowed(converted.route)) throw new ApiError(404, 'model_not_found', 'This model is not open for proxying.');
        const call = await llm.prepareCall(converted.request, controller.signal);
        const created = Math.floor(Date.now() / 1000);

        if (converted.stream) {
          if (converted.protocol === 'responses') await responsesStream(res, controller, call, converted, setRawUsage);
          else await chatStream(res, controller, call, converted, setRawUsage);
        } else {
          const assembled = await assemble(call, converted.request, controller, setRawUsage);
          if (controller.signal.aborted || res.destroyed) throw controller.signal.reason ?? new ApiError(499, 'cancelled', 'Client disconnected.');
          if (converted.protocol === 'responses') json(res, 200, responsesCompletion('resp_' + randomUUID(), created, converted.model, assembled));
          else json(res, 200, chatCompletion('chatcmpl-' + randomUUID(), created, converted.model, assembled));
        }
        ok = true;
      } finally {
        clearTimeout(timer);
        res.off('close', close);
        controller.abort();
        controllers.delete(controller);
        active--;
      }
    } catch (error) {
      const { errorResponse } = await import('./sse.js');
      errorResponse(res, error);
    } finally {
      if (tracked) {
        tally(rawUsage, !ok);
        try { await store.recordUsage?.({ clientId: client.id, usage: rawUsage, failed: !ok }); }
        catch { ctx.logger?.warn?.('Outlet usage could not be persisted.'); }
      }
    }
  }

  return { handler, catalog, models, updateSettings, status: () => ({ active, maxConcurrent: cfg.maxConcurrent, requestsPerMinute: cfg.requestsPerMinute, usage: { ...stats } }), dispose: () => { for (const c of controllers) c.abort(); } };
}

/** Chat Completions SSE: chat.completion.chunk envelope. */
async function chatStream(res, controller, call, converted, setRawUsage) {
  const envelope = { object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: converted.model };
  const id = 'chatcmpl-' + randomUUID();
  let text = ''; let reasoning = ''; let usage; let finish;
  const tools = [];
  const seen = new Map();

  const emit = (data) => sseWrite(res, controller, { id, ...envelope, ...data });

  for await (const chunk of call.stream({ ...converted.request, ...call.config, signal: controller.signal })) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      seen.set(chunk.index, (seen.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'text-delta') { text += chunk.text; await emit({ choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }); }
      else { reasoning += chunk.text; await emit({ choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] }); }
    } else if (chunk.type === 'block-end') {
      if (['text', 'reasoning'].includes(chunk.block.type)) {
        const prior = seen.get(chunk.index) ?? '';
        const suffix = chunk.block.text.startsWith(prior) ? chunk.block.text.slice(prior.length) : '';
        if (suffix) {
          if (chunk.block.type === 'text') { text += suffix; await emit({ choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }] }); }
          else { reasoning += suffix; await emit({ choices: [{ index: 0, delta: { reasoning_content: suffix }, finish_reason: null }] }); }
        }
      } else if (chunk.block.type === 'tool-call') {
        const tool = { id: chunk.block.id, type: 'function', function: { name: chunk.block.name, arguments: chunk.block.arguments } };
        const index = tools.length; tools.push(tool);
        await emit({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...tool }] }, finish_reason: null }] });
      }
    } else if (chunk.type === 'usage') {
      const u = chunk.usage;
      setRawUsage(u);
      if (u === null || u === undefined) continue;
      usage = { prompt_tokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), completion_tokens: u.outputTokens ?? 0, total_tokens: u.totalTokens ?? 0 };
    } else if (chunk.type === 'finish') {
      if (['error', 'aborted'].includes(chunk.reason.kind)) throw controller.signal.aborted ? controller.signal.reason : upstreamFailure(chunk.reason.failure?.code ?? chunk.reason.kind);
      finish = chunk.reason.kind === 'max-tokens' ? 'length' : chunk.reason.kind === 'tool-calls' ? 'tool_calls' : 'stop';
      break;
    }
  }
  if (!finish) throw new ApiError(502, 'stream_incomplete', 'DSH provider ended without a completion.');
  await emit({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  if (converted.includeUsage && usage) await emit({ choices: [], usage });
  res.end('data: [DONE]\n\n');
}

/**
 * OpenAI Responses SSE semantics (subset). Event stream events:
 *   response.created
 *   response.in_progress
 *   response.output_item.added
 *   response.content_part.added
 *   response.output_text.delta
 *   response.function_call_arguments.delta
 *   response.function_call_arguments.done
 *   response.output_item.done
 *   response.completed
 */
async function responsesStream(res, controller, call, converted, setRawUsage) {
  const respId = 'resp_' + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const ev = (type, payload) => sseWrite(res, controller, { type, ...payload });

  await ev('response.created', { response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: converted.model, output: [] } });
  await ev('response.in_progress', { response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: converted.model, output: [] } });

  let usage; let finish;
  const seen = new Map();
  const openItems = new Map(); // output index -> { type, id, call_id?, name?, args }
  let nextIndex = 0;
  let textItemIndex = null;
  let toolItemIndex = null;

  const ensureTextItem = async () => {
    if (textItemIndex !== null) return;
    textItemIndex = nextIndex++;
    openItems.set(textItemIndex, { type: 'message', id: 'msg_' + randomUUID(), role: 'assistant', text: '' });
    await ev('response.output_item.added', { output_index: textItemIndex, item: { type: 'message', id: openItems.get(textItemIndex).id, status: 'in_progress', role: 'assistant', content: [] } });
    await ev('response.content_part.added', { item_id: openItems.get(textItemIndex).id, output_index: textItemIndex, content_index: 0, part: { type: 'output_text', text: '' } });
  };

  const ensureToolItem = async (name, callId) => {
    toolItemIndex = nextIndex++;
    openItems.set(toolItemIndex, { type: 'function_call', id: callId, call_id: callId, name, arguments: '' });
    await ev('response.output_item.added', { output_index: toolItemIndex, item: { type: 'function_call', id: callId, call_id: callId, name, arguments: '' } });
  };

  for await (const chunk of call.stream({ ...converted.request, ...call.config, signal: controller.signal })) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      seen.set(chunk.index, (seen.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'text-delta') {
        await ensureTextItem();
        openItems.get(textItemIndex).text += chunk.text;
        await ev('response.output_text.delta', { item_id: openItems.get(textItemIndex).id, output_index: textItemIndex, content_index: 0, delta: chunk.text });
      }
      // reasoning-delta has no Responses surface; accumulated and discarded (not silently claimed as output).
    } else if (chunk.type === 'block-end') {
      const block = chunk.block;
      if (block.type === 'text' || block.type === 'reasoning') {
        const prior = seen.get(chunk.index) ?? '';
        const suffix = block.text.startsWith(prior) ? block.text.slice(prior.length) : '';
        if (suffix && block.type === 'text') {
          await ensureTextItem();
          openItems.get(textItemIndex).text += suffix;
          await ev('response.output_text.delta', { item_id: openItems.get(textItemIndex).id, output_index: textItemIndex, content_index: 0, delta: suffix });
        }
      } else if (block.type === 'tool-call') {
        await ensureToolItem(block.name, block.id);
        if (block.arguments) {
          openItems.get(toolItemIndex).arguments = block.arguments;
          await ev('response.function_call_arguments.delta', { item_id: block.id, output_index: toolItemIndex, delta: block.arguments });
        }
      }
    } else if (chunk.type === 'usage') {
      const u = chunk.usage;
      setRawUsage(u);
      if (u === null || u === undefined) continue;
      usage = { input_tokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), output_tokens: u.outputTokens ?? 0, total_tokens: u.totalTokens ?? 0 };
    } else if (chunk.type === 'finish') {
      if (['error', 'aborted'].includes(chunk.reason.kind)) throw controller.signal.aborted ? controller.signal.reason : upstreamFailure(chunk.reason.failure?.code ?? chunk.reason.kind);
      finish = chunk.reason.kind === 'max-tokens' ? 'max_output_tokens' : chunk.reason.kind === 'tool-calls' ? 'completed' : 'completed';
      break;
    }
  }
  if (!finish) throw new ApiError(502, 'stream_incomplete', 'DSH provider ended without a completion.');

  // Close open items.
  for (const [idx, item] of openItems) {
    if (item.type === 'function_call') {
      await ev('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments });
      await ev('response.output_item.done', { output_index: idx, item: { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments } });
    } else {
      await ev('response.output_item.done', { output_index: idx, item: { type: 'message', id: item.id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text ?? '' }] } });
    }
  }

  const output = [...openItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => {
    if (item.type === 'function_call') return { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments };
    return { type: 'message', id: item.id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text ?? '' }] };
  });

  await ev('response.completed', { response: { id: respId, object: 'response', created_at: created, status: 'completed', model: converted.model, output, ...(usage ? { usage } : {}) } });
  res.end('data: [DONE]\n\n');
}

async function assemble(call, request, controller, setRawUsage) {
  let text = ''; let reasoning = ''; let usage; let finish;
  const tools = []; const seen = new Map();
  for await (const chunk of call.stream({ ...request, ...call.config, signal: controller.signal })) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      seen.set(chunk.index, (seen.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'text-delta') text += chunk.text; else reasoning += chunk.text;
    } else if (chunk.type === 'block-end') {
      if (['text', 'reasoning'].includes(chunk.block.type)) {
        const prior = seen.get(chunk.index) ?? '';
        const suffix = chunk.block.text.startsWith(prior) ? chunk.block.text.slice(prior.length) : '';
        if (suffix) { if (chunk.block.type === 'text') text += suffix; else reasoning += suffix; }
      } else if (chunk.block.type === 'tool-call') {
        tools.push({ id: chunk.block.id, type: 'function', function: { name: chunk.block.name, arguments: chunk.block.arguments } });
      }
    } else if (chunk.type === 'usage') {
      const u = chunk.usage;
      setRawUsage(u);
      if (u === null || u === undefined) continue;
      usage = { prompt_tokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), completion_tokens: u.outputTokens ?? 0, total_tokens: u.totalTokens ?? 0 };
    } else if (chunk.type === 'finish') {
      if (['error', 'aborted'].includes(chunk.reason.kind)) throw controller.signal.aborted ? controller.signal.reason : upstreamFailure(chunk.reason.failure?.code ?? chunk.reason.kind);
      finish = chunk.reason.kind === 'max-tokens' ? 'length' : chunk.reason.kind === 'tool-calls' ? 'tool_calls' : 'stop';
      break;
    }
  }
  if (!finish) throw new ApiError(502, 'stream_incomplete', 'DSH provider ended without a completion.');
  return { text, reasoning, tools, usage, finish };
}

function chatCompletion(id, created, model, a) {
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: a.text || (a.tools.length ? null : ''), ...(a.reasoning ? { reasoning_content: a.reasoning } : {}), ...(a.tools.length ? { tool_calls: a.tools } : {}) }, finish_reason: a.finish }],
    ...(a.usage ? { usage: a.usage } : {}),
  };
}

function responsesCompletion(id, created, model, a) {
  const output = [];
  if (a.text) output.push({ type: 'message', id: 'msg_' + randomUUID(), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: a.text }] });
  for (const t of a.tools) output.push({ type: 'function_call', id: t.id, call_id: t.id, name: t.function.name, arguments: t.function.arguments });
  return {
    id, object: 'response', created_at: created, model, status: 'completed',
    output,
    ...(a.usage ? { usage: { input_tokens: a.usage.prompt_tokens, output_tokens: a.usage.completion_tokens, total_tokens: a.usage.total_tokens } } : {}),
  };
}
