import type {
  EffectiveRuleForTarget,
  EffectiveTarget,
  ResolvedCheckPlan,
} from "../contracts/config";
import type { RuleEvaluationOutcome, RuleFinalization, Violation } from "../contracts/evaluation";
import {
  boundaryFailure,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import type {
  RuleResult,
  RuleResultStatus,
  RunResultV1,
  RunSummary,
  TargetResult,
  TargetStatus,
} from "../contracts/result";

interface TargetScope<PageHandle> {
  readonly page: PageHandle;
  close(): Promise<BoundaryResult<void>>;
}

interface BrowserRun<PageHandle> {
  readonly browserVersion: string | null;
  openTarget(target: EffectiveTarget, signal?: AbortSignal): Promise<BoundaryResult<TargetScope<PageHandle>>>;
  close(): Promise<BoundaryResult<void>>;
}

export interface CheckDependencies<PageHandle> {
  launch(signal?: AbortSignal): Promise<BoundaryResult<BrowserRun<PageHandle>>>;
  evaluate(
    page: PageHandle,
    rule: EffectiveRuleForTarget,
    signal?: AbortSignal,
  ): Promise<RuleEvaluationOutcome>;
}

export interface CheckOptions {
  readonly toolVersion: string;
  readonly signal?: AbortSignal;
}

interface MutableRuleResult {
  name: string;
  type: "tab-label-single-line";
  status: RuleResultStatus;
  labelsInspected: number;
  violations: readonly Violation[];
}

interface MutableTargetResult {
  name: string;
  url: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
  status: TargetStatus;
  rules: MutableRuleResult[];
}

function scopeFailure(failure: Failure, target: string | null, rule: string | null): Failure {
  return { ...failure, target, rule };
}

function unexpectedFailure(
  code: "browser-launch-failed" | "browser-context-failed" | "browser-cleanup-failed" | "rule-script-failed",
  target: string | null,
  rule: string | null,
): Failure {
  const stage = code === "rule-script-failed" ? "rule-evaluation" : "browser-setup";
  return { stage, code, message: "internal adapter operation failed", target, rule };
}

function seededTargets(plan: ResolvedCheckPlan): MutableTargetResult[] {
  return plan.targets.map((target) => ({
    name: target.name,
    url: target.url,
    viewport: target.viewport,
    deviceScaleFactor: target.deviceScaleFactor,
    locale: target.locale,
    timezoneId: target.timezoneId,
    status: "not-executed",
    rules: target.rules.map((rule) => ({
      name: rule.name,
      type: rule.type,
      status: rule.enabled ? "not-executed" : "disabled",
      labelsInspected: 0,
      violations: [],
    })),
  }));
}

function seededFinalizations(plan: ResolvedCheckPlan): RuleFinalization[] {
  return plan.rules.map((rule) => ({
    name: rule.name,
    status: "not-executed",
    labelsInspected: 0,
    failure: null,
  }));
}

function summarize(targets: readonly TargetResult[], finalizations: readonly RuleFinalization[], failure: Failure | null): RunSummary {
  const targetCounts = { resolved: targets.length, complete: 0, partial: 0, failed: 0, notExecuted: 0 };
  const ruleCounts = { clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 };
  const finalizationCounts = { passed: 0, failed: 0, notExecuted: 0 };
  let violations = 0;
  let matchedElements = 0;
  for (const target of targets) {
    if (target.status === "complete") targetCounts.complete += 1;
    else if (target.status === "partial") targetCounts.partial += 1;
    else if (target.status === "failed") targetCounts.failed += 1;
    else targetCounts.notExecuted += 1;
    for (const rule of target.rules) {
      ruleCounts[rule.status === "not-executed" ? "notExecuted" : rule.status] += 1;
      violations += rule.violations.length;
      matchedElements += rule.labelsInspected;
    }
  }
  for (const finalization of finalizations) {
    finalizationCounts[finalization.status === "not-executed" ? "notExecuted" : finalization.status] += 1;
  }
  return {
    targets: targetCounts,
    ruleEvaluations: ruleCounts,
    ruleFinalizations: finalizationCounts,
    violations,
    matchedElements,
    executionFailures: failure === null ? 0 : 1,
  };
}

function completedResult(
  toolVersion: string,
  browserVersion: string | null,
  targets: readonly TargetResult[],
  finalizations: readonly RuleFinalization[],
  failure: Failure | null,
): RunResultV1 {
  const summary = summarize(targets, finalizations, failure);
  return {
    schemaVersion: 1,
    status: failure !== null ? "incomplete" : summary.violations > 0 ? "violations" : "clean",
    tool: { name: "vlint", version: toolVersion },
    environment: {
      platform: "linux",
      arch: "x64",
      browser: { name: "chromium", version: browserVersion },
    },
    summary,
    targets,
    ruleFinalizations: finalizations,
    failure,
  };
}

export function resultForResolutionFailure(toolVersion: string, failure: Failure): RunResultV1 {
  return completedResult(toolVersion, null, [], [], failure);
}

export function exitCodeForResult(result: RunResultV1): 0 | 1 | 2 {
  if (result.status === "incomplete") return 2;
  return result.status === "violations" ? 1 : 0;
}

export async function runResolvedCheck<PageHandle>(
  plan: ResolvedCheckPlan,
  dependencies: CheckDependencies<PageHandle>,
  options: CheckOptions,
): Promise<RunResultV1> {
  const targets = seededTargets(plan);
  let finalizations = seededFinalizations(plan);
  let failure: Failure | null = null;
  let browserVersion: string | null = null;
  let browserRun: BrowserRun<PageHandle> | null = null;

  let launch: BoundaryResult<BrowserRun<PageHandle>>;
  try {
    launch = await dependencies.launch(options.signal);
  } catch {
    launch = boundaryFailure(unexpectedFailure("browser-launch-failed", null, null));
  }
  if (!launch.ok) {
    failure = scopeFailure(launch.failure, null, null);
    return completedResult(options.toolVersion, null, targets, finalizations, failure);
  }

  browserRun = launch.value;
  browserVersion = browserRun.browserVersion;
  for (let targetIndex = 0; targetIndex < plan.targets.length && failure === null; targetIndex += 1) {
    const effectiveTarget = plan.targets[targetIndex];
    const targetResult = targets[targetIndex];
    if (effectiveTarget === undefined || targetResult === undefined) break;
    let targetScope: TargetScope<PageHandle> | null = null;
    let opened: BoundaryResult<TargetScope<PageHandle>>;
    try {
      opened = await browserRun.openTarget(effectiveTarget, options.signal);
    } catch {
      opened = boundaryFailure(unexpectedFailure("browser-context-failed", effectiveTarget.name, null));
    }
    if (!opened.ok) {
      targetResult.status = "failed";
      failure = scopeFailure(opened.failure, effectiveTarget.name, null);
      break;
    }

    targetScope = opened.value;
    let pairFailedAt: number | null = null;
    for (let ruleIndex = 0; ruleIndex < effectiveTarget.rules.length; ruleIndex += 1) {
      const effectiveRule = effectiveTarget.rules[ruleIndex];
      const ruleResult = targetResult.rules[ruleIndex];
      if (effectiveRule === undefined || ruleResult === undefined || !effectiveRule.enabled) continue;
      let outcome: RuleEvaluationOutcome;
      try {
        outcome = await dependencies.evaluate(targetScope.page, effectiveRule, options.signal);
      } catch {
        outcome = {
          facts: { labelsInspected: 0, violations: [] },
          failure: unexpectedFailure("rule-script-failed", effectiveTarget.name, effectiveRule.name),
        };
      }
      ruleResult.labelsInspected = outcome.facts.labelsInspected;
      ruleResult.violations = outcome.facts.violations;
      if (outcome.failure !== null) {
        ruleResult.status = "failed";
        pairFailedAt = ruleIndex;
        failure = scopeFailure(outcome.failure, effectiveTarget.name, effectiveRule.name);
        break;
      }
      ruleResult.status = outcome.facts.violations.length > 0 ? "violations" : "clean";
    }

    let closeResult: BoundaryResult<void>;
    try {
      closeResult = await targetScope.close();
    } catch {
      closeResult = boundaryFailure(unexpectedFailure("browser-cleanup-failed", effectiveTarget.name, null));
    }
    if (!closeResult.ok && failure === null) {
      failure = scopeFailure(closeResult.failure, effectiveTarget.name, null);
    }

    if (pairFailedAt !== null) {
      const hasLaterNotExecuted = targetResult.rules.some(
        (rule, index) => index > pairFailedAt! && rule.status === "not-executed",
      );
      targetResult.status = hasLaterNotExecuted ? "partial" : "failed";
    } else if (!closeResult.ok) targetResult.status = "failed";
    else targetResult.status = "complete";
  }

  if (failure === null) {
    const resolvedFinalizations: RuleFinalization[] = [];
    for (let ruleIndex = 0; ruleIndex < plan.rules.length; ruleIndex += 1) {
      const rule = plan.rules[ruleIndex];
      if (rule === undefined) continue;
      const enabledPairCount = plan.targets.reduce(
        (count, target) => count + (target.rules[ruleIndex]?.enabled === true ? 1 : 0),
        0,
      );
      const labelsInspected = targets.reduce(
        (count, target) => count + (target.rules[ruleIndex]?.labelsInspected ?? 0),
        0,
      );
      if (enabledPairCount > 0 && labelsInspected === 0 && !rule.allowZeroLabels) {
        const finalizationFailure: Failure = {
          stage: "rule-evaluation",
          code: "zero-labels-global",
          message: `rule ${rule.name} inspected zero labels across the run`,
          target: null,
          rule: rule.name,
        };
        resolvedFinalizations.push({
          name: rule.name,
          status: "failed",
          labelsInspected,
          failure: finalizationFailure,
        });
        failure = finalizationFailure;
        for (const later of plan.rules.slice(ruleIndex + 1)) {
          resolvedFinalizations.push({
            name: later.name,
            status: "not-executed",
            labelsInspected: 0,
            failure: null,
          });
        }
        break;
      }
      resolvedFinalizations.push({
        name: rule.name,
        status: "passed",
        labelsInspected,
        failure: null,
      });
    }
    finalizations = resolvedFinalizations;
  }

  try {
    const close = await browserRun.close();
    if (!close.ok && failure === null) failure = scopeFailure(close.failure, null, null);
  } catch {
    if (failure === null) failure = unexpectedFailure("browser-cleanup-failed", null, null);
  }
  return completedResult(options.toolVersion, browserVersion, targets, finalizations, failure);
}
