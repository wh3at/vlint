import { describe, expect, test } from "bun:test";
import type {
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  ResolvedCheckPlan,
} from "../../src/contracts/config";
import type { RuleEvaluationOutcome } from "../../src/contracts/evaluation";
import { boundaryFailure, boundarySuccess, type Failure } from "../../src/contracts/failure";
import type { RunResultV1 } from "../../src/contracts/result";
import {
  exitCodeForResult,
  runResolvedCheck,
  type CheckDependencies,
} from "../../src/run/orchestrator";

/**
 * Result-transition matrix (U7). The unit `result.test.ts` covers each
 * transition in isolation with hand-coded expectations. This file adds two
 * things on top:
 *
 *   1. A cross-cutting summary-reconciliation invariant — target/rule status
 *      counts always sum to their totals, violation/matched counts always equal
 *      the sum of the underlying facts, executionFailures mirrors failure
 *      presence, and status ↔ failure ↔ exit code are always coherent. Applied
 *      to every scenario, it catches counting drift a hand-coded expectation
 *      would miss.
 *   2. Combination scenarios that exercise ordering, fail-fast, disabled-pair,
 *      and zero-label transitions simultaneously in a single run.
 */

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

function target(
  name: string,
  rules: readonly EffectiveRule[],
  disabled: readonly string[] = [],
): EffectiveTarget {
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
    rules: rules.map((item) => ({ ...item, enabled: !disabled.includes(item.name) })),
  };
}

function plan(
  targetNames: readonly string[],
  rules: readonly EffectiveRule[],
  disabled: Readonly<Record<string, readonly string[]>> = {},
): ResolvedCheckPlan {
  return { rules, targets: targetNames.map((name) => target(name, rules, disabled[name] ?? [])) };
}

const cleanOutcome: RuleEvaluationOutcome = {
  facts: { labelsInspected: 1, violations: [] },
  failure: null,
};

function violationOutcome(page: string, ruleName: string): RuleEvaluationOutcome {
  return {
    facts: {
      labelsInspected: 1,
      violations: [
        {
          text: `${page}:${ruleName}`,
          lineCount: 2,
          geometry: { x: 0, y: 0, width: 1, height: 2 },
          locator: `#${page}-${ruleName}`,
        },
      ],
    },
    failure: null,
  };
}

function failureOutcome(stage: Failure["stage"], code: Failure["code"]): RuleEvaluationOutcome {
  return {
    facts: { labelsInspected: 2, violations: [] },
    failure: { stage, code, message: `${code}`, target: null, rule: null },
  };
}

interface DepOptions {
  readonly evaluate?: (page: string, rule: EffectiveRuleForTarget) => RuleEvaluationOutcome;
  readonly openFailure?: Readonly<Record<string, Failure>>;
  readonly launchFailure?: Failure;
}

function dependencies(options: DepOptions = {}): CheckDependencies<string> {
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
              return boundarySuccess(undefined);
            },
          });
        },
        async close() {
          return boundarySuccess(undefined);
        },
      });
    },
    async evaluate(page, item) {
      return options.evaluate?.(page, item) ?? cleanOutcome;
    },
  };
}

async function run(
  resolved: ResolvedCheckPlan,
  options: DepOptions = {},
): Promise<RunResultV1> {
  return runResolvedCheck(resolved, dependencies(options), { toolVersion: "0.1.0" });
}

/** The summary must always reconcile with the underlying facts and the status. */
function reconcile(result: RunResultV1, resolved: ResolvedCheckPlan): void {
  const targets = result.summary.targets;
  expect(targets.resolved).toBe(resolved.targets.length);
  expect(targets.complete + targets.partial + targets.failed + targets.notExecuted).toBe(targets.resolved);

  const totalPairs = resolved.targets.reduce((count, item) => count + item.rules.length, 0);
  const evaluations = result.summary.ruleEvaluations;
  expect(
    evaluations.clean + evaluations.violations + evaluations.failed + evaluations.disabled + evaluations.notExecuted,
  ).toBe(totalPairs);

  const violationTotal = result.targets.reduce(
    (count, item) => count + item.rules.reduce((inner, rule) => inner + rule.violations.length, 0),
    0,
  );
  expect(result.summary.violations).toBe(violationTotal);

  const matchedTotal = result.targets.reduce(
    (count, item) => count + item.rules.reduce((inner, rule) => inner + rule.labelsInspected, 0),
    0,
  );
  expect(result.summary.matchedElements).toBe(matchedTotal);

  const finalizations = result.summary.ruleFinalizations;
  expect(finalizations.passed + finalizations.failed + finalizations.notExecuted).toBe(resolved.rules.length);

  expect(result.summary.executionFailures).toBe(result.failure === null ? 0 : 1);

  if (result.failure !== null) {
    expect(result.status).toBe("incomplete");
  } else if (result.summary.violations > 0) {
    expect(result.status).toBe("violations");
  } else {
    expect(result.status).toBe("clean");
  }
  expect(exitCodeForResult(result)).toBe(
    result.status === "incomplete" ? 2 : result.status === "violations" ? 1 : 0,
  );
}

const navFailure: Failure = {
  stage: "navigation",
  code: "navigation-network",
  message: "navigation failed",
  target: null,
  rule: null,
};

describe("result-transition matrix reconciles and maps exit codes", () => {
  test("all-clean run reconciles to exit 0", async () => {
    const resolved = plan(["a", "b"], [rule("tabs")]);
    const result = await run(resolved);
    reconcile(result, resolved);
    expect(result.status).toBe("clean");
    expect(result.targets.map((item) => item.status)).toEqual(["complete", "complete"]);
  });

  test("collect-all violations in target-major then rule-major order", async () => {
    const rules = [rule("first"), rule("second")];
    const resolved = plan(["a", "b"], rules);
    const result = await run(resolved, { evaluate: (page, item) => violationOutcome(page, item.name) });
    reconcile(result, resolved);
    expect(result.status).toBe("violations");
    expect(
      result.targets.flatMap((item) => item.rules.flatMap((entry) => entry.violations.map((v) => v.text))),
    ).toEqual(["a:first", "a:second", "b:first", "b:second"]);
  });

  test("navigation/setup fail-fast retains prior facts and leaves later targets not-executed", async () => {
    const resolved = plan(["first", "broken", "later"], [rule("tabs")]);
    const result = await run(resolved, {
      openFailure: { broken: navFailure },
      evaluate: (page) => (page === "first" ? violationOutcome(page, "tabs") : cleanOutcome),
    });
    reconcile(result, resolved);
    expect(result.status).toBe("incomplete");
    expect(result.targets.map((item) => item.status)).toEqual(["complete", "failed", "not-executed"]);
    expect(result.targets[0]?.rules[0]?.violations).toHaveLength(1);
    expect(result.targets[2]?.rules[0]?.status).toBe("not-executed");
    expect(result.failure).toMatchObject({ target: "broken", rule: null });
  });

  test("pair failure after facts marks the target partial and stops later rules", async () => {
    const rules = [rule("ok"), rule("fails"), rule("later")];
    const resolved = plan(["a", "b"], rules);
    const result = await run(resolved, {
      evaluate: (_page, item) =>
        item.name === "fails" ? failureOutcome("rule-evaluation", "rule-script-failed") : cleanOutcome,
    });
    reconcile(result, resolved);
    expect(result.targets.map((item) => item.status)).toEqual(["partial", "not-executed"]);
    expect(result.targets[0]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(result.targets[0]?.rules[1]?.labelsInspected).toBe(2);
    expect(result.failure).toMatchObject({ target: "a", rule: "fails" });
  });

  test("explicit disabled pairs stay disabled and are never evaluated", async () => {
    const rules = [rule("disabled"), rule("active")];
    const resolved = plan(["a", "b"], rules, { a: ["disabled"], b: ["disabled"] });
    let evaluations = 0;
    const result = await run(resolved, {
      evaluate: () => {
        evaluations += 1;
        return cleanOutcome;
      },
    });
    reconcile(result, resolved);
    expect(result.targets.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
      "disabled",
      "clean",
      "disabled",
      "clean",
    ]);
    // Only the two enabled pairs were evaluated.
    expect(evaluations).toBe(2);
  });

  test("first zero-label finalization fails in declaration order; later finalizations not-executed", async () => {
    const rules = [rule("empty-first"), rule("empty-later")];
    const resolved = plan(["a"], rules);
    const result = await run(resolved, {
      evaluate: () => ({ facts: { labelsInspected: 0, violations: [] }, failure: null }),
    });
    reconcile(result, resolved);
    expect(result.targets[0]?.status).toBe("complete");
    expect(result.ruleFinalizations.map((item) => item.status)).toEqual(["failed", "not-executed"]);
    expect(result.failure).toMatchObject({ code: "zero-labels-global", rule: "empty-first" });
  });

  test("browser launch failure preserves the seeded matrix at not-executed", async () => {
    const rules = [rule("on"), rule("off")];
    const resolved = plan(["a", "b"], rules, { a: ["off"], b: ["off"] });
    const result = await run(resolved, {
      launchFailure: {
        stage: "browser-setup",
        code: "browser-missing",
        message: "browser missing",
        target: null,
        rule: null,
      },
    });
    reconcile(result, resolved);
    expect(result.targets.map((item) => item.status)).toEqual(["not-executed", "not-executed"]);
    expect(result.targets.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
      "not-executed",
      "disabled",
      "not-executed",
      "disabled",
    ]);
    expect(result.ruleFinalizations.every((item) => item.status === "not-executed")).toBe(true);
  });
});

describe("combination transitions", () => {
  test("violations + disabled pair + navigation fail-fast in one run", async () => {
    const rules = [rule("report"), rule("silent"), rule("after")];
    // Target "good" evaluates report (violation) and silent (disabled); "down" never opens.
    const resolved = plan(["good", "down"], rules, { good: ["silent"], down: ["silent"] });
    const result = await run(resolved, {
      openFailure: { down: navFailure },
      evaluate: (page, item) =>
        item.name === "report" ? violationOutcome(page, item.name) : cleanOutcome,
    });
    reconcile(result, resolved);
    expect(result.status).toBe("incomplete");
    // Prior violation fact is retained across the fail-fast boundary.
    expect(result.targets[0]?.rules[0]?.violations[0]?.text).toBe("good:report");
    expect(result.targets[0]?.rules.map((item) => item.status)).toEqual([
      "violations",
      "disabled",
      "clean",
    ]);
    // The failed target and everything after stays not-executed; silent stays disabled.
    expect(result.targets[1]?.status).toBe("failed");
    expect(result.targets[1]?.rules.map((item) => item.status)).toEqual([
      "not-executed",
      "disabled",
      "not-executed",
    ]);
    expect(result.failure).toMatchObject({ target: "down", rule: null });
  });

  test("disabled rule before a failing rule keeps disabled distinct from not-executed", async () => {
    const rules = [rule("skip"), rule("fails"), rule("tail")];
    const resolved = plan(["a"], rules, { a: ["skip"] });
    const result = await run(resolved, {
      evaluate: (_page, item) =>
        item.name === "fails" ? failureOutcome("rule-evaluation", "geometry-evaluation-failed") : cleanOutcome,
    });
    reconcile(result, resolved);
    expect(result.targets[0]?.rules.map((item) => item.status)).toEqual([
      "disabled",
      "failed",
      "not-executed",
    ]);
    expect(result.targets[0]?.status).toBe("partial");
    expect(result.summary.ruleEvaluations).toEqual({
      clean: 0,
      violations: 0,
      failed: 1,
      disabled: 1,
      notExecuted: 1,
    });
  });
});
