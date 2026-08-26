import type { JsonSettings, JsonValue } from "./plugins";
import type { Failure } from "./failure";

export interface Geometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ViolationBase {
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

/** Generic local-rule violation envelope (KTD7). */
export interface LocalViolation extends ViolationBase {
  readonly type: "local";
  readonly message: string;
  readonly details: JsonValue;
}

/** Attribution precedence for a table-header candidate (KTD5). */
export type TableHeaderCandidateSource = "native" | "aria" | "additional";

export interface TableHeaderSingleLineViolation extends ViolationBase {
  readonly type: "table-header-single-line";
  readonly candidateSource: TableHeaderCandidateSource;
  readonly text: string;
  readonly lineCount: number;
  /** Rounded representative line-top per cluster, in measured order. */
  readonly lineTops: readonly number[];
  readonly lineTopTolerancePx: number;
}

export type Violation =
  | TabLabelSingleLineViolation
  | PageHorizontalOverflowViolation
  | TableHeaderSingleLineViolation
  | LocalViolation;

/**
 * Machine-readable candidate outcome that is not a violation (R14). The field
 * is omitted when empty so existing rule output stays stable (KTD4).
 */
export type TableHeaderCandidateDiagnostic =
  | {
      readonly kind: "excluded";
      readonly locator: string;
      /** First configured exclusion selector that matched the candidate. */
      readonly excludeSelector: string;
    }
  | { kind: "generated-content-unmeasured"; readonly locator: string };

export function isTabLabelSingleLineViolation(
  violation: Violation,
): violation is TabLabelSingleLineViolation {
  return violation.type === "tab-label-single-line";
}

export function isLocalViolation(violation: Violation): violation is LocalViolation {
  return violation.type === "local";
}

export function isTableHeaderSingleLineViolation(
  violation: Violation,
): violation is TableHeaderSingleLineViolation {
  return violation.type === "table-header-single-line";
}

export interface RuleEvaluationFact<TViolation extends Violation = Violation> {
  readonly elementsInspected: number;
  readonly violations: readonly TViolation[];
  readonly candidateDiagnostics?: readonly TableHeaderCandidateDiagnostic[];
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

/** Per-case summary supplied to a local rule finalizer (KTD3, U4). */
export type LocalRuleCaseObservationStatus =
  | "clean"
  | "violations"
  | "failed"
  | "disabled"
  | "not-executed";

export interface LocalRuleCaseObservation {
  readonly target: { readonly name: string; readonly url: string };
  readonly device: { readonly name: string };
  readonly caseStatus: "complete" | "partial" | "failed" | "not-executed";
  readonly status: LocalRuleCaseObservationStatus;
  readonly elementsInspected: number;
  readonly violations: readonly {
    readonly message: string;
    readonly locator: string;
    readonly geometry: Geometry;
    readonly details?: JsonValue;
  }[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface LocalRuleFinalizationInput {
  readonly rule: { readonly name: string };
  readonly settings: JsonSettings;
  readonly cases: readonly LocalRuleCaseObservation[];
}
