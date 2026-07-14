import { isAbsolute, resolve } from "node:path";
import type {
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  LoadedConfig,
  ResolvedCheckPlan,
  RuleInstance,
  Target,
  TargetDefaults,
} from "../contracts/config";

const BUILTIN_DEFAULTS = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
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

export function makeEffectiveTarget(
  target: Target,
  defaults: TargetDefaults,
  rules: readonly EffectiveRule[],
  directory: string,
): EffectiveTarget {
  const viewport = target.viewport ?? defaults.viewport ?? BUILTIN_DEFAULTS.viewport;
  const readyCondition = target.readyCondition ?? defaults.readyCondition;
  const browserState = target.browserState ?? defaults.browserState;
  return {
    name: target.name,
    url: target.url,
    viewport,
    deviceScaleFactor:
      target.deviceScaleFactor ?? defaults.deviceScaleFactor ?? BUILTIN_DEFAULTS.deviceScaleFactor,
    locale: target.locale ?? defaults.locale ?? BUILTIN_DEFAULTS.locale,
    timezoneId: target.timezoneId ?? defaults.timezoneId ?? BUILTIN_DEFAULTS.timezoneId,
    timeoutMs: target.timeoutMs ?? defaults.timeoutMs ?? BUILTIN_DEFAULTS.timeoutMs,
    browserState:
      browserState === undefined ? null : isAbsolute(browserState) ? browserState : resolve(directory, browserState),
    readyCondition:
      readyCondition === undefined
        ? null
        : { selector: readyCondition.selector, state: readyCondition.state ?? "visible" },
    rules: effectiveRulesForTarget(rules, target),
  };
}

export function resolveTargets(config: LoadedConfig, targets: readonly Target[]): ResolvedCheckPlan {
  return {
    rules: config.rules,
    targets: targets.map((target) =>
      makeEffectiveTarget(target, config.defaults, config.rules, config.directory),
    ),
  };
}

export function resolveAdHocTarget(config: LoadedConfig, url: string): ResolvedCheckPlan {
  return resolveTargets(config, [{ name: "adhoc", url }]);
}
