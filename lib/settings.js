import { ApiError, invalid } from './errors.js';

const PREFIX = '/api/dsh-api-outlet';
const BODY_LIMIT = 64 * 1024;

function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function checkOrigin(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'forbidden', 'Cross-site management requests are not allowed.');
  const origin = request.headers.get('origin');
  if (origin === null) return;
  try {
    const source = new URL(origin);
    // Connection's Node carrier uses dsh.internal as the Fetch URL. Its trusted
    // Host header, not that synthetic URL or a forwarded header, is authoritative.
    const authority = request.headers.get('host') ?? new URL(request.url).host;
    const target = new URL(`${source.protocol}//${authority}`);
    if (['http:', 'https:'].includes(source.protocol) && source.host === target.host
        && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash) return;
  } catch {}
  throw new ApiError(403, 'forbidden', 'Management requests must use the current GUI origin.');
}

async function readSettings(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw new ApiError(415, 'unsupported_media_type', 'Send application/json.');
  if (Number(request.headers.get('content-length')) > BODY_LIMIT) throw new ApiError(413, 'request_too_large', 'Settings exceed the request size limit.');
  let size = 0;
  const chunks = [];
  if (request.body) for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > BODY_LIMIT) throw new ApiError(413, 'request_too_large', 'Settings exceed the request size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { invalid('Settings must be a JSON object.'); }
}

/** Registered through Connection.fetch, which admits authenticated owner Peers only. */
export function createSettingsRoutes({ store, gateway }) {
  const snapshot = async () => ({ settings: store.getSettings(), catalog: await gateway.catalog(), usage: store.getUsage() });
  const handle = (method, action) => async request => {
    try {
      if (request.method !== method) throw new ApiError(405, 'method_not_allowed', `Use ${method}.`);
      checkOrigin(request);
      request.signal.throwIfAborted();
      return response(200, await action(request));
    } catch (error) {
      return response(error instanceof ApiError ? error.status : 500, { error: {
        code: error instanceof ApiError ? error.code : 'management_error',
        message: error instanceof ApiError ? error.message : 'Unable to update or read API outlet settings.',
      } });
    }
  };
  return [
    { path: `${PREFIX}/snapshot`, methods: ['GET'], requestBody: 'buffered', fetch: handle('GET', snapshot) },
    { path: `${PREFIX}/settings`, methods: ['POST'], requestBody: 'streaming', fetch: handle('POST', async request => {
      await gateway.updateSettings(await readSettings(request));
      return snapshot();
    }) },
  ];
}

export function mountSettingsBridge(ctx, controls) {
  ctx.inject(['connection'], scoped => {
    for (const route of createSettingsRoutes(controls)) scoped.connection.fetch.register(route);
  });
  ctx.inject(['settings'], scoped => {
    scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber), 'api-outlet: custom plugin configuration');
  });
}
