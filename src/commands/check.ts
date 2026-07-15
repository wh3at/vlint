import type { Page } from "playwright";
import type { EffectiveRuleForTarget, ResolvedCheckPlan } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";
import type { RunResultV3 } from "../contracts/result";
import { loadConfig } from "../config/load";
import { resolveAdHocTarget, resolveTargets } from "../config/merge";
import { resolveCommandProvider } from "../providers/command";
import { resolveStaticProvider } from "../providers/static";
import { createBrowserRunScope } from "../browser/lifecycle";
import { evaluatePageHorizontalOverflow } from "../rules/page-horizontal-overflow";
import { evaluateTabLabelSingleLine } from "../rules/tab-label-single-line";
import {
  resultForResolutionFailure,
  runResolvedCheck,
  type CheckDependencies,
} from "../run/orchestrator";

export async function resolveCheckPlan(
  cwd: string,
  url: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<BoundaryResult<ResolvedCheckPlan>> {
  const loaded = await loadConfig(cwd);
  if (!loaded.ok) return boundaryFailure(loaded.failure);
  if (url !== null) return boundarySuccess(resolveAdHocTarget(loaded.value, url));
  if (loaded.value.provider === undefined) {
    return boundaryFailure({
      stage: "config",
      code: "targets-empty",
      message: "no audit targets: provide --url or configure a target provider",
      target: null,
      device: null,
      rule: null,
    });
  }
  const context = {
    directory: loaded.value.directory,
    rules: loaded.value.rules,
    environment,
    ...(signal === undefined ? {} : { signal }),
  };
  const targets =
    loaded.value.provider.type === "static"
      ? await resolveStaticProvider(loaded.value.provider)
      : await resolveCommandProvider(loaded.value.provider, context);
  return targets.ok
    ? boundarySuccess(resolveTargets(loaded.value, targets.value))
    : boundaryFailure(targets.failure);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function interruptedOutcome(rule: EffectiveRuleForTarget): RuleEvaluationOutcome {
  const failure: Failure = {
    stage: "interrupt",
    code: "signal-interrupt",
    message: "operation interrupted by signal",
    target: null,
    device: null,
    rule: rule.name,
  };
  return { facts: { elementsInspected: 0, violations: [] }, failure };
}

async function evaluateWithCancellation(
  page: Page,
  rule: EffectiveRuleForTarget,
  signal?: AbortSignal,
): Promise<RuleEvaluationOutcome> {
  if (signal?.aborted === true) return interruptedOutcome(rule);
  const evaluation =
    rule.type === "tab-label-single-line"
      ? evaluateTabLabelSingleLine(page, rule)
      : evaluatePageHorizontalOverflow(page, rule);
  if (signal === undefined) return evaluation;
  let abortListener: (() => void) | null = null;
  const interruption = new Promise<RuleEvaluationOutcome>((resolveInterruption) => {
    abortListener = () => resolveInterruption(interruptedOutcome(rule));
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([evaluation, interruption]);
  } finally {
    if (abortListener !== null) signal.removeEventListener("abort", abortListener);
  }
}

function productionDependencies(): CheckDependencies<Page> {
  return {
    async launch(signal) {
      const created = await createBrowserRunScope(signal === undefined ? {} : { signal });
      if (!created.ok) return boundaryFailure(created.failure);
      const scope = created.value;
      return boundarySuccess({
        browserVersion: scope.browserVersion,
        openCase: (auditCase, caseSignal) => scope.acquireCase(auditCase, caseSignal),
        close: () => scope.close(),
      });
    },
    evaluate: evaluateWithCancellation,
  };
}

export async function runCheckCommand(
  cwd: string,
  url: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  toolVersion: string,
  signal?: AbortSignal,
): Promise<RunResultV3> {
  if (signalAborted(signal)) {
    return resultForResolutionFailure(toolVersion, {
      stage: "interrupt",
      code: "signal-interrupt",
      message: "operation interrupted by signal",
      target: null,
      device: null,
      rule: null,
    });
  }
  const resolved = await resolveCheckPlan(cwd, url, environment, signal);
  if (!resolved.ok) return resultForResolutionFailure(toolVersion, resolved.failure);
  if (signalAborted(signal)) {
    return resultForResolutionFailure(toolVersion, {
      stage: "interrupt",
      code: "signal-interrupt",
      message: "operation interrupted by signal",
      target: null,
      device: null,
      rule: null,
    });
  }
  return runResolvedCheck(resolved.value, productionDependencies(), {
    toolVersion,
    ...(signal === undefined ? {} : { signal }),
  });
}
