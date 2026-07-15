export type FailureStage =
  | "config"
  | "provider"
  | "browser-setup"
  | "authentication"
  | "navigation"
  | "ready-condition"
  | "web-font"
  | "rule-evaluation"
  | "interrupt";

export type FailureCode =
  | "config-not-found"
  | "config-read-failed"
  | "config-too-large"
  | "config-invalid-json"
  | "config-schema-invalid"
  | "config-already-exists"
  | "config-write-failed"
  | "init-device-unavailable"
  | "targets-empty"
  | "provider-spawn-failed"
  | "provider-exit-nonzero"
  | "provider-timeout"
  | "provider-output-too-large"
  | "provider-output-invalid"
  | "provider-empty"
  | "provider-cleanup-failed"
  | "browser-cache-override-unsupported"
  | "browser-download-host-override-unsupported"
  | "browser-missing"
  | "browser-install-failed"
  | "browser-launch-failed"
  | "browser-incompatible"
  | "browser-context-failed"
  | "browser-page-failed"
  | "browser-cleanup-failed"
  | "state-missing"
  | "state-read-failed"
  | "state-not-regular"
  | "state-too-large"
  | "state-invalid"
  | "state-apply-failed"
  | "navigation-network"
  | "navigation-http-status"
  | "navigation-timeout"
  | "ready-invalid-selector"
  | "ready-timeout"
  | "font-load-failed"
  | "font-timeout"
  | "candidate-selector-invalid"
  | "exclude-selector-invalid"
  | "label-selector-invalid"
  | "label-selector-cardinality"
  | "label-selector-not-rendered"
  | "minimum-labels-unmet"
  | "zero-labels-global"
  | "generated-content-unsupported"
  | "diagnostic-field-too-large"
  | "geometry-evaluation-failed"
  | "rule-script-failed"
  | "signal-interrupt";

export interface Failure {
  readonly stage: FailureStage;
  readonly code: FailureCode;
  readonly message: string;
  readonly target: string | null;
  readonly device: string | null;
  readonly rule: string | null;
}

export type BoundaryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

export function boundarySuccess<T>(value: T): BoundaryResult<T> {
  return { ok: true, value };
}

export function boundaryFailure<T>(failure: Failure): BoundaryResult<T> {
  return { ok: false, failure };
}
