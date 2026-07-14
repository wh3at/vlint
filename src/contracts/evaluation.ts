import type { Failure } from "./failure";

export interface Geometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Violation {
  readonly text: string;
  readonly lineCount: number;
  readonly geometry: Geometry;
  readonly locator: string;
}

export type RuleEvaluationStatus =
  | "clean"
  | "violations"
  | "failed"
  | "disabled"
  | "not-executed";

export interface RuleEvaluationFact {
  readonly labelsInspected: number;
  readonly violations: readonly Violation[];
}

export interface RuleEvaluationOutcome {
  readonly facts: RuleEvaluationFact;
  readonly failure: Failure | null;
}

export interface RuleEvaluation {
  readonly name: string;
  readonly type: "tab-label-single-line";
  readonly status: RuleEvaluationStatus;
  readonly labelsInspected: number;
  readonly violations: readonly Violation[];
  readonly failure: Failure | null;
}

export type RuleFinalizationStatus = "passed" | "failed" | "not-executed";

export interface RuleFinalization {
  readonly name: string;
  readonly status: RuleFinalizationStatus;
  readonly labelsInspected: number;
  readonly failure: Failure | null;
}
