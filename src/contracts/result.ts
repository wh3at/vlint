import type { RuleFinalization, Violation } from "./evaluation";
import type { Failure } from "./failure";

export type RunStatus = "clean" | "violations" | "incomplete";
export type TargetStatus = "complete" | "partial" | "failed" | "not-executed";
export type RuleResultStatus = "clean" | "violations" | "failed" | "disabled" | "not-executed";

export interface RuleResult {
  readonly name: string;
  readonly type: "tab-label-single-line";
  readonly status: RuleResultStatus;
  readonly labelsInspected: number;
  readonly violations: readonly Violation[];
}

export interface TargetResult {
  readonly name: string;
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly locale: string;
  readonly timezoneId: string;
  readonly status: TargetStatus;
  readonly rules: readonly RuleResult[];
}

export interface RunSummary {
  readonly targets: {
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
  readonly matchedElements: number;
  readonly executionFailures: number;
}

export interface RunResultV1 {
  readonly schemaVersion: 1;
  readonly status: RunStatus;
  readonly tool: { readonly name: "vlint"; readonly version: string };
  readonly environment: {
    readonly platform: "linux";
    readonly arch: "x64";
    readonly browser: { readonly name: "chromium"; readonly version: string | null };
  };
  readonly summary: RunSummary;
  readonly targets: readonly TargetResult[];
  readonly ruleFinalizations: readonly RuleFinalization[];
  readonly failure: Failure | null;
}
