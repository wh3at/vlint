import type { Failure } from "./failure";

export interface Geometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ViolationBase {
  readonly type: "tab-label-single-line" | "page-horizontal-overflow";
  readonly geometry: Geometry;
  readonly locator: string;
}

export interface TabLabelSingleLineViolation extends ViolationBase {
  readonly type: "tab-label-single-line";
  readonly text: string;
  readonly lineCount: number;
}

export interface OverflowComputedStyle {
  readonly display: string;
  readonly position: string;
  readonly boxSizing: string;
  readonly width: string;
  readonly minWidth: string;
  readonly maxWidth: string;
  readonly whiteSpace: string;
  readonly overflowX: string;
  readonly flex: string;
  readonly flexBasis: string;
  readonly flexGrow: string;
  readonly flexShrink: string;
  readonly gridTemplateColumns: string;
  readonly gridAutoColumns: string;
}

export interface PageHorizontalOverflowViolation extends ViolationBase {
  readonly type: "page-horizontal-overflow";
  readonly overflowPx: number;
  readonly computedStyle: OverflowComputedStyle;
}

export type Violation = TabLabelSingleLineViolation | PageHorizontalOverflowViolation;

export function isTabLabelSingleLineViolation(
  violation: Violation,
): violation is TabLabelSingleLineViolation {
  return violation.type === "tab-label-single-line";
}

export interface RuleEvaluationFact<TViolation extends Violation = Violation> {
  readonly elementsInspected: number;
  readonly violations: readonly TViolation[];
}

export interface RuleEvaluationOutcome<TViolation extends Violation = Violation> {
  readonly facts: RuleEvaluationFact<TViolation>;
  readonly failure: Failure | null;
}


export type RuleFinalizationStatus = "passed" | "failed" | "not-executed";

export interface RuleFinalization {
  readonly name: string;
  readonly status: RuleFinalizationStatus;
  readonly elementsInspected: number;
  readonly failure: Failure | null;
}
