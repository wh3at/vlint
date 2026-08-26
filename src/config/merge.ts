import { isAbsolute, resolve } from "node:path";
import type {
  DeviceProfile,
  EffectiveAuditCase,
  EffectiveLocalRule,
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

export function rulesWithBuiltins(rules: readonly RuleInstance[] | undefined): readonly RuleInstance[] {
  const configured = rules ?? [];
  return [
    ...(configured.some((rule) => rule.type === "tab-label-single-line") ? [] : [BUILTIN_TAB_RULE]),
    ...configured,
    ...(configured.some((rule) => rule.type === "page-horizontal-overflow") ? [] : [BUILTIN_OVERFLOW_RULE]),
    ...(configured.some((rule) => rule.type === "table-header-single-line") ? [] : [BUILTIN_TABLE_RULE]),
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
    switch (rule.type) {
      case "tab-label-single-line":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          additionalCandidateSelectors: rule.additionalCandidateSelectors ?? [],
          excludeSelectors: rule.excludeSelectors ?? [],
          labelSelector: rule.labelSelector ?? null,
          minimumLabels: rule.minimumLabels ?? 0,
          allowZeroLabels: rule.allowZeroLabels ?? false,
        };
      case "page-horizontal-overflow":
        return {
          name: rule.name,
          type: rule.type,
          enabled: rule.enabled ?? true,
          tolerancePx: rule.tolerancePx ?? 1,
        };
      case "table-header-single-line":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          additionalCandidateSelectors: rule.additionalCandidateSelectors ?? [],
          excludeSelectors: rule.excludeSelectors ?? [],
          lineTopTolerancePx: rule.lineTopTolerancePx ?? 1,
          minimumHeaders: rule.minimumHeaders ?? 0,
          allowZeroHeaders: rule.allowZeroHeaders ?? true,
        };
      case "local":
        return {
          name: rule.name,
          type: rule.type,
          enabled: true,
          path: rule.path,
          settings: rule.settings ?? emptySettings(),
        };
    }
  });
}

function effectiveLocalRuleForTarget(
  rule: EffectiveLocalRule,
  target: Target,
): EffectiveLocalRule {
  const override = target.ruleOverrides?.[rule.name];
  if (override === undefined) return rule;
  return {
    ...rule,
    enabled: override.enabled ?? rule.enabled,
    settings:
      override.settings === undefined
        ? rule.settings
        : mergeJsonSettings(rule.settings, override.settings),
  };
}

function effectiveRulesForTarget(
  rules: readonly EffectiveRule[],
  target: Target,
): readonly EffectiveRuleForTarget[] {
  return rules.map((rule) => {
    const override = target.ruleOverrides?.[rule.name];
    switch (rule.type) {
      case "tab-label-single-line":
        return {
          ...rule,
          enabled: override?.enabled ?? rule.enabled,
          excludeSelectors: [...rule.excludeSelectors, ...(override?.excludeSelectors ?? [])],
          minimumLabels: override?.minimumLabels ?? rule.minimumLabels,
        };
      case "page-horizontal-overflow":
        return { ...rule, enabled: override?.enabled ?? rule.enabled };
      case "table-header-single-line":
        return {
          ...rule,
          enabled: override?.enabled ?? rule.enabled,
          excludeSelectors: [...rule.excludeSelectors, ...(override?.excludeSelectors ?? [])],
          minimumHeaders: override?.minimumHeaders ?? rule.minimumHeaders,
        };
      case "local":
        return effectiveLocalRuleForTarget(rule, target);
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

export function makeEffectiveTarget(
  target: Target,
  device: DeviceProfile,
  defaults: TargetDefaults,
  rules: readonly EffectiveRule[],
  directory: string,
): EffectiveTarget {
  return {
    name: target.name,
    url: target.url,
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    ...resolvePresentation(target, defaults, directory),
    rules: effectiveRulesForTarget(rules, target),
  };
}

function makeAuditCase(
  target: Target,
  device: DeviceProfile,
  defaults: TargetDefaults,
  rules: readonly EffectiveRule[],
  directory: string,
): EffectiveAuditCase {
  return {
    name: target.name,
    url: target.url,
    deviceName: device.name,
    viewport: device.viewport,
    screen: device.screen,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    userAgent: device.userAgent ?? null,
    ...resolvePresentation(target, defaults, directory),
    rules: effectiveRulesForTarget(rules, target),
  };
}

export function resolveTargets(config: LoadedConfig, targets: readonly Target[]): ResolvedCheckPlan {
  const primaryDevice = config.devices[0];
  const logicalTargets =
    primaryDevice === undefined
      ? []
      : targets.map((target) =>
          makeEffectiveTarget(target, primaryDevice, config.defaults, config.rules, config.directory),
        );
  const cases = targets.flatMap((target) =>
    config.devices.map((device) =>
      makeAuditCase(target, device, config.defaults, config.rules, config.directory),
    ),
  );
  return { targets: logicalTargets, cases, rules: config.rules };
}

export function resolveAdHocTarget(config: LoadedConfig, url: string): ResolvedCheckPlan {
  return resolveTargets(config, [{ name: "adhoc", url }]);
}
