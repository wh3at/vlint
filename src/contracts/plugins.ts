/** Plugin contract version supported by this vlint release (KTD3, R12). */
export const PLUGIN_CONTRACT_VERSION = 1 as const;

export type PluginContractVersion = typeof PLUGIN_CONTRACT_VERSION;

export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** Project configuration stores rule settings as JSON-compatible values. */
export type JsonSettings = JsonObject;

export type PluginSchemaPrimitiveType = "string" | "number" | "integer" | "boolean" | "null";

export type PluginSchemaDescriptor =
  | {
      readonly type: "object";
      readonly properties?: Readonly<Record<string, PluginSchemaDescriptor>>;
      readonly required?: readonly string[];
      readonly exactKeys?: readonly string[];
    }
  | {
      readonly type: "array";
      readonly items?: PluginSchemaDescriptor;
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | {
      readonly type: PluginSchemaPrimitiveType;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly minimum?: number;
      readonly maximum?: number;
    };

export interface PluginMetadata {
  readonly name: string;
  readonly description?: string;
}

/**
 * Serializable plugin contract returned by the trusted loader worker (KTD3).
 * Callback source is bounded text from the verified snapshot; vlint reconstructs
 * trusted callbacks in a check-owned registry (U2).
 */
export interface PluginContractDescriptor {
  readonly contractVersion: PluginContractVersion;
  readonly metadata: PluginMetadata;
  readonly settingsSchema: PluginSchemaDescriptor;
  readonly evaluateSource: string;
  readonly finalizeSource?: string;
}
