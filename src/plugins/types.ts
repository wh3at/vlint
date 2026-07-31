import type { JsonSettings } from "../contracts/plugins";
import type { PluginContractDescriptor, PluginSchemaDescriptor } from "../contracts/plugins";
import type { FailureCode } from "../contracts/failure";

export const PLUGIN_LOADER_WORKER_TOKEN = "__vlint_internal_plugin_loader_worker__";

export const MAX_PLUGIN_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_CALLBACK_SOURCE_BYTES = 256 * 1024;
export const MAX_DESCRIPTOR_JSON_BYTES = 1024 * 1024;
export const PLUGIN_LOADER_STDOUT_LIMIT = 1024 * 1024;
export const PLUGIN_LOADER_STDERR_LIMIT = 64 * 1024;
export const PLUGIN_LOADER_TIMEOUT_MS = 30_000;
export const PLUGIN_LOADER_CLEANUP_GRACE_MS = 500;

export type PluginFinalizeFn = (observations: unknown) => Promise<unknown>;

export interface LoadedPluginContract {
  readonly descriptor: PluginContractDescriptor;
  /** Transpiled evaluator callback source reused for every browser case. */
  readonly evaluateJs: string;
  readonly finalize: PluginFinalizeFn | null;
}

export interface PluginRuntimeRegistry {
  readonly contracts: ReadonlyMap<string, LoadedPluginContract>;
  get(ruleName: string): LoadedPluginContract | undefined;
}

export interface PluginWorkerSuccess {
  readonly ok: true;
  readonly descriptor: PluginContractDescriptor;
}

export interface PluginWorkerFailure {
  readonly ok: false;
  readonly code: FailureCode;
  readonly message: string;
}

export type PluginWorkerResponse = PluginWorkerSuccess | PluginWorkerFailure;

export interface PluginLoadOptions {
  readonly configDirectory: string;
  readonly relativePath: string;
  readonly ruleName: string;
  readonly executablePath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SettingsValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidatedSettings {
  readonly settings: JsonSettings;
  readonly schema: PluginSchemaDescriptor;
}
