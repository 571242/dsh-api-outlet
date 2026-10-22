import { ApiError } from './errors.js';
import { json } from './sse.js';

/**
 * Loopback-only admin server on 127.0.0.1:<adminPort>. It is NOT reachable from
 * the public network and never proxies DSH auth. Client keys are managed here;
 * plaintext keys are returned exactly once. Admin token is required and is
 * read from the 0600 state file, never from any route response.
 */
export function createAdmin({ store, gateway, cfg }) {
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

  return async (req, res) => {
    try {
      const host = String(req.headers.host ?? '').split(':')[0];
      if (!LOOPBACK.has(host)) throw new ApiError(403, 'local_only', 'Local administration only.');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.adminPort}`);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, clients: store.clientCount() });

      // Admin token check for everything else.
      const authz = req.headers['x-outlet-admin'] ?? '';
      if (!store.checkAdmin(authz)) throw new ApiError(401, 'invalid_admin_token', 'A valid x-outlet-admin token is required.');

      if (req.method === 'GET' && path === '/status') return json(res, 200, { gateway: gateway.status() });
      if (req.method === 'GET' && path === '/clients') return json(res, 200, { data: store.listClients() });
      if (req.method === 'GET' && path === '/models') return json(res, 200, { data: await gateway.models() });
      if (req.method === 'GET' && path === '/catalog') return json(res, 200, { data: await gateway.catalog() });
      if (req.method === 'GET' && path === '/settings') return json(res, 200, store.getSettings());
      if (req.method === 'GET' && path === '/usage') return json(res, 200, store.getUsage());

      if (req.method === 'POST') {
        let body = {}; let size = 0;
        if (Number(req.headers['content-length']) > cfg.bodyLimit) throw new ApiError(413, 'request_too_large', 'Request exceeds the configured body limit.');
        const chunks = [];
        for await (const part of req) {
          size += part.length;
          if (size > cfg.bodyLimit) throw new ApiError(413, 'request_too_large', 'Request exceeds the configured body limit.');
          chunks.push(part);
        }
        if (size) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_request', 'Invalid JSON body.'); }
        }
        if (path === '/settings') return json(res, 200, await gateway.updateSettings(body));
        if (path === '/clients') {
          const label = typeof body?.label === 'string' ? body.label : '';
          const created = await store.createClient(label);
          // plaintext key returned exactly once, only to the loopback admin caller
          return json(res, 200, { id: created.id, label: created.label, key: created.key });
        }
        if (path === '/clients/rotate') {
          const rotated = await store.rotateClient(body?.id);
          if (!rotated) throw new ApiError(404, 'client_not_found', 'Unknown client id.');
          return json(res, 200, { id: rotated.id, label: rotated.label, key: rotated.key });
        }
        if (path === '/clients/revoke') {
          const ok = await store.revokeClient(body?.id);
          if (!ok) throw new ApiError(404, 'client_not_found', 'Unknown client id.');
          return json(res, 200, { ok: true });
        }
        throw new ApiError(404, 'not_found', 'Not found.');
      }
      throw new ApiError(404, 'not_found', 'Not found.');
    } catch (error) {
      const { errorResponse } = await import('./sse.js');
      errorResponse(res, error);
    }
  };
}
