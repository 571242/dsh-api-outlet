import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiError } from './errors.js';

const KEY_RE = /^sk-outlet-[A-Za-z0-9_-]{32}$/;
const ADMIN_RE = /^oadmin-[A-Za-z0-9_-]{32}$/;
const CLIENT_ID_RE = /^[0-9a-f-]{36}$/;
const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
const METRIC_FIELDS = ['requests', 'failedRequests', 'unknownUsageRequests', ...TOKEN_FIELDS];
const emptyMetrics = () => Object.fromEntries(METRIC_FIELDS.map(key => [key, 0]));
const isCount = value => Number.isSafeInteger(value) && value >= 0;

function digestOf(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
const newKey = () => 'sk-outlet-' + randomBytes(24).toString('base64url');
const newAdmin = () => 'oadmin-' + randomBytes(24).toString('base64url');

/** Validate the settings shape here; the gateway validates catalog membership. */
export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(settings))) {
    throw new ApiError(400, 'invalid_settings', 'Settings must be a JSON object.');
  }
  const result = {};
  for (const key of Object.keys(settings)) {
    if (!['allowedProviders', 'allowedModels'].includes(key)) throw new ApiError(400, 'invalid_settings', 'Unknown settings field.');
    const value = settings[key];
    if (value !== null && (!Array.isArray(value)
        || [...value].some(id => typeof id !== 'string' || !id.length || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id))
        || new Set(value).size !== value.length)) {
      throw new ApiError(400, 'invalid_settings', `${key} must be null or an array of unique non-empty ids.`);
    }
    result[key] = value === null ? null : [...value];
  }
  return result;
}

/** Only upstream-reported token counts are known; an absent/empty usage is not free. */
export function usageMetrics(usage, failed = false) {
  const metrics = emptyMetrics();
  metrics.requests = 1;
  metrics.failedRequests = failed ? 1 : 0;
  const known = TOKEN_FIELDS.some(key => isCount(usage?.[key]));
  metrics.unknownUsageRequests = known ? 0 : 1;
  for (const key of TOKEN_FIELDS) metrics[key] = isCount(usage?.[key]) ? usage[key] : 0;
  if (!isCount(usage?.totalTokens)) {
    metrics.totalTokens = metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens + metrics.outputTokens;
  }
  return metrics;
}

/**
 * Private key ledger, selection settings and per-client usage history.
 * Plaintext client keys are returned exactly once by create()/rotate(); the
 * admin token is stored only in the 0600 state file, never in HTTP responses.
 *
 * Every mutation captures a deep snapshot SYNCHRONOUSLY, then persists through
 * one serialized chain. Usage/lastUsedAt writes cannot overwrite a later key
 * rotation or revocation, even when their callers do not await them.
 */
export class StateStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.clients = [];
    this.adminToken = '';
    this.settings = { allowedProviders: null, allowedModels: null };
    this.usage = { since: Date.now(), clients: [] };
    this.revision = 0;
    this._seq = 0;
    this._writeChain = Promise.resolve();
  }

  async load() {
    let raw; let data;
    try { raw = await readFile(this.stateFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
    if (raw !== null) {
      try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); }
      catch { throw new Error('Outlet state is corrupt; restore or remove ' + this.stateFile); }
      const clients = Array.isArray(data?.clients) ? data.clients : [];
      for (const c of clients) {
        if (typeof c?.id !== 'string' || !CLIENT_ID_RE.test(c.id)) throw new Error('Outlet state has an invalid client id');
        if (typeof c?.digest !== 'string' || !/^[0-9a-f]{64}$/.test(c.digest)) throw new Error('Outlet state has an invalid digest');
        if (typeof c?.label !== 'string') c.label = '';
        if (typeof c?.createdAt !== 'string') throw new Error('Outlet state has an invalid createdAt');
        if (c?.lastUsedAt !== null && typeof c.lastUsedAt !== 'string') c.lastUsedAt = null;
      }
      this.clients = clients;
      this.adminToken = typeof data?.adminToken === 'string' && ADMIN_RE.test(data.adminToken) ? data.adminToken : '';
      this.revision = Number.isSafeInteger(data?.revision) ? data.revision : 0;
      if (data?.settings !== undefined) this.settings = { ...this.settings, ...validateSettings(data.settings) };
      if (data?.usage !== undefined) {
        if (!isCount(data.usage?.since) || !Array.isArray(data.usage?.clients)) throw new Error('Outlet state has invalid usage');
        const ids = new Set();
        this.usage = { since: data.usage.since, clients: data.usage.clients.map(row => {
          if (typeof row?.id !== 'string' || !CLIENT_ID_RE.test(row.id) || ids.has(row.id)) throw new Error('Outlet state has an invalid usage client id');
          ids.add(row.id);
          const metrics = emptyMetrics();
          for (const key of METRIC_FIELDS) {
            const value = row[key] === undefined ? 0 : row[key];
            if (!isCount(value)) throw new Error('Outlet state has an invalid usage count');
            metrics[key] = value;
          }
          return { id: row.id, label: typeof row.label === 'string' ? row.label : '', ...metrics };
        }) };
      }
    }
    const needsPersist = !this.adminToken || data?.settings === undefined || data?.usage === undefined;
    if (!this.adminToken) this.adminToken = newAdmin();
    if (needsPersist) await this._persist();
    return this;
  }

  _snapshot() {
    this.revision += 1;
    return {
      version: 1,
      revision: this.revision,
      adminToken: this.adminToken,
      ...JSON.parse(JSON.stringify({ clients: this.clients, settings: this.settings, usage: this.usage })),
    };
  }

  /** Queue a serialized persist of a snapshot captured at CALL time. */
  _persist() {
    const snapshot = this._snapshot();
    const task = async () => {
      const tmp = this.stateFile + '.' + process.pid + '.' + (this._seq++) + '.' + randomBytes(4).toString('hex') + '.tmp';
      await mkdir(dirname(this.stateFile), { recursive: true });
      await writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, this.stateFile);
    };
    // A failed write is reported to its caller, but must not poison later writes.
    this._writeChain = this._writeChain.then(task, task);
    return this._writeChain;
  }

  getSettings() {
    return { allowedProviders: this.settings.allowedProviders === null ? null : [...this.settings.allowedProviders], allowedModels: this.settings.allowedModels === null ? null : [...this.settings.allowedModels] };
  }

  async updateSettings(settings) {
    this.settings = { ...this.settings, ...validateSettings(settings) };
    const saved = this.getSettings();
    await this._persist();
    return saved;
  }

  _usageClient(id) {
    let row = this.usage.clients.find(client => client.id === id);
    if (!row) {
      const client = this.clients.find(client => client.id === id);
      if (!client) throw new Error('Unknown outlet usage client');
      row = { id, label: client.label, ...emptyMetrics() };
      this.usage.clients.push(row);
    }
    return row;
  }

  async recordUsage({ clientId, usage, failed = false }) {
    const row = this._usageClient(clientId);
    const metrics = usageMetrics(usage, failed);
    for (const key of METRIC_FIELDS) row[key] += metrics[key];
    await this._persist();
  }

  getUsage() {
    const active = new Map(this.clients.map(client => [client.id, client]));
    const history = new Map(this.usage.clients.map(row => [row.id, {
      id: row.id, label: active.get(row.id)?.label ?? row.label, revoked: !active.has(row.id),
      ...Object.fromEntries(METRIC_FIELDS.map(key => [key, row[key]])),
    }]));
    for (const client of this.clients) {
      if (!history.has(client.id)) history.set(client.id, { id: client.id, label: client.label, revoked: false, ...emptyMetrics() });
    }
    const clients = [...history.values()];
    const totals = emptyMetrics();
    for (const client of clients) for (const key of METRIC_FIELDS) totals[key] += client[key];
    return { since: this.usage.since, totals, clients };
  }

  async createClient(label = '') {
    const key = newKey();
    const client = { id: randomUUID(), label: String(label).slice(0, 120), digest: digestOf(key), createdAt: new Date().toISOString(), lastUsedAt: null };
    this.clients.push(client);
    await this._persist();
    return { id: client.id, label: client.label, key };
  }

  async rotateClient(id) {
    const client = this.clients.find(c => c.id === id);
    if (!client) return undefined;
    const key = newKey();
    client.digest = digestOf(key);
    await this._persist();
    return { id: client.id, label: client.label, key };
  }

  async revokeClient(id) {
    if (!this.clients.some(client => client.id === id)) return false;
    this._usageClient(id); // Keep the label and usage after the active key is removed.
    this.clients = this.clients.filter(c => c.id !== id);
    await this._persist();
    return true;
  }

  /** Timing-safe digest lookup; records lastUsedAt via a serialized persist. */
  lookup(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return undefined;
    const target = Buffer.from(digestOf(key), 'hex');
    let hit;
    for (const client of this.clients) {
      const stored = Buffer.from(client.digest, 'hex');
      if (stored.length === target.length && timingSafeEqual(stored, target)) { hit = client; break; }
    }
    if (hit) {
      const now = new Date().toISOString();
      if (hit.lastUsedAt !== now) {
        hit.lastUsedAt = now;
        this._persist().catch(() => {});
      }
    }
    return hit;
  }

  checkAdmin(token) {
    if (typeof token !== 'string' || !ADMIN_RE.test(token)) return false;
    const a = Buffer.from(token); const b = Buffer.from(this.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  listClients() {
    return this.clients.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  clientCount() { return this.clients.length; }

  /** Resolve when all queued writes have settled. */
  flushed() { return this._writeChain; }
}
