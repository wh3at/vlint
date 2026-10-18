import type { AuditEnvironment } from "../contracts/config";
import { isAbsolute, resolve } from "node:path";
import type {
  DeviceProfile,
  EffectiveAuditCase,
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  LoadedConfig,
  ReadyState,
  ResolvedCheckPlan,
  RuleInstance,
  Target,
  TargetDefaults,
} from "../contracts/config";
import type { JsonSettings, JsonValue } from "../contracts/plugins";

const BUILTIN_DEFAULTS = {
  locale: "en-US",
  timezoneId: "UTC",
  timeoutMs: 30_000,
} as const;

const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const BUILTIN_TAB_RULE: RuleInstance = {
  name: "tab-label-single-line",
  type: "tab-label-single-line",
};

export const BUILTIN_OVERFLOW_RULE: RuleInstance = {
  name: "page-horizontal-overflow",
  type: "page-horizontal-overflow",
};

export const BUILTIN_TABLE_RULE: RuleInstance = {
  name: "table-header-single-line",
  type: "table-header-single-line",
};

export const BUILTIN_CELL_RULE: RuleInstance = {
  name: "table-cell-text-overlap",
  type: "table-cell-text-overlap",
};

export const BUILTIN_SVG_RULE: RuleInstance = {
  name: "svg-text-clipping",
  type: "svg-text-clipping",
};

export function rulesWithBuiltins(rules: readonly RuleInstance[] | undefined): readonly RuleInstance[] {
  const configured = rules ?? [];
  return [
    ...(configured.some((rule) => rule.type === "tab-label-single-line") ? [] : [BUILTIN_TAB_RULE]),
    ...configured,
    ...(configured.some((rule) => rule.type === "page-horizontal-overflow") ? [] : [BUILTIN_OVERFLOW_RULE]),
    ...(configured.some((rule) => rule.type === "table-header-single-line") ? [] : [BUILTIN_TABLE_RULE]),
    ...(configured.some((rule) => rule.type === "table-cell-text-overlap" || rule.name === BUILTIN_CELL_RULE.name) ? [] : [BUILTIN_CELL_RULE]),
    ...(configured.some((rule) => rule.type === "svg-text-clipping" || rule.name === BUILTIN_SVG_RULE.name) ? [] : [BUILTIN_SVG_RULE]),
  ];
}

function emptySettings(): JsonSettings {
  return Object.create(null) as JsonSettings;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  const cloned: Record<string, JsonValue> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) continue;
    cloned[key] = cloneJsonValue(item);
  }
  return cloned;
}

/** Prototype-safe recursive settings merge (KTD6). */
export function mergeJsonSettings(base: JsonSettings, overlay: JsonSettings): JsonSettings {
  const merged: Record<string, JsonValue> = Object.create(null);
  for (const [key, value] of Object.entries(base)) {
    if (DANGEROUS_JSON_KEYS.has(key)) continue;
    merged[key] = cloneJsonValue(value);
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (DANGEROUS_JSON_KEYS.has(key)) continue;
    const existing = merged[key];
    if (
      existing !== undefined &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeJsonSettings(existing as JsonSettings, value as JsonSettings);
      continue;
    }
    merged[key] = cloneJsonValue(value);
  }
  return merged;
}

export function normalizeRules(rules: readonly RuleInstance[] | undefined): readonly EffectiveRule[] {
  const complete = rulesWithBuiltins(rules);
  return complete.map((rule): EffectiveRule => {
    const minimumInspected = rule.minimumInspected ?? null;
    switch (rule.type) {
      case "tab-label-single-line":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          minimumInspected,
          additionalCandidateSelectors: rule.additionalCandidateSelectors ?? [],
          excludeSelectors: rule.excludeSelectors ?? [],
          labelSelector: rule.labelSelector ?? null,
        };
      case "page-horizontal-overflow":
        return {
          name: rule.name,
          type: rule.type,
          enabled: rule.enabled ?? true,
          minimumInspected,
          tolerancePx: rule.tolerancePx ?? 1,
        };
      case "table-header-single-line":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          minimumInspected,
          additionalCandidateSelectors: rule.additionalCandidateSelectors ?? [],
          excludeSelectors: rule.excludeSelectors ?? [],
          lineTopTolerancePx: rule.lineTopTolerancePx ?? 1,
        };
      case "table-cell-text-overlap":
        return { name: rule.name, type: rule.type, enabled: rule.enabled ?? true, minimumInspected, excludeSelectors: rule.excludeSelectors ?? [] };
      case "svg-text-clipping":
        return { name: rule.name, type: rule.type, enabled: rule.enabled ?? true, minimumInspected, tolerancePx: rule.tolerancePx ?? 1, excludeSelectors: rule.excludeSelectors ?? [] };
      case "local":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          minimumInspected,
          path: rule.path,
          settings: rule.settings ?? emptySettings(),
        };
    }
  });
}

function effectiveRulesForTarget(
  rules: readonly EffectiveRule[],
  target: Target,
  device: DeviceProfile,
 ): readonly EffectiveRuleForTarget[] {
  return rules.map((rule) => {
    const override = target.ruleOverrides?.[rule.name];
    const combined = target.deviceRuleMinimums?.[device.name]?.[rule.name];
    const targetMinimum = override?.minimumInspected;
    const deviceMinimum = device.ruleMinimums?.[rule.name];
    const minimumInspected = combined ?? targetMinimum ?? deviceMinimum ?? rule.minimumInspected;
    const common = { ...rule, enabled: override?.enabled ?? rule.enabled, minimumInspected };
    switch (rule.type) {
      case "tab-label-single-line":
      case "table-header-single-line":
      case "table-cell-text-overlap":
      case "svg-text-clipping":
        return { ...common, excludeSelectors: [...rule.excludeSelectors, ...(override?.excludeSelectors ?? [])] };
      case "page-horizontal-overflow":
        return common;
      case "local":
        return { ...common, settings: override?.settings === undefined ? rule.settings : mergeJsonSettings(rule.settings, override.settings) };
    }
  });
}

interface Presentation {
  readonly locale: string;
  readonly timezoneId: string;
  readonly timeoutMs: number;
  readonly browserState: string | null;
  readonly readyCondition: { readonly selector: string; readonly state: ReadyState } | null;
}

function resolvePresentation(target: Target, defaults: TargetDefaults, directory: string): Presentation {
  const browserState = target.browserState ?? defaults.browserState;
  const readyCondition = target.readyCondition ?? defaults.readyCondition;
  return {
    locale: target.locale ?? defaults.locale ?? BUILTIN_DEFAULTS.locale,
    timezoneId: target.timezoneId ?? defaults.timezoneId ?? BUILTIN_DEFAULTS.timezoneId,
    timeoutMs: target.timeoutMs ?? defaults.timeoutMs ?? BUILTIN_DEFAULTS.timeoutMs,
    browserState:
      browserState === undefined ? null : isAbsolute(browserState) ? browserState : resolve(directory, browserState),
    readyCondition:
      readyCondition === undefined
        ? null
        : { selector: readyCondition.selector, state: readyCondition.state ?? "visible" },
  };
}

function makeEffectiveTarget(
  target: Target,
  device: DeviceProfile,
  defaults: TargetDefaults,
  rules: readonly EffectiveRule[],
  directory: string,
): EffectiveTarget {
  return {
    name: target.name,
    url: target.url,
    allowedUrls: target.allowedUrls,
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    ...resolvePresentation(target, defaults, directory),
    rules: effectiveRulesForTarget(rules, target, device),
  };
}

function makeAuditCase(
  target: Target,
  device: DeviceProfile,
  environment: AuditEnvironment,
  defaults: TargetDefaults,
  rules: readonly EffectiveRule[],
  directory: string,
): EffectiveAuditCase {
  return {
    name: target.name,
    url: target.url,
    allowedUrls: target.allowedUrls,
    deviceName: device.name,
    environment,
    viewport: device.viewport,
    screen: device.screen,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: null,
    ...resolvePresentation(target, defaults, directory),
    rules: effectiveRulesForTarget(rules, target, device),
  };
}

export interface MinimumViolation {
  readonly reason: "unknown-device" | "conflicting-minimums";
  readonly message: string;
  readonly target: string;
  readonly device: string;
  readonly rule: string | null;
}

export type PlanResolution =
  | { readonly ok: true; readonly value: ResolvedCheckPlan }
  | { readonly ok: false; readonly violation: MinimumViolation };

function minimumViolation(config: LoadedConfig, targets: readonly Target[]): MinimumViolation | null {
  const names = new Set(config.devices.map((device) => device.name));
  for (const target of targets) {
    for (const device of Object.keys(target.deviceRuleMinimums ?? {})) {
      if (!names.has(device)) return { reason: "unknown-device", message: `unknown device minimum: ${device}`, target: target.name, device, rule: null };
    }
  }
  const referencedDevices = new Set(config.environments.flatMap((environment) => environment.devices));
  for (const target of targets) {
    for (const device of config.devices) {
      if (!referencedDevices.has(device.name)) continue;
      for (const rule of config.rules) {
        const targetMinimum = target.ruleOverrides?.[rule.name]?.minimumInspected;
        const deviceMinimum = device.ruleMinimums?.[rule.name];
        if (targetMinimum !== undefined && deviceMinimum !== undefined && targetMinimum !== deviceMinimum && target.deviceRuleMinimums?.[device.name]?.[rule.name] === undefined) {
          return {
            reason: "conflicting-minimums",
            message: "target and device minimums conflict; specify deviceRuleMinimums",
            target: target.name, device: device.name, rule: rule.name,
          };
        }
      }
    }
  }
  return null;
}

export function resolveTargets(config: LoadedConfig, targets: readonly Target[]): PlanResolution {
  const violation = minimumViolation(config, targets);
  if (violation !== null) return { ok: false, violation };
  const primaryDevice = config.devices[0];
  const logicalTargets =
    primaryDevice === undefined
      ? []
      : targets.map((target) =>
          makeEffectiveTarget(target, primaryDevice, config.defaults, config.rules, config.directory),
        );
  const cases = targets.flatMap((target) =>
    config.environments.flatMap((environment) => environment.devices.map((name) => {
      const device = config.devices.find((item) => item.name === name)!;
      return makeAuditCase(target, device, environment, config.defaults, config.rules, config.directory);
    })),
  );
  return { ok: true, value: { environments: config.environments, targets: logicalTargets, cases, rules: config.rules } };
}

export function resolveAdHocTarget(config: LoadedConfig, url: string): PlanResolution {
  if (config.provider?.type === "static") {
    const violation = minimumViolation(config, config.provider.targets);
    if (violation !== null) return { ok: false, violation };
  }
  return resolveTargets(config, [{ name: "adhoc", url }]);
}
