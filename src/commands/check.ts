import { platform, arch, release } from "node:os";
import type { BrowserEngine } from "../contracts/config";
import type { EngineExecution, RunExecution } from "../contracts/result";
import type { BrowserRunScope } from "../browser/lifecycle";
import { managedExecutable } from "../browser/management";
import { environmentUserAgent } from "../browser/emulation";
import { evaluateSvgTextClipping } from "../rules/svg-text-clipping";
import type { Page } from "playwright";
import type { EffectiveAuditCase, EffectiveRuleForTarget, ResolvedCheckPlan } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";
import type { RunResult } from "../contracts/result";
import { loadConfig } from "../config/load";
import { resolveAdHocTarget, resolveTargets, type PlanResolution } from "../config/merge";
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

export async function resolveCheckPlan(
  cwd: string,
  url: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<BoundaryResult<ResolvedCheckBundle>> {
  const loaded = await loadConfig(cwd);
  if (!loaded.ok) return boundaryFailure(loaded.failure);
  let resolved: PlanResolution;
  let source: "config" | "provider";
  if (url !== null) {
    resolved = resolveAdHocTarget(loaded.value, url);
    source = "config";
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
    resolved = resolveTargets(loaded.value, targets.value);
    source = loaded.value.provider.type === "static" ? "config" : "provider";
  }
  if (!resolved.ok) {
    const { message, target, device, rule } = resolved.violation;
    return boundaryFailure({
      stage: source,
      code: source === "config" ? "config-schema-invalid" : "provider-output-invalid",
      message, target, device, rule,
    });
  }
  const plan = resolved.value;
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
  } else if (rule.type === "svg-text-clipping") {
    evaluation = evaluateSvgTextClipping(page, rule, auditCase?.name ?? null);
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

function productionDependencies(pluginRegistry: PluginRuntimeRegistry | null, plan: ResolvedCheckPlan): CheckDependencies<Page> {
  const auditCaseByPage = new WeakMap<Page, { auditCase: EffectiveAuditCase; fixedUrl: string }>();
  return {
    async launch(signal) {
      const engines: EngineExecution[] = [...new Set(plan.environments.map((item) => item.browser))].map((engine) => {
        const executable = managedExecutable(engine);
        return { engine, expectedVersion: executable.browserVersion ?? null, obtainedVersion: null, versionSource: null, revision: executable.revision, artifact: { name: executable.name, directory: executable.directory, downloadURLs: executable.downloadURLs }, executablePath: executable.executablePath(), diagnostic: null };
      });
      const execution: RunExecution = {
        host: { platform: platform(), architecture: arch(), release: release() }, engines,
        environments: plan.environments.map((environment) => {
          let userAgent: string | null = null;
          try { userAgent = environmentUserAgent(environment); } catch {}
          return { ...environment, userAgent };
        }),
        devices: [...new Map(plan.cases.map((item) => [item.deviceName, { name: item.deviceName, viewport: item.viewport, screen: item.screen, deviceScaleFactor: item.deviceScaleFactor, isMobile: item.isMobile, hasTouch: item.hasTouch }])).values()],
      };
      const scopes = new Map<BrowserEngine, Promise<BoundaryResult<BrowserRunScope>>>();
      const acquireEngine = (engine: BrowserEngine) => {
        let pending = scopes.get(engine);
        if (pending === undefined) {
          pending = createBrowserRunScope({ engine, ...(signal === undefined ? {} : { signal }) }).then(async (created) => {
            const metadata = engines.find((item) => item.engine === engine)!;
            if (!created.ok) { metadata.diagnostic = created.failure.message; return created; }
            metadata.obtainedVersion = created.value.browserVersion;
            metadata.versionSource = engine === "webkit" ? "playwright-metadata" : "browser.version";
            if (metadata.expectedVersion !== null && metadata.obtainedVersion !== metadata.expectedVersion) {
              await created.value.close();
              metadata.diagnostic = "managed browser version does not match expected version";
              return boundaryFailure({ stage: "browser-setup", code: "browser-launch-failed", message: metadata.diagnostic, target: null, device: null, rule: null });
            }
            return created;
          });
          scopes.set(engine, pending);
        }
        return pending;
      };
      return boundarySuccess({
        execution,
        openCase: async (auditCase, caseSignal) => {
          const created = await acquireEngine(auditCase.environment.browser);
          if (!created.ok) return created;
          let appliedCase: EffectiveAuditCase;
          try { appliedCase = { ...auditCase, userAgent: environmentUserAgent(auditCase.environment) }; } catch (error) {
            return boundaryFailure({ stage: "browser-setup", code: "browser-context-failed", message: error instanceof Error ? error.message : "required environment preset is unavailable", target: auditCase.name, device: auditCase.deviceName, rule: null });
          }
          const opened = await created.value.acquireCase(appliedCase, caseSignal);
          if (!opened.ok) return opened;
          auditCaseByPage.set(opened.value.page, { auditCase: appliedCase, fixedUrl: opened.value.actualUrl ?? auditCase.url });
          return opened;
        },
        close: async () => {
          let failure: Failure | null = null;
          for (const pending of scopes.values()) {
            const created = await pending;
            if (!created.ok) continue;
            const closed = await created.value.close();
            if (!closed.ok) failure ??= closed.failure;
          }
          return failure === null ? boundarySuccess(undefined) : boundaryFailure(failure);
        },
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
  return runResolvedCheck(resolved.value.plan, productionDependencies(resolved.value.pluginRegistry, resolved.value.plan), {
    toolVersion,
    ...(signal === undefined ? {} : { signal }),
  });
}
