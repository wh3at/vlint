import type { AuditEnvironment, BrowserEngine, DeviceProfile } from "./config";

export interface EngineExecution {
  readonly engine: BrowserEngine;
  readonly expectedVersion: string | null;
  obtainedVersion: string | null;
  versionSource: "browser.version" | "playwright-metadata" | null;
  readonly revision: string;
  readonly artifact: { readonly name: string; readonly directory: string; readonly downloadURLs: readonly string[] };
  readonly executablePath: string;
  diagnostic: string | null;
}

export interface RunExecution {
  readonly host: { readonly platform: string; readonly architecture: string; readonly release: string };
  readonly engines: readonly EngineExecution[];
  readonly environments: readonly (AuditEnvironment & { readonly userAgent: string | null })[];
  readonly devices: readonly DeviceProfile[];
}

import type { RuleFinalization, TableHeaderCandidateDiagnostic, Violation } from "./evaluation";
import type { Failure } from "./failure";
import type { RuleType } from "./config";

export type RunStatus = "clean" | "violations" | "incomplete";
export type CaseStatus = "complete" | "partial" | "failed" | "not-executed";
export type RuleResultStatus = "clean" | "violations" | "failed" | "disabled" | "not-executed";

export interface RuleResult {
  readonly name: string;
  readonly type: RuleType;
  readonly status: RuleResultStatus;
  readonly elementsInspected: number;
  readonly violations: readonly Violation[];
  readonly failure: Failure | null;
  /** Present only when the rule produced non-violation candidate outcomes (KTD4). */
  readonly candidateDiagnostics?: readonly TableHeaderCandidateDiagnostic[];
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

export interface CaseDevice {
  readonly name: string;
}

export interface CaseResult {
  readonly target: CaseTarget;
  readonly actualUrl?: string | null;
  readonly device: CaseDevice;
  readonly environment: string;
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

export interface RunResult {
  readonly status: RunStatus;
  readonly tool: { readonly name: "vlint"; readonly version: string };
  readonly execution: RunExecution;
  readonly summary: RunSummary;
  readonly cases: readonly CaseResult[];
  readonly ruleFinalizations: readonly RuleFinalization[];
  /** Ordered run-wide failures: config, provider, browser launch, browser-wide cleanup, interrupt. */
  readonly failures: readonly Failure[];
}
