import type { Page } from "playwright";
import type { EffectiveAuditCase, EffectiveRuleForTarget, ResolvedCheckPlan } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";
import type { RunResult } from "../contracts/result";
import { loadConfig } from "../config/load";
import { resolveAdHocTarget, resolveTargets } from "../config/merge";
import { evaluateLocalRule } from "../plugins/evaluate";
import { finalizeLocalRule } from "../plugins/finalize";
import { loadLocalPluginsForConfig } from "../plugins/load";
import type { PluginRuntimeRegistry } from "../plugins/types";
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

export interface ResolvedCheckBundle {
  readonly plan: ResolvedCheckPlan;
  readonly pluginRegistry: PluginRuntimeRegistry | null;
}

export async function resolveCheckPlan(
  cwd: string,
  url: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<BoundaryResult<ResolvedCheckBundle>> {
  const loaded = await loadConfig(cwd);
  if (!loaded.ok) return boundaryFailure(loaded.failure);
  let plan: ResolvedCheckPlan;
  if (url !== null) {
    plan = resolveAdHocTarget(loaded.value, url);
  } else if (loaded.value.provider === undefined) {
    return boundaryFailure({
      stage: "config",
      code: "targets-empty",
      message: "no audit targets: provide --url or configure a target provider",
      target: null,
      device: null,
      rule: null,
    });
  } else {
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
    if (!targets.ok) return boundaryFailure(targets.failure);
    plan = resolveTargets(loaded.value, targets.value);
  }
  const plugins = await loadLocalPluginsForConfig(
    loaded.value,
    plan,
    signal === undefined ? {} : { signal },
  );
  if (!plugins.ok) return boundaryFailure(plugins.failure);
  return boundarySuccess({ plan, pluginRegistry: plugins.value });
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
  auditCase: EffectiveAuditCase | undefined,
  pluginRegistry: PluginRuntimeRegistry | null,
  signal?: AbortSignal,
): Promise<RuleEvaluationOutcome> {
  if (signal?.aborted === true) return interruptedOutcome(rule);
  let evaluation: Promise<RuleEvaluationOutcome>;
  if (rule.type === "local") {
    if (auditCase === undefined) {
      return {
        facts: { elementsInspected: 0, violations: [] },
        failure: {
          stage: "rule-evaluation",
          code: "plugin-load-failed",
          message: "local rule evaluation context is unavailable",
          target: null,
          device: null,
          rule: rule.name,
        },
      };
    }
    const contract = pluginRegistry?.get(rule.name);
    if (contract === undefined) {
      return {
        facts: { elementsInspected: 0, violations: [] },
        failure: {
          stage: "rule-evaluation",
          code: "plugin-load-failed",
          message: "local rule plugin is not loaded",
          target: auditCase.name,
          device: auditCase.deviceName,
          rule: rule.name,
        },
      };
    }
    evaluation = evaluateLocalRule(page, rule, contract, auditCase, auditCase.name, signal);
  } else {
    evaluation =
      rule.type === "tab-label-single-line"
        ? Promise.resolve(evaluateTabLabelSingleLine(page, rule, auditCase?.name ?? null))
        : Promise.resolve(evaluatePageHorizontalOverflow(page, rule, auditCase?.name ?? null));
  }
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

function productionDependencies(pluginRegistry: PluginRuntimeRegistry | null): CheckDependencies<Page> {
  const auditCaseByPage = new WeakMap<Page, EffectiveAuditCase>();
  return {
    async launch(signal) {
      const created = await createBrowserRunScope(signal === undefined ? {} : { signal });
      if (!created.ok) return boundaryFailure(created.failure);
      const scope = created.value;
      return boundarySuccess({
        browserVersion: scope.browserVersion,
        openCase: async (auditCase, caseSignal) => {
          const opened = await scope.acquireCase(auditCase, caseSignal);
          if (opened.ok) auditCaseByPage.set(opened.value.page, auditCase);
          return opened;
        },
        close: () => scope.close(),
      });
    },
    evaluate: (page, rule, signal) =>
      evaluateWithCancellation(page, rule, auditCaseByPage.get(page), pluginRegistry, signal),
    finalize: async (rule, ruleIndex, plan, cases, signal) => {
      if (rule.type !== "local") {
        throw new Error("finalize adapter invoked for a non-local rule");
      }
      const contract = pluginRegistry?.get(rule.name);
      if (contract === undefined) {
        return {
          name: rule.name,
          status: "failed",
          elementsInspected: 0,
          failure: {
            stage: "rule-evaluation",
            code: "plugin-load-failed",
            message: "local rule plugin is not loaded",
            target: null,
            device: null,
            rule: rule.name,
          },
        };
      }
      return finalizeLocalRule(rule, contract, plan, cases, ruleIndex, signal);
    },
  };
}

export async function runCheckCommand(
  cwd: string,
  url: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  toolVersion: string,
  signal?: AbortSignal,
): Promise<RunResult> {
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
  return runResolvedCheck(resolved.value.plan, productionDependencies(resolved.value.pluginRegistry), {
    toolVersion,
    ...(signal === undefined ? {} : { signal }),
  });
}
