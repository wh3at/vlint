export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export type ReadyState = "attached" | "visible" | "hidden";

export interface ReadyCondition {
  readonly selector: string;
  readonly state?: ReadyState;
}

/**
 * Presentation defaults shared by every target. Device emulation
 * (viewport, screen, DPR, mobile, touch, user agent) is owned exclusively by
 * {@link DeviceProfile}; targets and defaults no longer carry a viewport or
 * device scale factor, so there is no competing viewport source per target.
 */
export interface TargetDefaults {
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

/**
 * Ordered device profile. The sole authority for viewport, screen, device scale
 * factor, mobile mode, touch, and user agent. `userAgent` is optional: when
 * omitted, Playwright's Chromium default user agent is preserved.
 */
export interface DeviceProfile {
  readonly name: string;
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly userAgent?: string;
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

export interface ConfigV2 {
  readonly schemaVersion: 2;
  readonly devices: readonly DeviceProfile[];
  readonly provider?: ProviderConfig;
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

/**
 * Resolved presentation for a single logical target. The viewport and device
 * scale factor are borrowed from the first configured device so the
 * single-device execution path keeps a concrete emulation while the
 * case-based scheduler (U5) is introduced; the device profile remains the only
 * emulation authority in the configuration.
 */
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

/**
 * One target-major / device-minor audit case: a logical target's presentation
 * paired with a concrete device's emulation. The ordered {@link ResolvedCheckPlan.cases}
 * list is the immutable plan handed to the scheduler and reporter.
 */
export interface EffectiveAuditCase {
  readonly name: string;
  readonly url: string;
  readonly deviceName: string;
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly userAgent: string | null;
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
  readonly devices: readonly DeviceProfile[];
  readonly provider?: ProviderConfig;
  readonly defaults: TargetDefaults;
  readonly rules: readonly EffectiveRule[];
}

/**
 * Resolved check plan. {@link targets} holds the logical targets (identity and
 * count), {@link cases} holds the ordered target-major / device-minor audit
 * cases, and {@link rules} holds the normalized rule set.
 */
export interface ResolvedCheckPlan {
  readonly targets: readonly EffectiveTarget[];
  readonly cases: readonly EffectiveAuditCase[];
  readonly rules: readonly EffectiveRule[];
}
