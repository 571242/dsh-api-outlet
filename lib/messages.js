import { randomUUID } from 'node:crypto';
import { invalid } from './errors.js';

export const CHAT_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

/** Convert chat-completions style content into DSH text blocks (no images). */
export function textBlocks(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') invalid('message content parts must be objects.');
      if (part.type === 'text') {
        if (typeof part.text !== 'string') invalid('text content part requires a string "text".');
        blocks.push({ type: 'text', text: part.text });
      } else {
        invalid('Only "text" content parts are accepted here; images use "image_url".');
      }
    }
    return blocks;
  }
  invalid('message content must be a string or an array of content parts.');
}

export function toolCallBlock(call) {
  if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id
      || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') {
    invalid('Invalid function tool call.');
  }
  return { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments };
}

export function newMessageId() { return randomUUID(); }
