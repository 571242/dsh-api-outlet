'use strict';

const React = require('react');
const { Button, Checkbox, Input } = require('@deepseek-ai/dsh-client-ui-primitives');
const STYLE_TEXT = require('./styles.css');
const h = React.createElement;
const PACKAGE_NAME = '@oracle-ai/dsh-api-outlet';
const API_PREFIX = '/api/dsh-api-outlet';
const METRICS = ['requests', 'failedRequests', 'unknownUsageRequests', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
const numberFormat = new Intl.NumberFormat('zh-CN');

function copySettings(settings) {
  return {
    allowedProviders: settings.allowedProviders === null ? null : [...settings.allowedProviders],
    allowedModels: settings.allowedModels === null ? null : [...settings.allowedModels],
  };
}

function sameSelection(left, right) {
  if (left === null || right === null) return left === right;
  const selected = new Set(left);
  const other = new Set(right);
  return selected.size === other.size && [...selected].every(id => other.has(id));
}

function sameSettings(left, right) {
  return sameSelection(left.allowedProviders, right.allowedProviders) && sameSelection(left.allowedModels, right.allowedModels);
}

function toggleSelection(selection, id, checked, available) {
  const next = new Set(selection === null ? available : selection);
  if (checked) next.add(id);
  else next.delete(id);
  // An explicit list stays explicit: selecting today's catalog must not allow tomorrow's new models.
  return [...next];
}

function canonicalModels(catalog) {
  const models = new Map();
  for (const model of catalog) {
    if (!model.base_model && !models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
}

function effectiveCount(models, settings) {
  const providers = settings.allowedProviders === null ? null : new Set(settings.allowedProviders);
  const allowed = settings.allowedModels === null ? null : new Set(settings.allowedModels);
  return models.reduce((count, model) => count + Number((providers === null || providers.has(model.provider)) && (allowed === null || allowed.has(model.id))), 0);
}

function validateSnapshot(value) {
  const invalid = () => { throw new Error('插件返回的数据不完整，请刷新或检查插件版本。'); };
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const strings = item => Array.isArray(item) && item.every(entry => typeof entry === 'string' && entry.length > 0);
  if (!object(value) || !object(value.settings) || !Array.isArray(value.catalog) || !object(value.usage)) invalid();
  for (const field of ['allowedProviders', 'allowedModels']) {
    if (value.settings[field] !== null && !strings(value.settings[field])) invalid();
  }
  const catalog = value.catalog.map(model => {
    if (!object(model) || !['id', 'provider', 'model', 'name'].every(field => typeof model[field] === 'string' && model[field].length > 0)) invalid();
    if (model.base_model !== undefined && (typeof model.base_model !== 'string' || !model.base_model)) invalid();
    for (const field of ['input_modalities', 'reasoning_efforts']) {
      if (model[field] !== undefined && !strings(model[field])) invalid();
    }
    return {
      id: model.id, provider: model.provider, model: model.model, name: model.name,
      ...(model.base_model === undefined ? {} : { base_model: model.base_model }),
      input_modalities: [...(model.input_modalities ?? [])],
      reasoning_efforts: [...(model.reasoning_efforts ?? [])],
    };
  });
  const metrics = row => {
    if (!object(row) || !METRICS.every(field => Number.isSafeInteger(row[field]) && row[field] >= 0)) invalid();
    return Object.fromEntries(METRICS.map(field => [field, row[field]]));
  };
  const usage = value.usage;
  if (!Array.isArray(usage.clients) || !['string', 'number'].includes(typeof usage.since) || !Number.isFinite(new Date(usage.since).getTime())) invalid();
  const clients = usage.clients.map(client => {
    if (!object(client) || typeof client.id !== 'string' || !client.id || typeof client.label !== 'string' || typeof client.revoked !== 'boolean') invalid();
    return { id: client.id, label: client.label, revoked: client.revoked, ...metrics(client) };
  });
  if (new Set(clients.map(client => client.id)).size !== clients.length) invalid();
  return { settings: copySettings(value.settings), catalog, usage: { since: usage.since, totals: metrics(usage.totals), clients } };
}

function createApi(fetcher = globalThis.fetch.bind(globalThis)) {
  async function request(path, init) {
    let response;
    try {
      response = await fetcher(`${API_PREFIX}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch {
      throw new Error('无法连接宿主，请检查连接后重试。');
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('宿主登录已失效，请重新登录后重试。');
      if (response.status === 403) throw new Error('宿主拒绝了本次操作，请检查当前权限或刷新页面。');
      throw new Error(`宿主请求失败（HTTP ${response.status}），请稍后重试。`);
    }
    let value;
    try { value = await response.json(); }
    catch { throw new Error('宿主未返回有效数据，请刷新或检查插件版本。'); }
    return validateSnapshot(value);
  }
  return {
    loadSnapshot: () => request('/snapshot'),
    saveSettings: settings => request('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(copySettings(settings)) }),
  };
}

function createPanelStore(api) {
  let state = { snapshot: null, draft: null, busy: null, error: null, notice: '' };
  let requestId = 0;
  const listeners = new Set();
  const publish = patch => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const dirty = () => state.snapshot !== null && !sameSettings(state.snapshot.settings, state.draft);
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel() { requestId++; state = { ...state, busy: null }; },
    edit(field, selection) {
      if (!state.draft || state.busy || !['allowedProviders', 'allowedModels'].includes(field)) return;
      publish({ draft: { ...state.draft, [field]: selection === null ? null : [...selection] }, error: null, notice: '' });
    },
    discard() {
      if (!state.snapshot || state.busy) return;
      publish({ draft: copySettings(state.snapshot.settings), error: null, notice: '已撤销未保存的选择。' });
    },
    async load() {
      if (state.busy) return;
      const ticket = ++requestId;
      const preserveDraft = dirty();
      publish({ busy: 'loading', error: null, notice: '' });
      try {
        const snapshot = validateSnapshot(await api.loadSnapshot());
        if (ticket !== requestId) return;
        publish({ snapshot, draft: preserveDraft ? state.draft : copySettings(snapshot.settings), notice: preserveDraft ? '已刷新服务状态；未保存的选择已保留。' : '已读取最新服务状态。' });
      } catch (error) {
        if (ticket === requestId) publish({ error: { kind: 'load', message: `加载失败。${error instanceof Error ? error.message : '请检查连接后重试。'}` } });
      } finally {
        if (ticket === requestId) publish({ busy: null });
      }
    },
    async save() {
      if (!state.snapshot || state.busy || !dirty()) return;
      const ticket = ++requestId;
      const submitted = copySettings(state.draft);
      publish({ busy: 'saving', error: null, notice: '' });
      try {
        const snapshot = validateSnapshot(await api.saveSettings(submitted));
        if (ticket !== requestId) return;
        publish({ snapshot, draft: copySettings(snapshot.settings), notice: '已保存，并读取服务确认后的开放范围。' });
      } catch (error) {
        if (ticket === requestId) publish({ error: { kind: 'save', message: `保存失败。${error instanceof Error ? error.message : '请稍后重试。'} 草稿已保留；可刷新确认服务状态后重试。` } });
      } finally {
        if (ticket === requestId) publish({ busy: null });
      }
    },
  };
}

function selectionLabel(selection) {
  return selection === null ? '全部（含以后新增）' : selection.length === 0 ? '全部关闭' : `仅所选 ${numberFormat.format(selection.length)} 项`;
}

function modelCapabilities(model) {
  const modalities = { text: '文本', image: '图片', audio: '音频', video: '视频' };
  return [model.input_modalities.map(value => modalities[value] ?? value).join('、'), model.reasoning_efforts.length > 0 ? `思考档位：${model.reasoning_efforts.join(' / ')}` : ''].filter(Boolean).join('；');
}

function UsageSection({ usage, disabled, onReload, idPrefix }) {
  const [selectedId, setSelectedId] = React.useState('');
  const client = usage.clients.find(row => row.id === selectedId);
  const selected = client ?? usage.totals;
  const cells = [
    ['输入 token', selected.inputTokens], ['输出 token', selected.outputTokens],
    ['缓存读取 token', selected.cacheReadTokens], ['缓存写入 token', selected.cacheWriteTokens],
    ['总 token', selected.totalTokens], ['请求', selected.requests],
    ['失败请求', selected.failedRequests], ['未知 usage 请求', selected.unknownUsageRequests],
  ];
  return h('section', { className: 'dsh-outlet-section', 'aria-labelledby': `${idPrefix}-usage-title` },
    h('div', { className: 'dsh-outlet-heading' },
      h('h3', { id: `${idPrefix}-usage-title` }, '下游用量'),
      h(Button, { type: 'button', size: 'sm', variant: 'ghost', disabled, onClick: onReload }, '刷新用量')),
    h('p', { className: 'dsh-outlet-hint' }, `统计始于 ${new Date(usage.since).toLocaleString('zh-CN')}。只记录启用后的出口请求，不补造历史用量。`),
    h('label', { htmlFor: `${idPrefix}-client`, className: 'dsh-outlet-label' }, '查看下游客户端'),
    h('select', { id: `${idPrefix}-client`, className: 'dsh-outlet-select', value: client ? selectedId : '', onChange: event => setSelectedId(event.target.value) },
      h('option', { value: '' }, '全部下游客户端'),
      usage.clients.map(row => h('option', { key: row.id, value: row.id }, `${row.label || '未命名客户端'} · ${row.id}${row.revoked ? '（已撤销）' : ''}`))),
    client ? h('p', { className: 'dsh-outlet-hint' }, client.revoked ? '此客户端已撤销；历史用量仍保留。' : `正在查看：${client.label || '未命名客户端'}`) : null,
    h('dl', { className: 'dsh-outlet-metrics', 'aria-label': client ? `${client.label || '未命名客户端'}的用量` : '全部下游客户端的用量' },
      cells.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, numberFormat.format(value))))),
    selected.unknownUsageRequests > 0 ? h('p', { className: 'dsh-outlet-hint' }, '有请求未报告 usage，其 token 未补算；以上不是完整消耗估计。') : null,
    usage.clients.length === 0 ? h('p', { className: 'dsh-outlet-hint' }, '还没有下游客户端记录。') : null);
}

function OutletView({ state, onEdit, onSave, onDiscard, onReload }) {
  const [query, setQuery] = React.useState('');
  const deferredQuery = React.useDeferredValue(query.trim().toLocaleLowerCase());
  const idPrefix = `dsh-outlet-${React.useId().replace(/:/g, '')}`;
  const { snapshot, draft, busy, error, notice } = state;
  const models = React.useMemo(() => canonicalModels(snapshot?.catalog ?? []), [snapshot?.catalog]);
  const groups = React.useMemo(() => {
    const grouped = new Map();
    for (const model of models) {
      if (!grouped.has(model.provider)) grouped.set(model.provider, []);
      grouped.get(model.provider).push(model);
    }
    return grouped;
  }, [models]);
  const providers = React.useMemo(() => [...new Set([...groups.keys(), ...(snapshot?.settings.allowedProviders ?? []), ...(draft?.allowedProviders ?? [])])].sort(), [groups, snapshot?.settings.allowedProviders, draft?.allowedProviders]);
  const providerSet = React.useMemo(() => draft?.allowedProviders === null ? null : new Set(draft?.allowedProviders), [draft?.allowedProviders]);
  const modelSet = React.useMemo(() => draft?.allowedModels === null ? null : new Set(draft?.allowedModels), [draft?.allowedModels]);
  const visibleGroups = React.useMemo(() => [...groups].flatMap(([provider, entries]) => {
    const matches = entries.filter(model => `${provider} ${model.id} ${model.name} ${model.model}`.toLocaleLowerCase().includes(deferredQuery));
    return matches.length > 0 ? [[provider, matches]] : [];
  }), [groups, deferredQuery]);
  const disabled = busy !== null;
  const dirty = snapshot !== null && !sameSettings(snapshot.settings, draft);
  if (!snapshot) return h('div', { className: 'dsh-outlet', 'aria-busy': disabled },
    h('p', { role: error ? 'alert' : 'status', className: error ? 'dsh-outlet-error' : 'dsh-outlet-hint' }, error?.message ?? '正在加载开放范围与下游用量…'),
    error ? h(Button, { type: 'button', variant: 'outline', disabled, onClick: onReload }, '重新加载') : null);
  const allModelIds = models.map(model => model.id);
  return h('div', { className: 'dsh-outlet', 'aria-busy': disabled },
    h('div', { className: 'dsh-outlet-state', 'aria-label': '服务确认状态与待保存预览' },
      h('p', null, h('strong', null, '服务已确认'), `：来源 ${selectionLabel(snapshot.settings.allowedProviders)}；模型 ${selectionLabel(snapshot.settings.allowedModels)}；实际开放 ${numberFormat.format(effectiveCount(models, snapshot.settings))} 个基础模型。`),
      h('p', { className: 'dsh-outlet-hint' }, dirty ? `待保存预览：${numberFormat.format(effectiveCount(models, draft))} 个基础模型。下方选择尚未生效。` : '下方选择与最近读取的服务状态一致。')),
    error ? h('p', { role: 'alert', className: 'dsh-outlet-error' }, error.message) : null,
    h('section', { className: 'dsh-outlet-section', 'aria-labelledby': `${idPrefix}-providers-title` },
      h('div', { className: 'dsh-outlet-heading' },
        h('h3', { id: `${idPrefix}-providers-title` }, '订阅源'),
        h('div', { className: 'dsh-outlet-actions' },
          h(Button, { type: 'button', size: 'sm', disabled, onClick: () => onEdit('allowedProviders', null) }, '全部开放'),
          h(Button, { type: 'button', size: 'sm', disabled, onClick: () => onEdit('allowedProviders', []) }, '全部关闭'))),
      h('p', { className: 'dsh-outlet-hint' }, `待保存选择：${selectionLabel(draft.allowedProviders)}。全部开放也包含以后新增的来源。`),
      providers.length === 0 ? h('p', { className: 'dsh-outlet-hint' }, '未发现来源。请先在宿主启用订阅插件，再刷新。') :
        h('div', { className: 'dsh-outlet-providers' }, providers.map(provider => h('div', { key: provider, className: 'dsh-outlet-provider' },
          h(Checkbox, { checked: providerSet === null || providerSet.has(provider), disabled, label: provider, onChange: checked => onEdit('allowedProviders', toggleSelection(draft.allowedProviders, provider, checked, providers)) }),
          h('span', { className: 'dsh-outlet-hint' }, `${numberFormat.format(groups.get(provider)?.length ?? 0)} 个基础模型`))))),
    h('section', { className: 'dsh-outlet-section', 'aria-labelledby': `${idPrefix}-models-title` },
      h('div', { className: 'dsh-outlet-heading' },
        h('h3', { id: `${idPrefix}-models-title` }, '开放模型'),
        h('div', { className: 'dsh-outlet-actions' },
          h(Button, { type: 'button', size: 'sm', disabled, onClick: () => onEdit('allowedModels', null) }, '全选'),
          h(Button, { type: 'button', size: 'sm', disabled, onClick: () => onEdit('allowedModels', []) }, '全不选'))),
      h('p', { className: 'dsh-outlet-hint', id: `${idPrefix}-model-help` }, `待保存选择：${selectionLabel(draft.allowedModels)}。模型与已开启来源取交集才会开放；关闭来源不会清除模型选择。全选包含以后新增的模型。`),
      h('label', { htmlFor: `${idPrefix}-search`, className: 'dsh-outlet-label' }, '搜索模型或来源'),
      h(Input, { id: `${idPrefix}-search`, type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: '模型名称、模型 ID 或来源', 'aria-describedby': `${idPrefix}-model-help`, className: 'dsh-outlet-search' }),
      models.length === 0 ? h('p', { className: 'dsh-outlet-hint' }, '当前目录没有可选模型，请确认订阅源已就绪后刷新。') :
        visibleGroups.length === 0 ? h('p', { className: 'dsh-outlet-hint', role: 'status' }, '没有匹配的模型。请换个关键词。') :
          h('div', { className: 'dsh-outlet-models', 'aria-busy': query.trim().toLocaleLowerCase() !== deferredQuery }, visibleGroups.map(([provider, entries]) => {
            const providerOpen = providerSet === null || providerSet.has(provider);
            return h('fieldset', { key: provider, className: 'dsh-outlet-model-group' },
              h('legend', null, provider, !providerOpen ? h('span', { className: 'dsh-outlet-group-status' }, '来源未选，保存后不开放') : null),
              entries.map(model => h('div', { key: model.id, className: 'dsh-outlet-model', 'data-source-closed': !providerOpen },
                h(Checkbox, { checked: modelSet === null || modelSet.has(model.id), disabled, label: `${model.name}（${model.id}）`, onChange: checked => onEdit('allowedModels', toggleSelection(draft.allowedModels, model.id, checked, allModelIds)) }),
                modelCapabilities(model) ? h('p', { className: 'dsh-outlet-model-meta' }, modelCapabilities(model)) : null)));
          }))),
    h('div', { className: 'dsh-outlet-save' },
      h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-outlet-hint' }, busy === 'saving' ? '正在保存开放范围…' : busy === 'loading' ? '正在刷新服务状态…' : dirty ? '有未保存的选择。保存后才会影响新请求。' : notice || '没有未保存的更改。'),
      h('div', { className: 'dsh-outlet-actions' },
        h(Button, { type: 'button', size: 'sm', disabled, onClick: onReload }, '刷新状态'),
        h(Button, { type: 'button', size: 'sm', disabled: disabled || !dirty, onClick: onDiscard }, '撤销更改'),
        h(Button, { type: 'button', variant: 'primary', disabled: disabled || !dirty, onClick: onSave }, busy === 'saving' ? '保存中…' : '保存开放范围'))),
    h(UsageSection, { usage: snapshot.usage, disabled, onReload, idPrefix }));
}

function OutletPanel({ loadSnapshot, saveSettings, view }) {
  const store = React.useMemo(() => createPanelStore({ loadSnapshot, saveSettings }), [loadSnapshot, saveSettings]);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  React.useEffect(() => {
    if (view === 'summary') return undefined;
    void store.load();
    return () => store.cancel();
  }, [store, view]);
  if (view === 'summary') return '选择开放的订阅源和模型，并查看下游 token 用量。';
  return h(OutletView, { state, onEdit: store.edit, onSave: store.save, onDiscard: store.discard, onReload: store.load });
}

function installStyles() {
  const style = document.createElement('style');
  style.dataset.dshApiOutlet = '';
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
  return () => style.remove();
}

const inject = ['slots'];
function apply(ctx) {
  const api = createApi();
  ctx.effect(installStyles, 'dsh-api-outlet: scoped styles');
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE_NAME, inject: () => api,
  }, OutletPanel));
}

module.exports = { PACKAGE_NAME, API_PREFIX, inject, apply, OutletPanel, OutletView, UsageSection, createApi, createPanelStore, copySettings, sameSettings, toggleSelection, canonicalModels, effectiveCount, validateSnapshot };
