import type { Failure } from "../contracts/failure";
import type { RunResult } from "../contracts/result";

const ABSOLUTE_PATH = /(?:^|\s)(\/(?:[\w.-]+\/)+[\w.-]+)/g;

export function sanitizeFailureMessage(message: string): string {
  const withoutPaths = message.replace(ABSOLUTE_PATH, " <path>");
  if (withoutPaths.length <= 1024) return withoutPaths;
  return `${withoutPaths.slice(0, 1024)}…`;
}

function sanitizeFailure(failure: Failure): Failure {
  return { ...failure, message: sanitizeFailureMessage(failure.message) };
}

/** Returns a published copy with sanitized failure messages for terminal and JSON output. */
export function publishResult(result: RunResult): RunResult {
  return {
    ...result,
    cases: result.cases.map((auditCase) => ({
      ...auditCase,
      failures: auditCase.failures.map(sanitizeFailure),
      rules: auditCase.rules.map((rule) =>
        rule.failure === null ? rule : { ...rule, failure: sanitizeFailure(rule.failure) },
      ),
    })),
    ruleFinalizations: result.ruleFinalizations.map((finalization) =>
      finalization.failure === null
        ? finalization
        : { ...finalization, failure: sanitizeFailure(finalization.failure) },
    ),
    failures: result.failures.map(sanitizeFailure),
  };
}
