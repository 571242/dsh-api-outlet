import { randomUUID } from 'node:crypto';
import { ApiError, invalid, unsupportedField } from './errors.js';
import { resolveRoute, supportsImage } from './models.js';
import { responsesImageUrl, admitImages } from './images.js';
import { readReasoningEffort } from './reasoning.js';

// Known top-level fields: supported + explicitly-rejected. Anything else 400.
const SUPPORTED_FIELDS = ['model', 'input', 'instructions', 'temperature', 'max_output_tokens', 'reasoning_effort', 'reasoning', 'tools', 'tool_choice', 'stream'];
const REJECTED_FIELDS = ['previous_response_id', 'store', 'metadata', 'service_tier', 'safety_identifier', 'user', 'parallel_tool_calls', 'include'];
const KNOWN_FIELDS = new Set([...SUPPORTED_FIELDS, ...REJECTED_FIELDS]);

const INPUT_ITEM_TYPES = new Set(['message', 'function_call', 'function_call_output']);

/** Collect input_image data-URLs across all input items (request-level). */
function collectResponsesImages(input) {
  const urls = [];
  const marks = []; // { itemIndex, partIndex }
  for (let ii = 0; ii < input.length; ii++) {
    const content = input[ii]?.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi];
      if (part?.type === 'input_image') { urls.push(responsesImageUrl(part)); marks.push({ ii, pi }); }
    }
  }
  return { urls, marks };
}

export async function convertResponsesRequest(body, ctx, cfg, modelList) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object.');

  // Strict unknown-field rejection.
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) throw unsupportedField(key, [...SUPPORTED_FIELDS, ...REJECTED_FIELDS]);
  }

  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');

  for (const key of REJECTED_FIELDS) {
    if (body[key] !== undefined) throw unsupportedField(key, SUPPORTED_FIELDS);
  }

  const route = resolveRoute(body.model, modelList, cfg.aliases);
  if (!route) throw new ApiError(404, 'model_not_found', 'Unknown model. Select an exact id from GET /v1/models.');
  const effort = readReasoningEffort(body, route);

  let input = body.input;
  if (input === undefined || input === null) input = [];
  if (typeof input === 'string') input = [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) invalid('input must be a non-empty array of input items.');

  // OpenAI easy input messages may omit type; keep explicit unknown types invalid.
  input = input.map(item => item && item.type === undefined && typeof item.role === 'string'
    ? { ...item, type: 'message' } : item);

  // Validate every input item type up front.
  for (const item of input) {
    if (!item || typeof item !== 'object' || !INPUT_ITEM_TYPES.has(item.type)) {
      invalid(`Unsupported input item type "${item?.type}". Supported: message, function_call, function_call_output.`);
    }
  }

  // ---- Request-level image pre-flight ----
  const { urls, marks } = collectResponsesImages(input);
  if (urls.length > 0 && !supportsImage(route)) {
    throw new ApiError(400, 'image_unsupported',
      `Model "${route.id}" does not accept image input. Use a vision-capable model.`);
  }
  const refs = urls.length > 0 ? await admitImages(urls, ctx, cfg) : [];

  const request = { provider: route.provider, model: route.model, messages: [] };

  if (body.instructions !== undefined) {
    if (typeof body.instructions !== 'string') invalid('instructions must be a string.');
    request.messages.push({ id: randomUUID(), role: 'system', content: [{ type: 'text', text: body.instructions }], source: { kind: 'system-prompt' } });
  }

  for (let ii = 0; ii < input.length; ii++) {
    const item = input[ii];
    switch (item.type) {
      case 'message': {
        const role = item.role;
        if (!['user', 'assistant', 'system', 'developer'].includes(role)) invalid('message item role must be user/assistant/system/developer.');
        const r = role === 'developer' ? 'system' : role;
        const content = responsesContent(item.content, ii, refs, marks);
        request.messages.push({ id: randomUUID(), role: r, content, source: r === 'user' ? { kind: 'user' } : r === 'assistant' ? { kind: 'model', provider: route.provider, model: route.model } : { kind: 'system-prompt' } });
        break;
      }
      case 'function_call': {
        if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || typeof item.arguments !== 'string') invalid('function_call item requires call_id, name, and arguments.');
        request.messages.push({ id: randomUUID(), role: 'assistant', content: [{ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments }], source: { kind: 'model', provider: route.provider, model: route.model } });
        break;
      }
      case 'function_call_output': {
        if (typeof item.call_id !== 'string' || !item.call_id) invalid('function_call_output item requires call_id.');
        const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        request.messages.push({ id: randomUUID(), role: 'tool', content: [{ type: 'text', text: out }], toolCallId: item.call_id, isError: false, source: { kind: 'tool', callId: item.call_id } });
        break;
      }
      default:
        invalid(`Unsupported input item type "${item.type}".`);
    }
  }

  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) invalid('temperature must be between 0 and 2.');
    request.temperature = body.temperature;
  }
  if (body.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0 || body.max_output_tokens > cfg.maxTokens) invalid('Invalid max_output_tokens.');
    request.maxTokens = body.max_output_tokens;
  }
  if (effort !== undefined) request.reasoningEffort = effort;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > cfg.maxTools) invalid('Invalid tools array.');
    const tools = [];
    for (const t of body.tools) {
      if (t?.type === 'function') {
        if (typeof t.name !== 'string' || !t.name || !t.parameters || typeof t.parameters !== 'object' || Array.isArray(t.parameters)) invalid('Invalid function tool schema.');
        tools.push({ name: t.name, description: t.description ?? '', parameters: t.parameters });
      } else {
        throw unsupportedField('tools[' + t?.type + ']', ['function']);
      }
    }
    if (body.tool_choice !== 'none') request.tools = tools;
  }
  if (body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice)) invalid('Only auto/none tool_choice is supported.');

  return { request, route, stream: body.stream === true, model: body.model, protocol: 'responses' };
}

/** Build DSH content blocks for one responses input item, inserting pre-admitted image refs. */
function responsesContent(content, itemIndex, refs, marks) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) invalid('message content must be a string or an array.');
  const imageIndex = new Map();
  for (let k = 0; k < marks.length; k++) {
    if (marks[k].ii === itemIndex) imageIndex.set(marks[k].pi, k);
  }
  const blocks = [];
  for (let pi = 0; pi < content.length; pi++) {
    const part = content[pi];
    if (!part || typeof part !== 'object') invalid('content parts must be objects.');
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') invalid('text content part requires a string "text".');
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const k = imageIndex.get(pi);
      if (k === undefined) invalid('Internal image indexing error.');
      blocks.push({ type: 'image', attachment: refs[k] });
    } else {
      invalid(`Unsupported content part type "${part.type}".`);
    }
  }
  return blocks;
}
