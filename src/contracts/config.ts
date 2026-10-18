import type { JsonSettings } from "./plugins";

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
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly timeoutMs?: number;
  readonly browserState?: string;
  readonly readyCondition?: ReadyCondition;
}

export interface RuleOverride {
  readonly enabled?: boolean;
  readonly excludeSelectors?: readonly string[];
  readonly minimumInspected?: number;
  readonly settings?: JsonSettings;
}

export interface Target extends TargetDefaults {
  readonly name: string;
  readonly url: string;
  readonly allowedUrls?: readonly string[];
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>;
  readonly deviceRuleMinimums?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface DeviceProfile {
  readonly name: string;
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly ruleMinimums?: Readonly<Record<string, number>>;
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

export type BuiltinRuleType =
  | "tab-label-single-line"
  | "page-horizontal-overflow"
  | "table-header-single-line"
  | "table-cell-text-overlap"
  | "svg-text-clipping";

export type RuleType = BuiltinRuleType | "local";

interface RuleInstanceBase {
  readonly name: string;
  readonly minimumInspected?: number;
}

export interface TabLabelSingleLineRuleInstance extends RuleInstanceBase {
  readonly type: "tab-label-single-line";
  readonly additionalCandidateSelectors?: readonly string[];
  readonly excludeSelectors?: readonly string[];
  readonly labelSelector?: string;
}

export interface PageHorizontalOverflowRuleInstance extends RuleInstanceBase {
  readonly type: "page-horizontal-overflow";
  readonly enabled?: boolean;
  readonly tolerancePx?: number;
}

/**
 * Semantic table column-header instance. Selector strings are validated as
 * CSS at evaluation time, not schema time.
 */
export interface TableHeaderSingleLineRuleInstance extends RuleInstanceBase {
  readonly type: "table-header-single-line";
  readonly additionalCandidateSelectors?: readonly string[];
  readonly excludeSelectors?: readonly string[];
  readonly lineTopTolerancePx?: number;
}

export interface TableCellTextOverlapRuleInstance extends RuleInstanceBase {
  readonly type: "table-cell-text-overlap";
  readonly enabled?: boolean;
  readonly excludeSelectors?: readonly string[];
}

export interface SvgTextClippingRuleInstance extends RuleInstanceBase {
  readonly type: "svg-text-clipping";
  readonly enabled?: boolean;
  readonly tolerancePx?: number;
  readonly excludeSelectors?: readonly string[];
}

export interface LocalRuleInstance extends RuleInstanceBase {
  readonly type: "local";
  /** Project-relative path to a self-contained TypeScript rule file (R1, R2). */
  readonly path: string;
  readonly settings?: JsonSettings;
}

export type RuleInstance =
  | TabLabelSingleLineRuleInstance
  | PageHorizontalOverflowRuleInstance
  | TableHeaderSingleLineRuleInstance
  | TableCellTextOverlapRuleInstance
  | SvgTextClippingRuleInstance
  | LocalRuleInstance;

export type EnvironmentPlatform = "windows" | "macos" | "iphone" | "android";
export type BrowserEngine = "chromium" | "firefox" | "webkit";

export const SUPPORTED_ENVIRONMENTS = {
  "windows:chromium": "Desktop Chrome",
  "windows:firefox": "Desktop Firefox",
  "macos:chromium": "Desktop Chrome",
  "macos:webkit": "Desktop Safari",
  "iphone:webkit": "iPhone 17",
  "android:chromium": "Pixel 10",
} as const;

export interface AuditEnvironment {
  readonly name: string;
  readonly platform: EnvironmentPlatform;
  readonly browser: BrowserEngine;
  readonly devices: readonly string[];
}

export interface Config {
  readonly devices: readonly DeviceProfile[];
  readonly environments: readonly AuditEnvironment[];
  readonly provider?: ProviderConfig;
  readonly defaults?: TargetDefaults;
  readonly rules?: readonly RuleInstance[];
}

export type ParsedConfig = Config;

export interface CommandProviderOutput {
  readonly targets: readonly Target[];
}

interface EffectiveRuleBase {
  readonly name: string;
  readonly enabled: boolean;
  readonly minimumInspected?: number | null | undefined;
}

export interface EffectiveTabLabelSingleLineRule extends EffectiveRuleBase {
  readonly type: "tab-label-single-line";
  readonly additionalCandidateSelectors: readonly string[];
  readonly excludeSelectors: readonly string[];
  readonly labelSelector: string | null;
}

export interface EffectiveTableHeaderSingleLineRule extends EffectiveRuleBase {
  readonly type: "table-header-single-line";
  readonly additionalCandidateSelectors: readonly string[];
  readonly excludeSelectors: readonly string[];
  readonly lineTopTolerancePx: number;
}

export interface EffectivePageHorizontalOverflowRule extends EffectiveRuleBase {
  readonly type: "page-horizontal-overflow";
  readonly tolerancePx: number;
}

export interface EffectiveTableCellTextOverlapRule extends EffectiveRuleBase {
  readonly type: "table-cell-text-overlap";
  readonly excludeSelectors: readonly string[];
}

export interface EffectiveSvgTextClippingRule extends EffectiveRuleBase {
  readonly type: "svg-text-clipping";
  readonly tolerancePx: number;
  readonly excludeSelectors: readonly string[];
}

export interface EffectiveLocalRule extends EffectiveRuleBase {
  readonly type: "local";
  readonly path: string;
  readonly settings: JsonSettings;
}

export type EffectiveRule =
  | EffectiveTabLabelSingleLineRule
  | EffectivePageHorizontalOverflowRule
  | EffectiveTableHeaderSingleLineRule
  | EffectiveTableCellTextOverlapRule
  | EffectiveSvgTextClippingRule
  | EffectiveLocalRule;

export type EffectiveRuleForTarget = EffectiveRule;

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
  readonly allowedUrls?: readonly string[] | undefined;
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

export interface EffectiveAuditCase {
  readonly name: string;
  readonly url: string;
  readonly allowedUrls?: readonly string[] | undefined;
  readonly deviceName: string;
  readonly environment: AuditEnvironment;
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
  readonly environments: readonly AuditEnvironment[];
  readonly provider?: ProviderConfig;
  readonly defaults: TargetDefaults;
  readonly rules: readonly EffectiveRule[];
}

export interface ResolvedCheckPlan {
  readonly environments: readonly AuditEnvironment[];
  readonly targets: readonly EffectiveTarget[];
  readonly cases: readonly EffectiveAuditCase[];
  readonly rules: readonly EffectiveRule[];
}
