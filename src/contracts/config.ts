export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export type ReadyState = "attached" | "visible" | "hidden";

export interface ReadyCondition {
  readonly selector: string;
  readonly state?: ReadyState;
}

export interface TargetDefaults {
  readonly viewport?: Viewport;
  readonly deviceScaleFactor?: number;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly timeoutMs?: number;
  readonly browserState?: string;
  readonly readyCondition?: ReadyCondition;
}

export interface RuleOverride {
  readonly enabled?: boolean;
  readonly excludeSelectors?: readonly string[];
  readonly minimumLabels?: number;
}

export interface Target extends TargetDefaults {
  readonly name: string;
  readonly url: string;
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>;
}

export interface StaticProviderConfig {
  readonly type: "static";
  readonly targets: readonly Target[];
}

export interface CommandProviderConfig {
  readonly type: "command";
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export type ProviderConfig = StaticProviderConfig | CommandProviderConfig;

export interface RuleInstance {
  readonly name: string;
  readonly type: "tab-label-single-line";
  readonly additionalCandidateSelectors?: readonly string[];
  readonly excludeSelectors?: readonly string[];
  readonly labelSelector?: string;
  readonly minimumLabels?: number;
  readonly allowZeroLabels?: boolean;
}

export interface ConfigV1 {
  readonly schemaVersion: 1;
  readonly provider: ProviderConfig;
  readonly defaults?: TargetDefaults;
  readonly rules?: readonly RuleInstance[];
}

export interface CommandProviderOutput {
  readonly targets: readonly Target[];
}

export interface EffectiveRule {
  readonly name: string;
  readonly type: "tab-label-single-line";
  readonly additionalCandidateSelectors: readonly string[];
  readonly excludeSelectors: readonly string[];
  readonly labelSelector: string | null;
  readonly minimumLabels: number;
  readonly allowZeroLabels: boolean;
}

export interface EffectiveRuleForTarget extends EffectiveRule {
  readonly enabled: boolean;
}

export interface EffectiveTarget {
  readonly name: string;
  readonly url: string;
  readonly viewport: Viewport;
  readonly deviceScaleFactor: number;
  readonly locale: string;
  readonly timezoneId: string;
  readonly timeoutMs: number;
  readonly browserState: string | null;
  readonly readyCondition: {
    readonly selector: string;
    readonly state: ReadyState;
  } | null;
  readonly rules: readonly EffectiveRuleForTarget[];
}

export interface LoadedConfig {
  readonly path: string;
  readonly directory: string;
  readonly provider: ProviderConfig;
  readonly defaults: TargetDefaults;
  readonly rules: readonly EffectiveRule[];
}

export interface ResolvedCheckPlan {
  readonly targets: readonly EffectiveTarget[];
  readonly rules: readonly EffectiveRule[];
}
