import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeConfig } from './config.js';
import { createGateway } from './gateway.js';
import { createAdmin } from './admin.js';
import { StateStore } from './keys.js';
import { mountSettingsBridge } from './settings.js';

export const name = 'dsh-api-outlet';
export const inject = ['llm'];

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

/**
 * Cloud DSH API outlet. Reuses ctx.llm.prepareCall with already-registered
 * providers. No tunnels, no second OAuth, no CLIProxyAPI. API + admin both
 * bind 127.0.0.1 only; the public edge terminates TLS and proxies /v1.
 */
export async function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  // Cloud profile dir is explicit; never infer from a Windows homedir.
  const profile = process.env.DSH_PROFILE_DIR
    ?? (config.profileDir || join(homedir(), '.dsh', 'profiles', 'cloud'));
  // `stateDir` is a DIRECTORY holding state.json (see ADMIN.md); `stateFile` is
  // an explicit file override. Deployments that pass a directory used to get the
  // state written to the directory path itself.
  const stateFile = cfg.stateFile ?? (cfg.stateDir ? join(cfg.stateDir, 'state.json') : join(profile, '.api-outlet', 'state.json'));

  const store = await new StateStore(stateFile).load();

  const gateway = createGateway({ llm: ctx.llm, ctx, store, cfg });
  const admin = createAdmin({ store, gateway, cfg });
  mountSettingsBridge(ctx, { store, gateway });

  const api = createServer(gateway.handler);
  api.requestTimeout = 0; // SSE streams may exceed HTTP server request timeout
  api.headersTimeout = 15000;

  const adminServer = createServer(admin);

  const dispose = async () => {
    gateway.dispose();
    api.closeAllConnections();
    adminServer.closeAllConnections();
    api.close();
    adminServer.close();
    await store.flushed();
  };
  ctx.effect(() => dispose, 'api-outlet: close API and admin servers');

  try {
    await listen(api, cfg.apiPort);
    await listen(adminServer, cfg.adminPort);
  } catch (error) {
    dispose();
    throw error;
  }

  ctx.logger?.info?.(`API outlet ready on http://127.0.0.1:${cfg.apiPort} (admin ${cfg.adminPort})`);
}
