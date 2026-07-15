import type { RuleFinalization, Violation } from "./evaluation";
import type { Failure } from "./failure";

export type RunStatus = "clean" | "violations" | "incomplete";
export type CaseStatus = "complete" | "partial" | "failed" | "not-executed";
export type RuleResultStatus = "clean" | "violations" | "failed" | "disabled" | "not-executed";

export interface RuleResult {
  readonly name: string;
  readonly type: "tab-label-single-line" | "page-horizontal-overflow";
  readonly status: RuleResultStatus;
  readonly elementsInspected: number;
  readonly violations: readonly Violation[];
  readonly failure: Failure | null;
}

/**
 * Identity of the logical target for one audit case. Kept separate from
 * device so consumers can correlate results across devices without conflating
 * the two identities (R17).
 */
export interface CaseTarget {
  readonly name: string;
  readonly url: string;
}

/**
 * Concrete device emulation applied to one audit case. Carries the full
 * profile from the ordered device list so the result is self-describing
 * without referring back to configuration (R18).
 */
export interface CaseDevice {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly screen: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly userAgent: string | null;
}

export interface CaseResult {
  readonly target: CaseTarget;
  readonly device: CaseDevice;
  readonly locale: string;
  readonly timezoneId: string;
  readonly status: CaseStatus;
  readonly rules: readonly RuleResult[];
  readonly failures: readonly Failure[];
}

export interface RunSummary {
  /** Logical target count, independent of how many devices each was audited on (KTD6). */
  readonly targets: { readonly resolved: number };
  /** Case execution partition. `resolved` equals the total planned case count. */
  readonly cases: {
    readonly resolved: number;
    readonly complete: number;
    readonly partial: number;
    readonly failed: number;
    readonly notExecuted: number;
  };
  readonly ruleEvaluations: {
    readonly clean: number;
    readonly violations: number;
    readonly failed: number;
    readonly disabled: number;
    readonly notExecuted: number;
  };
  readonly ruleFinalizations: {
    readonly passed: number;
    readonly failed: number;
    readonly notExecuted: number;
  };
  readonly violations: number;
  readonly elementsInspected: number;
  /** Total failures across run-wide, case-level, rule-level, and finalization sources. */
  readonly executionFailures: number;
}

export interface RunResultV3 {
  readonly schemaVersion: 3;
  readonly status: RunStatus;
  readonly tool: { readonly name: "vlint"; readonly version: string };
  readonly environment: {
    readonly platform: "linux";
    readonly arch: "x64";
    readonly browser: { readonly name: "chromium"; readonly version: string | null };
  };
  readonly summary: RunSummary;
  readonly cases: readonly CaseResult[];
  readonly ruleFinalizations: readonly RuleFinalization[];
  /** Ordered run-wide failures: config, provider, browser launch, browser-wide cleanup, interrupt. */
  readonly failures: readonly Failure[];
}
