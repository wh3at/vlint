import type { EffectiveLocalRule, ResolvedCheckPlan } from "../contracts/config";
import type {
  LocalRuleCaseObservation,
  LocalRuleFinalizationInput,
  RuleFinalization,
  Violation,
} from "../contracts/evaluation";
import type { Failure, FailureCode } from "../contracts/failure";
import type { CaseResult, RuleResultStatus } from "../contracts/result";
import { transpilePluginCallbackSource } from "./load";
import type { LoadedPluginContract } from "./types";

export const MAX_FINALIZATION_OBSERVATIONS = 256;
export const MAX_FINALIZATION_OBSERVATION_BYTES = 512 * 1024;
export const MAX_FINALIZATION_MESSAGE_BYTES = 64 * 1024;
export const PLUGIN_FINALIZATION_TIMEOUT_MS = 30_000;

interface MutableCaseResult {
  readonly target: { name: string; url: string };
  readonly device: { name: string };
  readonly status: CaseResult["status"];
  readonly rules: readonly {
    readonly status: RuleResultStatus;
    readonly elementsInspected: number;
    readonly violations: readonly Violation[];
    readonly failure: Failure | null;
  }[];
}

function mapRuleStatus(status: RuleResultStatus): LocalRuleCaseObservation["status"] {
  if (status === "clean") return "clean";
  if (status === "violations") return "violations";
  if (status === "failed") return "failed";
  if (status === "disabled") return "disabled";
  return "not-executed";
}

function observationBytes(observations: LocalRuleFinalizationInput): number {
  return new TextEncoder().encode(JSON.stringify(observations)).byteLength;
}

function finalizationFailure(
  code: FailureCode,
  message: string,
  ruleName: string,
): Failure {
  return { stage: "rule-evaluation", code, message, target: null, device: null, rule: ruleName };
}

export function buildLocalRuleObservations(
  rule: EffectiveLocalRule,
  plan: ResolvedCheckPlan,
  cases: readonly MutableCaseResult[],
  ruleIndex: number,
): LocalRuleFinalizationInput {
  const caseObservations: LocalRuleCaseObservation[] = [];
  for (let caseIndex = 0; caseIndex < plan.cases.length; caseIndex += 1) {
    const auditCase = plan.cases[caseIndex];
    const caseResult = cases[caseIndex];
    const effectiveRule = auditCase?.rules[ruleIndex];
    const ruleResult = caseResult?.rules[ruleIndex];
    if (auditCase === undefined || caseResult === undefined || effectiveRule === undefined || ruleResult === undefined) {
      continue;
    }
    caseObservations.push({
      target: { name: caseResult.target.name, url: caseResult.target.url },
      device: { name: caseResult.device.name },
      caseStatus: caseResult.status,
      status: mapRuleStatus(ruleResult.status),
      elementsInspected: ruleResult.elementsInspected,
      violations: ruleResult.violations.map((violation) => {
        const message =
          violation.type === "local"
            ? violation.message
            : violation.type === "tab-label-single-line"
              ? violation.text
              : violation.type;
        return {
          message,
          locator: violation.locator,
          geometry: violation.geometry,
          ...(violation.type === "local" ? { details: violation.details } : {}),
        };
      }),
      failure:
        ruleResult.failure === null
          ? null
          : { code: ruleResult.failure.code, message: ruleResult.failure.message },
    });
  }
  return {
    rule: { name: rule.name },
    settings: { ...rule.settings },
    cases: caseObservations,
  };
}

function validateObservationBounds(
  observations: LocalRuleFinalizationInput,
  ruleName: string,
): Failure | null {
  if (observations.cases.length > MAX_FINALIZATION_OBSERVATIONS) {
    return finalizationFailure(
      "plugin-finalizer-invalid",
      "local rule finalization observations exceed the observation count limit",
      ruleName,
    );
  }
  if (observationBytes(observations) > MAX_FINALIZATION_OBSERVATION_BYTES) {
    return finalizationFailure(
      "plugin-finalizer-invalid",
      "local rule finalization observations exceed the serialized byte limit",
      ruleName,
    );
  }
  return null;
}

function parseFinalizerOutcome(
  resolved: unknown,
  ruleName: string,
): { readonly status: "passed" } | { readonly status: "failed"; readonly message: string } | Failure {
  if (resolved === null || typeof resolved !== "object") {
    return finalizationFailure("plugin-finalizer-invalid", "local rule finalizer returned an invalid shape", ruleName);
  }
  const record = resolved as Record<string, unknown>;
  if (record.status === "passed") return { status: "passed" };
  if (record.status !== "failed" || typeof record.message !== "string") {
    return finalizationFailure("plugin-finalizer-invalid", "local rule finalizer returned an invalid shape", ruleName);
  }
  if (new TextEncoder().encode(record.message).byteLength > MAX_FINALIZATION_MESSAGE_BYTES) {
    return finalizationFailure("plugin-diagnostic-too-large", "local rule finalizer message is too large", ruleName);
  }
  return { status: "failed", message: record.message };
}

function sumElementsInspected(
  plan: ResolvedCheckPlan,
  cases: readonly MutableCaseResult[],
  ruleIndex: number,
): number {
  return cases.reduce((count, caseResult, caseIndex) => {
    const auditCase = plan.cases[caseIndex];
    const effectiveRule = auditCase?.rules[ruleIndex];
    if (effectiveRule?.enabled !== true) return count;
    return count + (caseResult.rules[ruleIndex]?.elementsInspected ?? 0);
  }, 0);
}

export async function finalizeLocalRule(
  rule: EffectiveLocalRule,
  contract: LoadedPluginContract,
  plan: ResolvedCheckPlan,
  cases: readonly MutableCaseResult[],
  ruleIndex: number,
  signal?: AbortSignal,
  options: { readonly timeoutMs?: number } = {},
): Promise<RuleFinalization> {
  const timeoutMs = options.timeoutMs ?? PLUGIN_FINALIZATION_TIMEOUT_MS;
  const elementsInspected = sumElementsInspected(plan, cases, ruleIndex);
  const observations = buildLocalRuleObservations(rule, plan, cases, ruleIndex);
  const boundsFailure = validateObservationBounds(observations, rule.name);
  if (boundsFailure !== null) {
    return { name: rule.name, status: "failed", elementsInspected, failure: boundsFailure };
  }
  if (contract.finalize === null) {
    return { name: rule.name, status: "passed", elementsInspected, failure: null };
  }

  if (signal?.aborted === true) {
    return {
      name: rule.name,
      status: "failed",
      elementsInspected,
      failure: {
        stage: "interrupt",
        code: "signal-interrupt",
        message: "operation interrupted by signal",
        target: null,
        device: null,
        rule: rule.name,
      },
    };
  }

  let finalizeJs: string;
  try {
    finalizeJs = transpilePluginCallbackSource(contract.descriptor.finalizeSource ?? "");
  } catch {
    return {
      name: rule.name,
      status: "failed",
      elementsInspected,
      failure: finalizationFailure(
        "plugin-finalizer-invalid",
        "local rule finalizer could not be prepared for execution",
        rule.name,
      ),
    };
  }

  const AsyncFunctionCtor = Object.getPrototypeOf(async function pluginFinalize() {}).constructor as new (
    ...args: string[]
  ) => (observations: LocalRuleFinalizationInput) => Promise<unknown>;
  const finalize = new AsyncFunctionCtor("observations", `return (${finalizeJs})(observations);`);

  const invocation = (async () => {
    try {
      return parseFinalizerOutcome(await finalize(observations), rule.name);
    } catch (error) {
      return finalizationFailure("plugin-finalizer-invalid", "local rule finalizer failed", rule.name);
    }
  })();

  let abortListener: (() => void) | null = null;
  const interruption =
    signal === undefined
      ? null
      : new Promise<Failure>((resolveInterruption) => {
          abortListener = () =>
            resolveInterruption({
              stage: "interrupt",
              code: "signal-interrupt",
              message: "operation interrupted by signal",
              target: null,
              device: null,
              rule: rule.name,
            });
          signal.addEventListener("abort", abortListener, { once: true });
        });
  const timeout = new Promise<Failure>((resolveTimeout) => {
    setTimeout(
      () =>
        resolveTimeout(
          finalizationFailure(
            "plugin-finalization-timeout",
            `local rule finalization exceeded ${timeoutMs} ms`,
            rule.name,
          ),
        ),
      timeoutMs,
    );
  });

  try {
    const outcome = await Promise.race([invocation, timeout, ...(interruption === null ? [] : [interruption])]);
    if ("stage" in outcome) {
      return { name: rule.name, status: "failed", elementsInspected, failure: outcome };
    }
    if (outcome.status === "passed") {
      return { name: rule.name, status: "passed", elementsInspected, failure: null };
    }
    return {
      name: rule.name,
      status: "failed",
      elementsInspected,
      failure: finalizationFailure("plugin-finalizer-invalid", outcome.message, rule.name),
    };
  } finally {
    if (abortListener !== null && signal !== undefined) signal.removeEventListener("abort", abortListener);
  }
}
