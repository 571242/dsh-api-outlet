import { ApiError, invalid, unsupportedField } from './errors.js';
import { textBlocks, toolCallBlock, newMessageId } from './messages.js';
import { resolveRoute, supportsImage } from './models.js';
import { chatImageUrl, admitImages } from './images.js';
import { readReasoningEffort } from './reasoning.js';

// Known top-level fields, both supported and explicitly-rejected. Anything
// else is rejected as unknown (never silently dropped).
const SUPPORTED_FIELDS = ['model', 'messages', 'stream', 'stream_options', 'temperature', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'tools', 'tool_choice', 'n', 'store'];
const REJECTED_FIELDS = ['stop', 'frequency_penalty', 'presence_penalty', 'logprobs', 'logit_bias', 'response_format', 'functions', 'function_call', 'seed', 'top_p', 'top_k', 'service_tier', 'user'];
const KNOWN_FIELDS = new Set([...SUPPORTED_FIELDS, ...REJECTED_FIELDS]);

/** Walk every message and collect image data-URLs in document order. */
function collectChatImages(messages) {
  const urls = [];
  const marks = []; // { msgIndex, partIndex } per image occurrence
  for (let mi = 0; mi < messages.length; mi++) {
    const content = messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi];
      if (part?.type === 'image_url') { urls.push(chatImageUrl(part)); marks.push({ mi, pi }); }
    }
  }
  return { urls, marks };
}

/**
 * Convert an OpenAI Chat Completions request into a DSH llm request.
 * Image admission is pre-flighted: count, model capability, URL/MIME/base64 and
 * per-image size are all validated and the batch committed atomically BEFORE
 * any prepareCall. No partial save can precede a later non-conforming image.
 */
export async function convertChatRequest(body, ctx, cfg, modelList) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object.');

  // Strict unknown-field rejection (no silent swallow of important semantics).
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) throw unsupportedField(key, [...SUPPORTED_FIELDS, ...REJECTED_FIELDS]);
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  // `store: false` is the OpenAI-compatible client default (pi-ai always sends
  // it for standard routes) and is a no-op here: this outlet is stateless and
  // stores nothing. Only `store: true` has semantics we cannot honor.
  if (body.store !== undefined) {
    if (typeof body.store !== 'boolean') invalid('store must be a boolean.');
    if (body.store !== false) throw unsupportedField('store', SUPPORTED_FIELDS);
  }
  if (body.n !== undefined && body.n !== 1) invalid('Only n=1 is supported.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > cfg.maxMessages) {
    invalid(`messages must contain between 1 and ${cfg.maxMessages} messages.`);
  }

  const route = resolveRoute(body.model, modelList, cfg.aliases);
  if (!route) throw new ApiError(404, 'model_not_found', 'Unknown model. Select an exact id from GET /v1/models.');
  const effort = readReasoningEffort(body, route);

  for (const key of REJECTED_FIELDS) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    // DSH has no nucleus-sampling control; accept only the OpenAI default as a no-op.
    if (key === 'top_p' && v === 1) continue;
    if (['frequency_penalty', 'presence_penalty'].includes(key) && v === 0) continue;
    if (key === 'stop' && Array.isArray(v) && v.length === 0) continue;
    throw unsupportedField(key, SUPPORTED_FIELDS);
  }
  if (body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice)) invalid('Only auto/none tool_choice is supported.');

  // ---- Request-level image pre-flight ----
  const { urls, marks } = collectChatImages(body.messages);
  if (urls.length > 0 && !supportsImage(route)) {
    throw new ApiError(400, 'image_unsupported',
      `Model "${route.id}" does not accept image input. Use a vision-capable model.`);
  }
  const refs = urls.length > 0 ? await admitImages(urls, ctx, cfg) : [];

  const request = { provider: route.provider, model: route.model, messages: [] };

  for (let mi = 0; mi < body.messages.length; mi++) {
    const msg = body.messages[mi];
    if (!msg || !['system', 'developer', 'user', 'assistant', 'tool'].includes(msg.role)) invalid('Invalid message role.');
    const id = newMessageId();
    const role = msg.role === 'developer' ? 'system' : msg.role;

    if (role === 'assistant') {
      if (msg.tool_calls !== undefined && !Array.isArray(msg.tool_calls)) invalid('tool_calls must be an array.');
      const blocks = textBlocks(msg.content).concat((msg.tool_calls ?? []).map(toolCallBlock));
      request.messages.push({ id, role: 'assistant', content: blocks, source: { kind: 'model', provider: route.provider, model: route.model } });
    } else if (role === 'tool') {
      if (typeof msg.tool_call_id !== 'string' || !msg.tool_call_id) invalid('Tool messages require tool_call_id.');
      request.messages.push({ id, role: 'tool', content: textBlocks(msg.content), toolCallId: msg.tool_call_id, isError: false, source: { kind: 'tool', callId: msg.tool_call_id } });
    } else {
      request.messages.push({ id, role, content: await chatMessageBlocks(msg.content, mi, refs, marks), source: role === 'user' ? { kind: 'user' } : { kind: 'system-prompt' } });
    }
  }

  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) invalid('temperature must be between 0 and 2.');
    request.temperature = body.temperature;
  }
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) {
    if (!Number.isSafeInteger(max) || max <= 0 || max > cfg.maxTokens) invalid('Invalid max_tokens.');
    request.maxTokens = max;
  }
  if (effort !== undefined) request.reasoningEffort = effort;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > cfg.maxTools) invalid('Invalid tools array.');
    const tools = body.tools.map(t => {
      if (t?.type !== 'function' || typeof t.function?.name !== 'string' || !t.function.name
          || !t.function.parameters || typeof t.function.parameters !== 'object' || Array.isArray(t.function.parameters)) {
        invalid('Invalid function tool schema. Only type "function" tools are supported.');
      }
      return { name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters };
    });
    if (body.tool_choice !== 'none') request.tools = tools;
  }

  return { request, route, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, model: body.model, protocol: 'chat' };
}

/** Build DSH content blocks for one user/system message, inserting pre-admitted image refs. */
async function chatMessageBlocks(content, msgIndex, refs, marks) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) invalid('message content must be a string or an array.');
  // Build an image index lookup for this message.
  const imageIndex = new Map();
  for (let k = 0; k < marks.length; k++) {
    if (marks[k].mi === msgIndex) imageIndex.set(marks[k].pi, k);
  }
  const blocks = [];
  for (let pi = 0; pi < content.length; pi++) {
    const part = content[pi];
    if (!part || typeof part !== 'object') invalid('message content parts must be objects.');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') invalid('text content part requires a string "text".');
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const k = imageIndex.get(pi);
      if (k === undefined) invalid('Internal image indexing error.');
      blocks.push({ type: 'image', attachment: refs[k] });
    } else {
      invalid(`Unsupported content part type "${part.type}".`);
    }
  }
  return blocks;
}
