import { describe, expect, test } from "bun:test";
import type {
  EffectiveAuditCase,
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  ResolvedCheckPlan,
} from "../../src/contracts/config";
import {
  isTabLabelSingleLineViolation,
  type LocalRuleFinalizationInput,
  type RuleEvaluationOutcome,
  type RuleFinalization,
} from "../../src/contracts/evaluation";
import { boundaryFailure, boundarySuccess, type Failure } from "../../src/contracts/failure";
import type { RunResultV4 } from "../../src/contracts/result";
import { isRunResultV4 } from "../../src/contracts/result";
import {
  exitCodeForResult,
  type CheckDependencies,
  runResolvedCheck,
} from "../../src/run/orchestrator";

const cleanOutcome: RuleEvaluationOutcome = {
  facts: { elementsInspected: 1, violations: [] },
  failure: null,
};

function rule(name: string, allowZeroLabels = false): EffectiveRule {
  return {
    name,
    type: "tab-label-single-line",
    enabled: true,
    additionalCandidateSelectors: [],
    excludeSelectors: [],
    labelSelector: null,
    minimumLabels: 0,
    allowZeroLabels,
  };
}

function target(name: string, rules: readonly EffectiveRule[], disabled: readonly string[] = []): EffectiveTarget {
  const targetRules: EffectiveRuleForTarget[] = rules.map((item) => ({
    ...item,
    enabled: !disabled.includes(item.name),
  }));
  return {
    name,
    url: `https://example.com/${name}`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    timeoutMs: 30_000,
    browserState: null,
    readyCondition: null,
    rules: targetRules,
  };
}

function makeCase(t: EffectiveTarget): EffectiveAuditCase {
  return {
    name: t.name,
    url: t.url,
    deviceName: "desktop",
    viewport: t.viewport,
    screen: t.viewport,
    deviceScaleFactor: t.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    locale: t.locale,
    timezoneId: t.timezoneId,
    timeoutMs: t.timeoutMs,
    browserState: t.browserState,
    readyCondition: t.readyCondition,
    rules: t.rules,
  };
}

function plan(targetNames: readonly string[], rules: readonly EffectiveRule[], disabled: Readonly<Record<string, readonly string[]>> = {}): ResolvedCheckPlan {
  const targets = targetNames.map((name) => target(name, rules, disabled[name] ?? []));
  return {
    rules,
    targets,
    cases: targets.map(makeCase),
  };
}

function localRule(name: string, path = "rules/local.ts"): EffectiveRule {
  return { name, type: "local", enabled: true, path, settings: {} };
}

interface DependencyOptions {
  readonly evaluate?: (page: string, rule: EffectiveRuleForTarget) => RuleEvaluationOutcome;
  readonly finalize?: (
    rule: EffectiveRuleForTarget,
    observations: LocalRuleFinalizationInput,
  ) => Promise<RuleFinalization>;
  readonly openFailure?: Readonly<Record<string, Failure>>;
  readonly launchFailure?: Failure;
  readonly closeFailure?: Failure;
  readonly targetCloseFailure?: Readonly<Record<string, Failure>>;
}

function dependencies(options: DependencyOptions = {}): CheckDependencies<string> {
  return {
    async launch() {
      if (options.launchFailure !== undefined) return boundaryFailure(options.launchFailure);
      return boundarySuccess({
        browserVersion: "149.0.7827.55",
        async openCase(item) {
          const failure = options.openFailure?.[item.name];
          if (failure !== undefined) return boundaryFailure(failure);
          return boundarySuccess({
            page: item.name,
            async close() {
              const closeFailure = options.targetCloseFailure?.[item.name];
              return closeFailure === undefined
                ? boundarySuccess(undefined)
                : boundaryFailure(closeFailure);
            },
          });
        },
        async close() {
          return options.closeFailure === undefined
            ? boundarySuccess(undefined)
            : boundaryFailure(options.closeFailure);
        },
      });
    },
    async evaluate(page, item) {
      return options.evaluate?.(page, item) ?? cleanOutcome;
    },
    ...(options.finalize === undefined
      ? {}
      : {
          finalize: async (rule, ruleIndex, resolved, cases) => {
            const { buildLocalRuleObservations } = await import("../../src/plugins/finalize");
            if (rule.type !== "local") throw new Error("expected local rule");
            const observations = buildLocalRuleObservations(rule, resolved, cases, ruleIndex);
            return options.finalize!(rule, observations);
          },
        }),
  };
}

function firstFailure(result: RunResultV4): Failure | undefined {
  return (
    result.failures[0] ??
    result.cases.flatMap((c) => c.failures)[0] ??
    result.cases.flatMap((c) => c.rules.map((r) => r.failure).filter((f): f is Failure => f !== null))[0] ??
    result.ruleFinalizations.map((f) => f.failure).filter((f): f is Failure => f !== null)[0]
  );
}

const navigationFailure: Failure = {
  stage: "navigation",
  code: "navigation-network",
  message: "navigation failed",
  target: null,
  device: null,
  rule: null,
};

describe("orchestrator result model", () => {
  test("completes every target and rule for a clean run", async () => {
    const result = await runResolvedCheck(plan(["a", "b"], [rule("tabs")]), dependencies(), {
      toolVersion: "0.1.0",
    });
    expect(result.status).toBe("clean");
    expect(exitCodeForResult(result)).toBe(0);
    expect(result.cases.map((item) => item.status)).toEqual(["complete", "complete"]);
    expect(result.summary).toMatchObject({
      targets: { resolved: 2 },
      cases: { resolved: 2, complete: 2, partial: 0, failed: 0, notExecuted: 0 },
      ruleEvaluations: { clean: 2, violations: 0, failed: 0, disabled: 0, notExecuted: 0 },
      violations: 0,
      elementsInspected: 2,
      executionFailures: 0,
    });
  });

  test("collects all violations in target-major and rule-major order", async () => {
    const rules = [rule("first"), rule("second")];
    const result = await runResolvedCheck(
      plan(["a", "b"], rules),
      dependencies({
        evaluate(page, item) {
          return {
            facts: {
              elementsInspected: 1,
              violations: [
                { type: "tab-label-single-line", text: `${page}:${item.name}`, lineCount: 2, geometry: { x: 0, y: 0, width: 1, height: 2 }, locator: `#${page}-${item.name}` },
              ],
            },
            failure: null,
          };
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("violations");
    expect(exitCodeForResult(result)).toBe(1);
    expect(
      result.cases.flatMap((item) =>
        item.rules.flatMap((entry) =>
          entry.violations.filter(isTabLabelSingleLineViolation).map((violation) => violation.text),
        ),
      ),
    ).toEqual(["a:first", "a:second", "b:first", "b:second"]);
  });

  test("collects all cases after a navigation precondition failure", async () => {
    const result = await runResolvedCheck(
      plan(["first", "broken", "later"], [rule("tabs")]),
      dependencies({
        openFailure: { broken: navigationFailure },
        evaluate(page) {
          return page === "first"
            ? {
                facts: {
                  elementsInspected: 1,
                  violations: [
                    { type: "tab-label-single-line", text: "wrapped", lineCount: 2, geometry: { x: 0, y: 0, width: 1, height: 2 }, locator: "#wrapped" },
                  ],
                },
                failure: null,
              }
            : cleanOutcome;
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(exitCodeForResult(result)).toBe(2);
    // collect-all: the failing case does not stop the unstarted later case.
    expect(result.cases.map((item) => item.status)).toEqual(["complete", "failed", "complete"]);
    expect(result.cases[0]?.rules[0]?.violations).toHaveLength(1);
    expect(result.cases[1]?.rules[0]?.status).toBe("not-executed");
    expect(result.cases[2]?.rules[0]?.status).toBe("clean");
    expect(firstFailure(result)).toMatchObject({ target: "broken", rule: null });
  });

  test("keeps evaluator facts and marks mixed attempted/not-executed cases partial across all cases", async () => {
    const rules = [rule("first"), rule("fails"), rule("later")];
    const result = await runResolvedCheck(
      plan(["a", "b"], rules),
      dependencies({
        evaluate(_page, item) {
          if (item.name !== "fails") return cleanOutcome;
          return {
            facts: {
              elementsInspected: 2,
              violations: [
                { type: "tab-label-single-line", text: "observed-before-failure", lineCount: 2, geometry: { x: 1, y: 1, width: 2, height: 2 }, locator: "#partial" },
              ],
            },
            failure: {
              stage: "rule-evaluation",
              code: "rule-script-failed",
              message: "measurement failed",
              target: null,
              device: null,
              rule: null,
            },
          };
        },
      }),
      { toolVersion: "0.1.0" },
    );
    // collect-all: both cases run; the failing rule makes each case partial.
    expect(result.cases.map((item) => item.status)).toEqual(["partial", "partial"]);
    expect(result.cases[0]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(result.cases[1]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(result.cases[0]?.rules[1]).toMatchObject({ elementsInspected: 2, violations: [{ text: "observed-before-failure" }] });
    expect(firstFailure(result)).toMatchObject({ target: "a", rule: "fails" });
  });

  test("keeps disabled pairs distinct from failed pairs across all cases", async () => {
    const rules = [rule("disabled"), rule("fails"), rule("later")];
    const resolved = plan(["a", "b"], rules, { a: ["disabled"], b: ["disabled"] });
    const result = await runResolvedCheck(
      resolved,
      dependencies({
        evaluate(_page, item) {
          return item.name === "fails"
            ? {
                facts: { elementsInspected: 0, violations: [] },
                failure: {
                  stage: "rule-evaluation",
                  code: "minimum-labels-unmet",
                  message: "minimum unmet",
                  target: null,
                  device: null,
                  rule: null,
                },
              }
            : cleanOutcome;
        },
      }),
      { toolVersion: "0.1.0" },
    );
    // collect-all: the second case runs and its failing rule fails too.
    expect(result.cases[0]?.rules.map((item) => item.status)).toEqual(["disabled", "failed", "not-executed"]);
    expect(result.cases[1]?.rules.map((item) => item.status)).toEqual(["disabled", "failed", "not-executed"]);
    expect(result.summary.ruleEvaluations).toEqual({
      clean: 0,
      violations: 0,
      failed: 2,
      disabled: 2,
      notExecuted: 2,
    });
  });

  test("preserves the resolved matrix on browser launch failure", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [rule("on"), rule("off")], { a: ["off"], b: ["off"] }),
      dependencies({
        launchFailure: {
          stage: "browser-setup",
          code: "browser-missing",
          message: "browser missing",
          target: null,
          device: null,
          rule: null,
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.cases.map((item) => item.status)).toEqual(["not-executed", "not-executed"]);
    expect(result.cases.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
      "not-executed",
      "disabled",
      "not-executed",
      "disabled",
    ]);
    expect(result.ruleFinalizations.every((item) => item.status === "not-executed")).toBe(true);
  });

  test("fails the first zero-label finalization in declaration order", async () => {
    const rules = [rule("empty-first"), rule("empty-later")];
    const result = await runResolvedCheck(
      plan(["a"], rules),
      dependencies({ evaluate: () => ({ facts: { elementsInspected: 0, violations: [] }, failure: null }) }),
      { toolVersion: "0.1.0" },
    );
    expect(result.cases[0]?.status).toBe("complete");
    expect(result.ruleFinalizations.map((item) => item.status)).toEqual(["failed", "not-executed"]);
    expect(firstFailure(result)).toMatchObject({ code: "zero-labels-global", target: null, rule: "empty-first" });
  });

  test.each([
    ["allow zero", plan(["a"], [rule("tabs", true)])],
    ["all disabled", plan(["a"], [rule("tabs")], { a: ["tabs"] })],
  ])("passes zero-label finalization for %s", async (_name, resolved) => {
    const result = await runResolvedCheck(
      resolved,
      dependencies({ evaluate: () => ({ facts: { elementsInspected: 0, violations: [] }, failure: null }) }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("clean");
    expect(result.ruleFinalizations).toEqual([
      { name: "tabs", status: "passed", elementsInspected: 0, failure: null },
    ]);
  });

  test("counts only enabled pairs while allowing disabled pairs", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [rule("tabs")], { b: ["tabs"] }),
      dependencies(),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("clean");
    expect(result.ruleFinalizations).toEqual([
      { name: "tabs", status: "passed", elementsInspected: 1, failure: null },
    ]);
  });

  test("marks a target cleanup failure and still completes the unfailed case", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [rule("tabs")]),
      dependencies({
        targetCloseFailure: {
          a: {
            stage: "browser-setup",
            code: "browser-cleanup-failed",
            message: "target cleanup failed",
            target: null,
            device: null,
            rule: null,
          },
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    // collect-all: the cleanup failure on case a does not stop case b.
    expect(result.cases.map((item) => item.status)).toEqual(["failed", "complete"]);
    expect(result.cases[0]?.rules[0]?.status).toBe("clean");
    expect(firstFailure(result)).toMatchObject({ target: "a", rule: null });
    expect(result.ruleFinalizations[0]?.status).toBe("not-executed");
  });

  test("retains complete facts when browser cleanup fails", async () => {
    const result = await runResolvedCheck(
      plan(["a"], [rule("tabs")]),
      dependencies({
        closeFailure: {
          stage: "browser-setup",
          code: "browser-cleanup-failed",
          message: "cleanup failed",
          target: null,
          device: null,
          rule: null,
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.cases[0]?.status).toBe("complete");
    expect(result.cases[0]?.rules[0]?.status).toBe("clean");
    // A run-wide cleanup failure does not gate finalization: the case completed.
    expect(result.ruleFinalizations[0]?.status).toBe("passed");
    expect(firstFailure(result)).toMatchObject({ code: "browser-cleanup-failed", target: null, rule: null });
  });

  test("preserves both a rule failure and a cleanup failure on the same case", async () => {
    const result = await runResolvedCheck(
      plan(["a"], [rule("fails")]),
      dependencies({
        evaluate() {
          return {
            facts: { elementsInspected: 0, violations: [] },
            failure: {
              stage: "rule-evaluation",
              code: "rule-script-failed",
              message: "rule threw",
              target: null,
              device: null,
              rule: null,
            },
          };
        },
        targetCloseFailure: {
          a: {
            stage: "browser-setup",
            code: "browser-cleanup-failed",
            message: "context close failed",
            target: null,
            device: null,
            rule: null,
          },
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.cases[0]?.status).toBe("failed");
    // Both failures coexist losslessly on their respective fields.
    expect(result.cases[0]?.rules[0]?.status).toBe("failed");
    expect(result.cases[0]?.rules[0]?.failure).toMatchObject({ code: "rule-script-failed", target: "a", rule: "fails" });
    expect(result.cases[0]?.failures).toContainEqual(expect.objectContaining({ code: "browser-cleanup-failed", target: "a" }));
    expect(result.ruleFinalizations[0]?.status).toBe("not-executed");
  });

  test("completes a single-case plan with one worker", async () => {
    const result = await runResolvedCheck(plan(["solo"], [rule("tabs")]), dependencies(), {
      toolVersion: "0.1.0",
    });
    expect(result.status).toBe("clean");
    expect(result.cases.map((item) => item.status)).toEqual(["complete"]);
    expect(result.summary.cases).toMatchObject({ resolved: 1, complete: 1 });
  });
});

describe("local rule finalization", () => {
  test("passes a local finalizer after every case completes", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [localRule("spacing")]),
      dependencies({
        finalize: async () => ({ name: "spacing", status: "passed", elementsInspected: 2, failure: null }),
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("clean");
    expect(result.ruleFinalizations).toEqual([
      { name: "spacing", status: "passed", elementsInspected: 2, failure: null },
    ]);
  });

  test("supplies target, device, status, inspected count, violations, and failure to the finalizer", async () => {
    let captured: LocalRuleFinalizationInput | undefined;
    const result = await runResolvedCheck(
      plan(["a"], [localRule("spacing")]),
      dependencies({
        evaluate: () => ({
          facts: {
            elementsInspected: 3,
            violations: [
              {
                type: "local",
                message: "dup spacing",
                locator: "#content",
                geometry: { x: 0, y: 0, width: 10, height: 10 },
                details: { gap: 8 },
              },
            ],
          },
          failure: null,
        }),
        finalize: async (rule, observations) => {
          captured = observations;
          return { name: rule.name, status: "passed", elementsInspected: 3, failure: null };
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("violations");
    expect(captured).toMatchObject({
      rule: { name: "spacing" },
      cases: [
        {
          target: { name: "a" },
          device: { name: "desktop" },
          status: "violations",
          elementsInspected: 3,
          violations: [{ message: "dup spacing", locator: "#content" }],
          failure: null,
        },
      ],
    });
  });

  test("records a returned finalizer failure and leaves later finalizers not-executed", async () => {
    const result = await runResolvedCheck(
      plan(["a"], [localRule("first"), localRule("second")]),
      dependencies({
        finalize: async (rule) =>
          rule.name === "first"
            ? {
                name: rule.name,
                status: "failed",
                elementsInspected: 1,
                failure: {
                  stage: "rule-evaluation",
                  code: "plugin-finalizer-invalid",
                  message: "aggregate contract failed",
                  target: null,
                  device: null,
                  rule: rule.name,
                },
              }
            : { name: rule.name, status: "passed", elementsInspected: 1, failure: null },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.ruleFinalizations.map((item) => item.status)).toEqual(["failed", "not-executed"]);
  });

  test("skips every run finalizer when any case is not complete", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [localRule("spacing")]),
      dependencies({
        openFailure: { b: navigationFailure },
        finalize: async () => {
          throw new Error("finalizer should not run");
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.ruleFinalizations.every((item) => item.status === "not-executed")).toBe(true);
  });

  test("keeps built-in zero-label finalization before and after local rules", async () => {
    const result = await runResolvedCheck(
      plan(["a"], [rule("tabs"), localRule("spacing"), rule("tabs-later")]),
      dependencies({
        evaluate: () => ({ facts: { elementsInspected: 0, violations: [] }, failure: null }),
        finalize: async (rule) => ({ name: rule.name, status: "passed", elementsInspected: 0, failure: null }),
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.ruleFinalizations.map((item) => [item.name, item.status])).toEqual([
      ["tabs", "failed"],
      ["spacing", "not-executed"],
      ["tabs-later", "not-executed"],
    ]);
  });

  test("coexists with observed violations and forces incomplete exit", async () => {
    const result = await runResolvedCheck(
      plan(["a"], [localRule("spacing")]),
      dependencies({
        evaluate: () => ({
          facts: {
            elementsInspected: 1,
            violations: [
              {
                type: "local",
                message: "spacing issue",
                locator: "#x",
                geometry: { x: 0, y: 0, width: 1, height: 1 },
                details: null,
              },
            ],
          },
          failure: null,
        }),
        finalize: async (rule) => ({
          name: rule.name,
          status: "failed",
          elementsInspected: 1,
          failure: {
            stage: "rule-evaluation",
            code: "plugin-finalizer-invalid",
            message: "aggregate failed",
            target: null,
            device: null,
            rule: rule.name,
          },
        }),
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.summary.violations).toBe(1);
    expect(exitCodeForResult(result)).toBe(2);
  });
});

describe("result schema v4 contracts", () => {
  test("local lifecycle failure codes produce incomplete v4 results", () => {
    const pluginFailure: Failure = {
      stage: "config",
      code: "plugin-contract-version-mismatch",
      message: "plugin contract version is not supported",
      target: null,
      device: null,
      rule: "spacing",
    };
    const result: RunResultV4 = {
      schemaVersion: 4,
      status: "incomplete",
      tool: { name: "vlint", version: "0.4.1" },
      environment: {
        platform: "linux",
        arch: "x64",
        browser: { name: "chromium", version: null },
      },
      summary: {
        targets: { resolved: 0 },
        cases: { resolved: 0, complete: 0, partial: 0, failed: 0, notExecuted: 0 },
        ruleEvaluations: { clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 },
        ruleFinalizations: { passed: 0, failed: 0, notExecuted: 0 },
        violations: 0,
        elementsInspected: 0,
        executionFailures: 1,
      },
      cases: [],
      ruleFinalizations: [],
      failures: [pluginFailure],
    };
    expect(isRunResultV4(result)).toBe(true);
    expect(exitCodeForResult(result)).toBe(2);
    expect(result.failures[0]?.code).toBe("plugin-contract-version-mismatch");
  });

  test("accepts local rule results and violations in the v4 contract", () => {
    const result: RunResultV4 = {
      schemaVersion: 4,
      status: "violations",
      tool: { name: "vlint", version: "0.4.1" },
      environment: {
        platform: "linux",
        arch: "x64",
        browser: { name: "chromium", version: "149.0.0.0" },
      },
      summary: {
        targets: { resolved: 1 },
        cases: { resolved: 1, complete: 1, partial: 0, failed: 0, notExecuted: 0 },
        ruleEvaluations: { clean: 0, violations: 1, failed: 0, disabled: 0, notExecuted: 0 },
        ruleFinalizations: { passed: 1, failed: 0, notExecuted: 0 },
        violations: 1,
        elementsInspected: 1,
        executionFailures: 0,
      },
      cases: [
        {
          target: { name: "settings", url: "https://example.com/settings" },
          device: {
            name: "desk",
            viewport: { width: 1280, height: 720 },
            screen: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            userAgent: null,
          },
          locale: "en-US",
          timezoneId: "UTC",
          status: "complete",
          rules: [
            {
              name: "spacing",
              type: "local",
              status: "violations",
              elementsInspected: 1,
              violations: [
                {
                  type: "local",
                  message: "duplicate horizontal spacing",
                  locator: "#content",
                  geometry: { x: 0, y: 0, width: 100, height: 20 },
                  details: { shellGap: 16, contentGap: 8 },
                },
              ],
              failure: null,
            },
          ],
          failures: [],
        },
      ],
      ruleFinalizations: [{ name: "spacing", status: "passed", elementsInspected: 1, failure: null }],
      failures: [],
    };
    expect(result.cases[0]?.rules[0]?.type).toBe("local");
    expect(result.cases[0]?.rules[0]?.violations[0]?.type).toBe("local");
  });
});
