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

const BUILTIN_DEFAULTS = {
  locale: "en-US",
  timezoneId: "UTC",
  timeoutMs: 30_000,
} as const;

const BUILTIN_RULE: RuleInstance = {
  name: "tab-label-single-line",
  type: "tab-label-single-line",
};

export function normalizeRules(rules: readonly RuleInstance[] | undefined): readonly EffectiveRule[] {
  return (rules ?? [BUILTIN_RULE]).map((rule) => ({
    name: rule.name,
    type: rule.type,
    additionalCandidateSelectors: rule.additionalCandidateSelectors ?? [],
    excludeSelectors: rule.excludeSelectors ?? [],
    labelSelector: rule.labelSelector ?? null,
    minimumLabels: rule.minimumLabels ?? 0,
    allowZeroLabels: rule.allowZeroLabels ?? false,
  }));
}

function effectiveRulesForTarget(
  rules: readonly EffectiveRule[],
  target: Target,
): readonly EffectiveRuleForTarget[] {
  return rules.map((rule) => {
    const override = target.ruleOverrides?.[rule.name];
    return {
      ...rule,
      enabled: override?.enabled ?? true,
      excludeSelectors: [...rule.excludeSelectors, ...(override?.excludeSelectors ?? [])],
      minimumLabels: override?.minimumLabels ?? rule.minimumLabels,
    };
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
