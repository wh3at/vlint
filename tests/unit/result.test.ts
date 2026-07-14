import { describe, expect, test } from "bun:test";
import type {
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  ResolvedCheckPlan,
} from "../../src/contracts/config";
import type { RuleEvaluationOutcome } from "../../src/contracts/evaluation";
import { boundaryFailure, boundarySuccess, type Failure } from "../../src/contracts/failure";
import {
  exitCodeForResult,
  type CheckDependencies,
  runResolvedCheck,
} from "../../src/run/orchestrator";

const cleanOutcome: RuleEvaluationOutcome = {
  facts: { labelsInspected: 1, violations: [] },
  failure: null,
};

function rule(name: string, allowZeroLabels = false): EffectiveRule {
  return {
    name,
    type: "tab-label-single-line",
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

function plan(targetNames: readonly string[], rules: readonly EffectiveRule[], disabled: Readonly<Record<string, readonly string[]>> = {}): ResolvedCheckPlan {
  return {
    rules,
    targets: targetNames.map((name) => target(name, rules, disabled[name] ?? [])),
  };
}

interface DependencyOptions {
  readonly evaluate?: (page: string, rule: EffectiveRuleForTarget) => RuleEvaluationOutcome;
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
        async openTarget(item) {
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
  };
}

const navigationFailure: Failure = {
  stage: "navigation",
  code: "navigation-network",
  message: "navigation failed",
  target: null,
  rule: null,
};

describe("orchestrator result model", () => {
  test("completes every target and rule for a clean run", async () => {
    const result = await runResolvedCheck(plan(["a", "b"], [rule("tabs")]), dependencies(), {
      toolVersion: "0.1.0",
    });
    expect(result.status).toBe("clean");
    expect(exitCodeForResult(result)).toBe(0);
    expect(result.targets.map((item) => item.status)).toEqual(["complete", "complete"]);
    expect(result.summary).toMatchObject({
      targets: { resolved: 2, complete: 2, partial: 0, failed: 0, notExecuted: 0 },
      ruleEvaluations: { clean: 2, violations: 0, failed: 0, disabled: 0, notExecuted: 0 },
      violations: 0,
      matchedElements: 2,
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
              labelsInspected: 1,
              violations: [
                {
                  text: `${page}:${item.name}`,
                  lineCount: 2,
                  geometry: { x: 0, y: 0, width: 1, height: 2 },
                  locator: `#${page}-${item.name}`,
                },
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
    expect(result.targets.flatMap((item) => item.rules.flatMap((entry) => entry.violations.map((violation) => violation.text)))).toEqual([
      "a:first",
      "a:second",
      "b:first",
      "b:second",
    ]);
  });

  test("retains earlier violations and fail-fasts on target precondition failure", async () => {
    const result = await runResolvedCheck(
      plan(["first", "broken", "later"], [rule("tabs")]),
      dependencies({
        openFailure: { broken: navigationFailure },
        evaluate(page) {
          return page === "first"
            ? {
                facts: {
                  labelsInspected: 1,
                  violations: [
                    {
                      text: "wrapped",
                      lineCount: 2,
                      geometry: { x: 0, y: 0, width: 1, height: 2 },
                      locator: "#wrapped",
                    },
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
    expect(result.targets.map((item) => item.status)).toEqual(["complete", "failed", "not-executed"]);
    expect(result.targets[0]?.rules[0]?.violations).toHaveLength(1);
    expect(result.targets[1]?.rules[0]?.status).toBe("not-executed");
    expect(result.failure).toMatchObject({ target: "broken", rule: null });
  });

  test("keeps evaluator facts and marks only mixed attempted/not-executed targets partial", async () => {
    const rules = [rule("first"), rule("fails"), rule("later")];
    const result = await runResolvedCheck(
      plan(["a", "b"], rules),
      dependencies({
        evaluate(_page, item) {
          if (item.name !== "fails") return cleanOutcome;
          return {
            facts: {
              labelsInspected: 2,
              violations: [
                {
                  text: "observed-before-failure",
                  lineCount: 2,
                  geometry: { x: 1, y: 1, width: 2, height: 2 },
                  locator: "#partial",
                },
              ],
            },
            failure: {
              stage: "rule-evaluation",
              code: "rule-script-failed",
              message: "measurement failed",
              target: null,
              rule: null,
            },
          };
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.targets.map((item) => item.status)).toEqual(["partial", "not-executed"]);
    expect(result.targets[0]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(result.targets[0]?.rules[1]).toMatchObject({ labelsInspected: 2, violations: [{ text: "observed-before-failure" }] });
    expect(result.failure).toMatchObject({ target: "a", rule: "fails" });
  });

  test("keeps disabled pairs distinct from fail-fast pairs", async () => {
    const rules = [rule("disabled"), rule("fails"), rule("later")];
    const resolved = plan(["a", "b"], rules, { a: ["disabled"], b: ["disabled"] });
    const result = await runResolvedCheck(
      resolved,
      dependencies({
        evaluate(_page, item) {
          return item.name === "fails"
            ? {
                facts: { labelsInspected: 0, violations: [] },
                failure: {
                  stage: "rule-evaluation",
                  code: "minimum-labels-unmet",
                  message: "minimum unmet",
                  target: null,
                  rule: null,
                },
              }
            : cleanOutcome;
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.targets[0]?.rules.map((item) => item.status)).toEqual(["disabled", "failed", "not-executed"]);
    expect(result.targets[1]?.rules.map((item) => item.status)).toEqual(["disabled", "not-executed", "not-executed"]);
    expect(result.summary.ruleEvaluations).toEqual({
      clean: 0,
      violations: 0,
      failed: 1,
      disabled: 2,
      notExecuted: 3,
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
          rule: null,
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.targets.map((item) => item.status)).toEqual(["not-executed", "not-executed"]);
    expect(result.targets.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
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
      dependencies({ evaluate: () => ({ facts: { labelsInspected: 0, violations: [] }, failure: null }) }),
      { toolVersion: "0.1.0" },
    );
    expect(result.targets[0]?.status).toBe("complete");
    expect(result.ruleFinalizations.map((item) => item.status)).toEqual(["failed", "not-executed"]);
    expect(result.failure).toMatchObject({ code: "zero-labels-global", target: null, rule: "empty-first" });
  });

  test.each([
    ["allow zero", plan(["a"], [rule("tabs", true)])],
    ["all disabled", plan(["a"], [rule("tabs")], { a: ["tabs"] })],
  ])("passes zero-label finalization for %s", async (_name, resolved) => {
    const result = await runResolvedCheck(
      resolved,
      dependencies({ evaluate: () => ({ facts: { labelsInspected: 0, violations: [] }, failure: null }) }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("clean");
    expect(result.ruleFinalizations).toEqual([
      { name: "tabs", status: "passed", labelsInspected: 0, failure: null },
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
      { name: "tabs", status: "passed", labelsInspected: 1, failure: null },
    ]);
  });

  test("marks target cleanup failure without discarding completed rule facts", async () => {
    const result = await runResolvedCheck(
      plan(["a", "b"], [rule("tabs")]),
      dependencies({
        targetCloseFailure: {
          a: {
            stage: "browser-setup",
            code: "browser-cleanup-failed",
            message: "target cleanup failed",
            target: null,
            rule: null,
          },
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.targets.map((item) => item.status)).toEqual(["failed", "not-executed"]);
    expect(result.targets[0]?.rules[0]?.status).toBe("clean");
    expect(result.failure).toMatchObject({ target: "a", rule: null });
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
          rule: null,
        },
      }),
      { toolVersion: "0.1.0" },
    );
    expect(result.status).toBe("incomplete");
    expect(result.targets[0]?.status).toBe("complete");
    expect(result.targets[0]?.rules[0]?.status).toBe("clean");
    expect(result.ruleFinalizations[0]?.status).toBe("passed");
    expect(result.failure).toMatchObject({ code: "browser-cleanup-failed", target: null, rule: null });
  });
});
