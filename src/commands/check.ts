import type { Page } from "playwright";
import type { DeviceProfile, EffectiveAuditCase, EffectiveRule, EffectiveRuleForTarget, ResolvedCheckPlan, Target } from "../contracts/config";
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
import { measureRule } from "../browser/measurement";
import { evaluatePageHorizontalOverflow } from "../rules/page-horizontal-overflow";
import { evaluateTabLabelSingleLine } from "../rules/tab-label-single-line";
import { evaluateTableHeaderSingleLine } from "../rules/table-header-single-line";
import { evaluateTableCellTextOverlap } from "../rules/table-cell-text-overlap";
import {
  resultForResolutionFailure,
  runResolvedCheck,
  type CheckDependencies,
} from "../run/orchestrator";

export interface ResolvedCheckBundle {
  readonly plan: ResolvedCheckPlan;
  readonly pluginRegistry: PluginRuntimeRegistry | null;
}

function validateMinimums(
  targets: readonly Target[],
  devices: readonly DeviceProfile[],
  rules: readonly EffectiveRule[],
  source: "config" | "provider",
): BoundaryResult<void> {
  const failureStage: Failure["stage"] = source;
  const failureCode: Failure["code"] = source === "config" ? "config-schema-invalid" : "provider-output-invalid";
  const names = new Set(devices.map((device) => device.name));
  for (const target of targets) {
    for (const device of Object.keys(target.deviceRuleMinimums ?? {})) {
      if (!names.has(device)) return boundaryFailure({ stage: failureStage, code: failureCode, message: `unknown device minimum: ${device}`, target: target.name, device, rule: null });
    }
  }
  for (const target of targets) {
    for (const device of devices) {
      for (const rule of rules) {
        const targetMinimum = target.ruleOverrides?.[rule.name]?.minimumInspected;
        const deviceMinimum = device.ruleMinimums?.[rule.name];
        if (targetMinimum !== undefined && deviceMinimum !== undefined && targetMinimum !== deviceMinimum && target.deviceRuleMinimums?.[device.name]?.[rule.name] === undefined) {
          return boundaryFailure({
            stage: failureStage, code: failureCode,
            message: "target and device minimums conflict; specify deviceRuleMinimums",
            target: target.name, device: device.name, rule: rule.name,
          });
        }
      }
    }
  }
  return boundarySuccess(undefined);
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
  let targetsForMinimums: readonly Target[];
  let minimumsSource: "config" | "provider";
  if (url !== null) {
    plan = resolveAdHocTarget(loaded.value, url);
    targetsForMinimums = loaded.value.provider?.type === "static" ? loaded.value.provider.targets : [];
    minimumsSource = "config";
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
    targetsForMinimums = targets.value;
    minimumsSource = loaded.value.provider.type === "static" ? "config" : "provider";
  }
  const minimums = validateMinimums(targetsForMinimums, loaded.value.devices, loaded.value.rules, minimumsSource);
  if (!minimums.ok) return boundaryFailure(minimums.failure);
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
  } else if (rule.type === "table-cell-text-overlap") {
    evaluation = evaluateTableCellTextOverlap(page, rule, auditCase?.name ?? null);
  } else if (rule.type === "table-header-single-line") {
    evaluation = Promise.resolve(
      evaluateTableHeaderSingleLine(page, rule, auditCase?.name ?? null),
    );
  } else if (rule.type === "page-horizontal-overflow") {
    evaluation = Promise.resolve(
      evaluatePageHorizontalOverflow(page, rule, auditCase?.name ?? null),
    );
  } else {
    evaluation = Promise.resolve(
      evaluateTabLabelSingleLine(page, rule, auditCase?.name ?? null),
    );
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
  const auditCaseByPage = new WeakMap<Page, { auditCase: EffectiveAuditCase; fixedUrl: string }>();
  return {
    async launch(signal) {
      const created = await createBrowserRunScope(signal === undefined ? {} : { signal });
      if (!created.ok) return boundaryFailure(created.failure);
      const scope = created.value;
      return boundarySuccess({
        browserVersion: scope.browserVersion,
        openCase: async (auditCase, caseSignal) => {
          const opened = await scope.acquireCase(auditCase, caseSignal);
          if (!opened.ok) return opened;
          auditCaseByPage.set(opened.value.page, { auditCase, fixedUrl: opened.value.actualUrl ?? auditCase.url });
          return opened;
        },
        close: () => scope.close(),
      });
    },
    evaluate: (page, rule, signal) => {
      const acquired = auditCaseByPage.get(page);
      if (acquired === undefined) return evaluateWithCancellation(page, rule, undefined, pluginRegistry, signal);
      return measureRule(page, acquired.auditCase, acquired.fixedUrl, (guarded) =>
        evaluateWithCancellation(guarded, rule, acquired.auditCase, pluginRegistry, signal));
    },
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
