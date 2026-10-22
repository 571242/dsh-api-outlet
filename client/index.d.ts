import type { Context } from '@deepseek-ai/cordis';
import type { ReactElement } from 'react';
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client';

export interface OutletSettings {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
}
export interface OutletModel {
  id: string;
  provider: string;
  model: string;
  name: string;
  base_model?: string;
  input_modalities: string[];
  reasoning_efforts: string[];
}
export interface UsageMetrics {
  requests: number;
  failedRequests: number;
  unknownUsageRequests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface OutletSnapshot {
  settings: OutletSettings;
  catalog: OutletModel[];
  usage: {
    since: string | number;
    totals: UsageMetrics;
    clients: Array<UsageMetrics & { id: string; label: string; revoked: boolean }>;
  };
}
export interface OutletApi {
  loadSnapshot(): Promise<OutletSnapshot>;
  saveSettings(settings: OutletSettings): Promise<OutletSnapshot>;
}
export interface PanelState {
  snapshot: OutletSnapshot | null;
  draft: OutletSettings | null;
  busy: 'loading' | 'saving' | null;
  error: { kind: 'load' | 'save'; message: string } | null;
  notice: string;
}
export interface PanelStore {
  getSnapshot(): PanelState;
  subscribe(listener: () => void): () => void;
  cancel(): void;
  edit(field: keyof OutletSettings, selection: string[] | null): void;
  discard(): void;
  load(): Promise<void>;
  save(): Promise<void>;
}
export declare const PACKAGE_NAME: '@oracle-ai/dsh-api-outlet';
export declare const API_PREFIX: '/api/dsh-api-outlet';
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export declare function OutletPanel(props: OutletApi & Partial<PluginConfigViewProps>): ReactElement | string;
export declare function OutletView(props: {
  state: PanelState;
  onEdit: PanelStore['edit'];
  onSave: PanelStore['save'];
  onDiscard: PanelStore['discard'];
  onReload: PanelStore['load'];
}): ReactElement;
export declare function UsageSection(props: {
  usage: OutletSnapshot['usage'];
  disabled: boolean;
  onReload: PanelStore['load'];
  idPrefix: string;
}): ReactElement;
export declare function createApi(fetcher?: typeof fetch): OutletApi;
export declare function createPanelStore(api: OutletApi): PanelStore;
export declare function copySettings(settings: OutletSettings): OutletSettings;
export declare function sameSettings(left: OutletSettings, right: OutletSettings): boolean;
export declare function toggleSelection(selection: string[] | null, id: string, checked: boolean, available: string[]): string[];
export declare function canonicalModels(catalog: OutletModel[]): OutletModel[];
export declare function effectiveCount(models: OutletModel[], settings: OutletSettings): number;
export declare function validateSnapshot(value: unknown): OutletSnapshot;
