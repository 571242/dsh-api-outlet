import { once } from 'node:events';
import { ApiError } from './errors.js';

/** Write one SSE data event, honoring backpressure and aborted signal. */
export async function sseWrite(res, controller, data) {
  if (controller.signal.aborted) throw controller.signal.reason;
  if (res.destroyed) throw new ApiError(499, 'cancelled', 'Client disconnected.');
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }
  if (!res.write(`data: ${JSON.stringify(data)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
}

export function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

export function errorResponse(res, error) {
  const status = error instanceof ApiError ? error.status : 502;
  const code = error instanceof ApiError ? error.code : 'upstream_error';
  const message = error instanceof ApiError ? error.message : 'DSH model request failed.';
  const payload = {
    error: {
      message,
      type: status < 500 ? 'invalid_request_error' : 'api_error',
      code,
      ...(error instanceof ApiError && error.extra ? { param: error.extra.field ?? null } : {}),
    },
  };
  if (res.headersSent) {
    if (!res.destroyed) res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
  } else {
    json(res, status, payload);
  }
}
