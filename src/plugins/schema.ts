import type { JsonSettings, JsonValue, PluginSchemaDescriptor } from "../contracts/plugins";
import { PLUGIN_CONTRACT_VERSION } from "../contracts/plugins";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { MAX_CALLBACK_SOURCE_BYTES } from "./types";

const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_PROPERTIES = 64;
const MAX_SCHEMA_ARRAY_ITEMS = 64;

function pluginFailure(code: Failure["code"], message: string, rule: string | null = null): Failure {
  return { stage: "config", code, message, target: null, device: null, rule };
}

function rejectDangerousKey(key: string, path: string): string | null {
  return DANGEROUS_JSON_KEYS.has(key) ? `${path}: forbidden prototype key` : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validatePluginSchemaDescriptor(
  value: unknown,
  path = "settingsSchema",
  depth = 0,
): string | null {
  if (depth > MAX_SCHEMA_DEPTH) return `${path}: schema is too deep`;
  if (!isPlainObject(value)) return `${path}: expected object`;
  const type = value.type;
  if (type === "object") {
    const properties = value.properties;
    if (properties !== undefined) {
      if (!isPlainObject(properties)) return `${path}.properties: expected object`;
      const keys = Object.keys(properties);
      if (keys.length > MAX_SCHEMA_PROPERTIES) return `${path}.properties: too many fields`;
      for (const key of keys) {
        const childPath = `${path}.properties.${key}`;
        const dangerous = rejectDangerousKey(key, childPath);
        if (dangerous !== null) return dangerous;
        const childIssue = validatePluginSchemaDescriptor(properties[key], childPath, depth + 1);
        if (childIssue !== null) return childIssue;
      }
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string")) {
        return `${path}.required: expected string array`;
      }
    }
    if (value.exactKeys !== undefined) {
      if (!Array.isArray(value.exactKeys) || value.exactKeys.some((item) => typeof item !== "string")) {
        return `${path}.exactKeys: expected string array`;
      }
    }
    return null;
  }
  if (type === "array") {
    if (value.items !== undefined) {
      const childIssue = validatePluginSchemaDescriptor(value.items, `${path}.items`, depth + 1);
      if (childIssue !== null) return childIssue;
    }
    if (value.minLength !== undefined && !Number.isInteger(value.minLength)) {
      return `${path}.minLength: expected integer`;
    }
    if (value.maxLength !== undefined && !Number.isInteger(value.maxLength)) {
      return `${path}.maxLength: expected integer`;
    }
    return null;
  }
  if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "null") {
    return null;
  }
  return `${path}.type: unsupported schema type`;
}

function validateJsonAgainstSchema(
  value: JsonValue,
  schema: PluginSchemaDescriptor,
  path: string,
): string | null {
  switch (schema.type) {
    case "null":
      return value === null ? null : `${path}: expected null`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path}: expected boolean`;
    case "string": {
      if (typeof value !== "string") return `${path}: expected string`;
      const length = byteLength(value);
      if (schema.minLength !== undefined && length < schema.minLength) {
        return `${path}: string is too short`;
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        return `${path}: string is too long`;
      }
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path}: expected finite number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${path}: expected integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path}: number is too small`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path}: number is too large`;
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected array`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path}: array is too short`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path}: array is too long`;
      }
      if (schema.items === undefined) return null;
      for (let index = 0; index < value.length; index += 1) {
        const itemIssue = validateJsonAgainstSchema(value[index] as JsonValue, schema.items, `${path}[${index}]`);
        if (itemIssue !== null) return itemIssue;
      }
      return null;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return `${path}: expected object`;
      }
      const object = value as Record<string, JsonValue>;
      const keys = Object.keys(object);
      for (const key of keys) {
        const childPath = `${path}.${key}`;
        const dangerous = rejectDangerousKey(key, childPath);
        if (dangerous !== null) return dangerous;
      }
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in object)) return `${path}.${key}: required field is missing`;
      }
      if (schema.exactKeys !== undefined) {
        const allowed = new Set(schema.exactKeys);
        for (const key of keys) {
          if (!allowed.has(key)) return `${path}.${key}: unknown field`;
        }
        for (const key of schema.exactKeys) {
          if (!(key in object)) return `${path}.${key}: required field is missing`;
        }
      }
      for (const [key, childValue] of Object.entries(object)) {
        const childSchema = properties[key];
        if (childSchema === undefined) {
          if (schema.exactKeys !== undefined) return `${path}.${key}: unknown field`;
          continue;
        }
        const childIssue = validateJsonAgainstSchema(childValue, childSchema, `${path}.${key}`);
        if (childIssue !== null) return childIssue;
      }
      return null;
    }
  }
}

export function validatePluginSettings(
  schema: PluginSchemaDescriptor,
  settings: JsonSettings,
  path: string,
  ruleName: string,
): BoundaryResult<JsonSettings> {
  const root: JsonValue = settings;
  const issue = validateJsonAgainstSchema(root, schema, path);
  if (issue !== null) {
    return boundaryFailure(pluginFailure("plugin-settings-invalid", issue, ruleName));
  }
  return boundarySuccess(settings);
}

export function parsePluginContractExport(
  exported: unknown,
  evaluateSource: string,
  finalizeSource: string | undefined,
): BoundaryResult<import("../contracts/plugins").PluginContractDescriptor> {
  if (!isPlainObject(exported)) {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", "plugin export must be an object"));
  }
  const contractVersion = exported.contractVersion;
  if (contractVersion !== PLUGIN_CONTRACT_VERSION) {
    return boundaryFailure(
      pluginFailure(
        "plugin-contract-version-mismatch",
        `plugin contract version ${String(contractVersion)} is not supported; expected ${PLUGIN_CONTRACT_VERSION}`,
      ),
    );
  }
  const metadata = exported.metadata;
  if (!isPlainObject(metadata) || typeof metadata.name !== "string" || metadata.name.length === 0) {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", "plugin metadata.name is required"));
  }
  if (metadata.description !== undefined && typeof metadata.description !== "string") {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", "plugin metadata.description must be a string"));
  }
  const settingsSchema = exported.settingsSchema;
  const schemaIssue = validatePluginSchemaDescriptor(settingsSchema, "settingsSchema");
  if (schemaIssue !== null) {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", schemaIssue));
  }
  if (typeof exported.evaluate !== "function") {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", "plugin evaluate must be a function"));
  }
  if (exported.finalize !== undefined && typeof exported.finalize !== "function") {
    return boundaryFailure(pluginFailure("plugin-contract-invalid", "plugin finalize must be a function when present"));
  }
  if (byteLength(evaluateSource) > MAX_CALLBACK_SOURCE_BYTES) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin evaluate source is too large"));
  }
  if (finalizeSource !== undefined && byteLength(finalizeSource) > MAX_CALLBACK_SOURCE_BYTES) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin finalize source is too large"));
  }
  if (new TextEncoder().encode(metadata.name).byteLength > 1024) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin metadata.name is too large"));
  }
  return boundarySuccess({
    contractVersion: PLUGIN_CONTRACT_VERSION,
    metadata: {
      name: metadata.name,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
    },
    settingsSchema: settingsSchema as PluginSchemaDescriptor,
    evaluateSource,
    ...(finalizeSource === undefined ? {} : { finalizeSource }),
  });
}
