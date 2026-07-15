import type {
  EffectiveAuditCase,
  EffectiveRuleForTarget,
  ResolvedCheckPlan,
} from "../contracts/config";
import type { RuleEvaluationOutcome, RuleFinalization, Violation } from "../contracts/evaluation";
import {
  boundaryFailure,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import type {
  CaseResult,
  CaseStatus,
  RuleResultStatus,
  RunResultV2,
  RunSummary,
} from "../contracts/result";

interface TargetScope<PageHandle> {
  readonly page: PageHandle;
  close(): Promise<BoundaryResult<void>>;
}

interface BrowserRun<PageHandle> {
  readonly browserVersion: string | null;
  openCase(auditCase: EffectiveAuditCase, signal?: AbortSignal): Promise<BoundaryResult<TargetScope<PageHandle>>>;
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
  failure: Failure | null;
}

interface MutableCaseResult {
  target: { name: string; url: string };
  device: {
    name: string;
    viewport: { width: number; height: number };
    screen: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    userAgent: string | null;
  };
  locale: string;
  timezoneId: string;
  status: CaseStatus;
  rules: MutableRuleResult[];
  failures: Failure[];
}

function scopeFailure(failure: Failure, target: string | null, device: string | null, rule: string | null): Failure {
  return { ...failure, target, device, rule };
}

function unexpectedFailure(
  code: "browser-launch-failed" | "browser-context-failed" | "browser-cleanup-failed" | "rule-script-failed",
  target: string | null,
  device: string | null,
  rule: string | null,
): Failure {
  const stage = code === "rule-script-failed" ? "rule-evaluation" : "browser-setup";
  return { stage, code, message: "internal adapter operation failed", target, device, rule };
}

function seededCases(plan: ResolvedCheckPlan): MutableCaseResult[] {
  return plan.cases.map((auditCase) => ({
    target: { name: auditCase.name, url: auditCase.url },
    device: {
      name: auditCase.deviceName,
      viewport: auditCase.viewport,
      screen: auditCase.screen,
      deviceScaleFactor: auditCase.deviceScaleFactor,
      isMobile: auditCase.isMobile,
      hasTouch: auditCase.hasTouch,
      userAgent: auditCase.userAgent,
    },
    locale: auditCase.locale,
    timezoneId: auditCase.timezoneId,
    status: "not-executed",
    rules: auditCase.rules.map((rule) => ({
      name: rule.name,
      type: rule.type,
      status: rule.enabled ? "not-executed" : "disabled",
      labelsInspected: 0,
      violations: [],
      failure: null,
    })),
    failures: [],
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

function summarize(
  targetCount: number,
  cases: readonly CaseResult[],
  finalizations: readonly RuleFinalization[],
  runFailures: readonly Failure[],
): RunSummary {
  const caseCounts = { resolved: cases.length, complete: 0, partial: 0, failed: 0, notExecuted: 0 };
  const ruleCounts = { clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 };
  const finalizationCounts = { passed: 0, failed: 0, notExecuted: 0 };
  let violations = 0;
  let matchedElements = 0;
  let executionFailures = runFailures.length;
  for (const caseResult of cases) {
    if (caseResult.status === "complete") caseCounts.complete += 1;
    else if (caseResult.status === "partial") caseCounts.partial += 1;
    else if (caseResult.status === "failed") caseCounts.failed += 1;
    else caseCounts.notExecuted += 1;
    executionFailures += caseResult.failures.length;
    for (const rule of caseResult.rules) {
      ruleCounts[rule.status === "not-executed" ? "notExecuted" : rule.status] += 1;
      violations += rule.violations.length;
      matchedElements += rule.labelsInspected;
      if (rule.failure !== null) executionFailures += 1;
    }
  }
  for (const finalization of finalizations) {
    finalizationCounts[finalization.status === "not-executed" ? "notExecuted" : finalization.status] += 1;
    if (finalization.failure !== null) executionFailures += 1;
  }
  return {
    targets: { resolved: targetCount },
    cases: caseCounts,
    ruleEvaluations: ruleCounts,
    ruleFinalizations: finalizationCounts,
    violations,
    matchedElements,
    executionFailures,
  };
}

function completedResult(
  toolVersion: string,
  browserVersion: string | null,
  targetCount: number,
  cases: readonly CaseResult[],
  finalizations: readonly RuleFinalization[],
  runFailures: readonly Failure[],
): RunResultV2 {
  const summary = summarize(targetCount, cases, finalizations, runFailures);
  return {
    schemaVersion: 2,
    status: summary.executionFailures > 0 ? "incomplete" : summary.violations > 0 ? "violations" : "clean",
    tool: { name: "vlint", version: toolVersion },
    environment: {
      platform: "linux",
      arch: "x64",
      browser: { name: "chromium", version: browserVersion },
    },
    summary,
    cases,
    ruleFinalizations: finalizations,
    failures: runFailures,
  };
}

export function resultForResolutionFailure(toolVersion: string, failure: Failure): RunResultV2 {
  return completedResult(toolVersion, null, 0, [], [], [failure]);
}

export function exitCodeForResult(result: RunResultV2): 0 | 1 | 2 {
  if (result.status === "incomplete") return 2;
  return result.status === "violations" ? 1 : 0;
}

/**
 * Resolves run-wide zero-label finalizations in declaration order. Only called
 * when every case completed, so a zero-label rule is a real global regression
 * rather than an artefact of partial observation. The first failing rule stops
 * the cascade; later rules stay not-executed.
 */
function resolveFinalizations(
  plan: ResolvedCheckPlan,
  cases: readonly MutableCaseResult[],
): RuleFinalization[] {
  const resolvedFinalizations: RuleFinalization[] = [];
  for (let ruleIndex = 0; ruleIndex < plan.rules.length; ruleIndex += 1) {
    const rule = plan.rules[ruleIndex];
    if (rule === undefined) continue;
    const enabledPairCount = plan.cases.reduce(
      (count, auditCase) => count + (auditCase.rules[ruleIndex]?.enabled === true ? 1 : 0),
      0,
    );
    const labelsInspected = cases.reduce(
      (count, caseResult) => count + (caseResult.rules[ruleIndex]?.labelsInspected ?? 0),
      0,
    );
    if (enabledPairCount > 0 && labelsInspected === 0 && !rule.allowZeroLabels) {
      const finalizationFailure: Failure = {
        stage: "rule-evaluation",
        code: "zero-labels-global",
        message: `rule ${rule.name} inspected zero labels across the run`,
        target: null,
        device: null,
        rule: rule.name,
      };
      resolvedFinalizations.push({
        name: rule.name,
        status: "failed",
        labelsInspected,
        failure: finalizationFailure,
      });
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
  return resolvedFinalizations;
}

/**
 * Runs every audit case on a fixed worker pool of at most two, sharing one
 * browser. Cases are pre-seeded in declared order and each worker writes its
 * result back into the seeded slot, so completion order never leaks into the
 * output. A case-level failure (navigation, readiness, rule, or scope cleanup)
 * is recorded on that case and never stops another case (KTD7 collect-all). An
 * external abort is the single exception: it halts new dispatch, lets active
 * scopes close, leaves unstarted cases not-executed, and records exactly one
 * run-level interrupt failure. Global finalization runs only when every case
 * completed, so a partial run cannot misread a zero-label rule (KTD8).
 */
export async function runResolvedCheck<PageHandle>(
  plan: ResolvedCheckPlan,
  dependencies: CheckDependencies<PageHandle>,
  options: CheckOptions,
): Promise<RunResultV2> {
  const cases = seededCases(plan);
  let finalizations = seededFinalizations(plan);
  const runFailures: Failure[] = [];
  let browserVersion: string | null = null;
  let interrupted = false;
  let interruptRecorded = false;

  // A signal-interrupt failure is a run-level concern and is recorded exactly
  // once regardless of how many active operations observe the abort.
  const recordInterrupt = (): void => {
    interrupted = true;
    if (!interruptRecorded) {
      interruptRecorded = true;
      runFailures.push({
        stage: "interrupt",
        code: "signal-interrupt",
        message: "operation cancelled",
        target: null,
        device: null,
        rule: null,
      });
    }
  };

  const onAbort = (): void => recordInterrupt();
  if (options.signal !== undefined) {
    if (options.signal.aborted) recordInterrupt();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let launch: BoundaryResult<BrowserRun<PageHandle>>;
  try {
    launch = await dependencies.launch(options.signal);
  } catch {
    launch = boundaryFailure(unexpectedFailure("browser-launch-failed", null, null, null));
  }
  if (!launch.ok) {
    if (launch.failure.code === "signal-interrupt") recordInterrupt();
    else runFailures.push(scopeFailure(launch.failure, null, null, null));
    return completedResult(options.toolVersion, null, plan.targets.length, cases, finalizations, runFailures);
  }

  const browser = launch.value;
  browserVersion = browser.browserVersion;

  const runCase = async (caseIndex: number): Promise<void> => {
    const auditCase = plan.cases[caseIndex];
    const caseResult = cases[caseIndex];
    if (auditCase === undefined || caseResult === undefined) return;
    try {
      let opened: BoundaryResult<TargetScope<PageHandle>>;
      try {
        opened = await browser.openCase(auditCase, options.signal);
      } catch {
        opened = boundaryFailure(
          unexpectedFailure("browser-context-failed", auditCase.name, auditCase.deviceName, null),
        );
      }
      if (!opened.ok) {
        if (opened.failure.code === "signal-interrupt") {
          recordInterrupt();
          caseResult.status = "failed";
        } else {
          caseResult.status = "failed";
          caseResult.failures.push(scopeFailure(opened.failure, auditCase.name, auditCase.deviceName, null));
        }
        return;
      }

      const targetScope = opened.value;
      let pairFailedAt: number | null = null;
      for (let ruleIndex = 0; ruleIndex < auditCase.rules.length; ruleIndex += 1) {
        const effectiveRule = auditCase.rules[ruleIndex];
        const ruleResult = caseResult.rules[ruleIndex];
        if (effectiveRule === undefined || ruleResult === undefined || !effectiveRule.enabled) continue;
        let outcome: RuleEvaluationOutcome;
        try {
          outcome = await dependencies.evaluate(targetScope.page, effectiveRule, options.signal);
        } catch {
          outcome = {
            facts: { labelsInspected: 0, violations: [] },
            failure: unexpectedFailure(
              "rule-script-failed",
              auditCase.name,
              auditCase.deviceName,
              effectiveRule.name,
            ),
          };
        }
        ruleResult.labelsInspected = outcome.facts.labelsInspected;
        ruleResult.violations = outcome.facts.violations;
        if (outcome.failure !== null) {
          if (outcome.failure.code === "signal-interrupt") {
            recordInterrupt();
            pairFailedAt = ruleIndex;
            break;
          }
          ruleResult.status = "failed";
          ruleResult.failure = scopeFailure(
            outcome.failure,
            auditCase.name,
            auditCase.deviceName,
            effectiveRule.name,
          );
          pairFailedAt = ruleIndex;
          break;
        }
        ruleResult.status = outcome.facts.violations.length > 0 ? "violations" : "clean";
      }

      let closeResult: BoundaryResult<void>;
      try {
        closeResult = await targetScope.close();
      } catch {
        closeResult = boundaryFailure(
          unexpectedFailure("browser-cleanup-failed", auditCase.name, auditCase.deviceName, null),
        );
      }
      // Lossless: a cleanup failure coexists with an intra-case rule failure
      // rather than being discarded. An interrupt-induced cleanup failure is
      // normalized to the single run-level record and not duplicated here.
      if (!closeResult.ok && closeResult.failure.code !== "signal-interrupt") {
        caseResult.failures.push(scopeFailure(closeResult.failure, auditCase.name, auditCase.deviceName, null));
      }

      if (pairFailedAt !== null) {
        const hasLaterNotExecuted = caseResult.rules.some(
          (rule, index) => index > pairFailedAt! && rule.status === "not-executed",
        );
        caseResult.status = hasLaterNotExecuted ? "partial" : "failed";
      } else if (!closeResult.ok) {
        caseResult.status = "failed";
      } else {
        caseResult.status = "complete";
      }
    } catch {
      // Any unexpected throw is contained as a case failure; a worker never rejects.
      if (caseResult.status === "not-executed") caseResult.status = "failed";
      caseResult.failures.push(
        scopeFailure(
          unexpectedFailure("browser-context-failed", auditCase.name, auditCase.deviceName, null),
          auditCase.name,
          auditCase.deviceName,
          null,
        ),
      );
    }
  };

  const workerCount = Math.min(2, plan.cases.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    try {
      while (!interrupted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= plan.cases.length) return;
        await runCase(index);
      }
    } catch {
      // Defensive: runCase contains its own throws, so reaching here would only
      // be a scheduler bug. Record a run-level failure rather than rejecting
      // the pool and discarding the other worker's results.
      runFailures.push(scopeFailure(unexpectedFailure("browser-context-failed", null, null, null), null, null, null));
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) workers.push(worker());
  await Promise.all(workers);
  if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);

  // Global finalization runs only on a fully observed run, so a failing or
  // interrupted case cannot trigger a false zero-label verdict.
  if (cases.every((caseResult) => caseResult.status === "complete")) {
    finalizations = resolveFinalizations(plan, cases);
  }

  try {
    const close = await browser.close();
    if (!close.ok) {
      if (close.failure.code === "signal-interrupt") recordInterrupt();
      else runFailures.push(scopeFailure(close.failure, null, null, null));
    }
  } catch {
    runFailures.push(unexpectedFailure("browser-cleanup-failed", null, null, null));
  }
  return completedResult(options.toolVersion, browserVersion, plan.targets.length, cases, finalizations, runFailures);
}
