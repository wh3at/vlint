import { describe, expect, test } from "bun:test";
import type {
  EffectiveAuditCase,
  EffectiveRule,
  EffectiveRuleForTarget,
  EffectiveTarget,
  ResolvedCheckPlan,
} from "../../src/contracts/config";
import type { RuleEvaluationOutcome } from "../../src/contracts/evaluation";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../../src/contracts/failure";
import type { RunResultV2 } from "../../src/contracts/result";
import {
  exitCodeForResult,
  runResolvedCheck,
  type CheckDependencies,
} from "../../src/run/orchestrator";

/** Result-transition matrix for the case-based schema v2 orchestrator. */

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

function auditCase(item: EffectiveTarget): EffectiveAuditCase {
  return {
    name: item.name,
    url: item.url,
    deviceName: "desktop",
    viewport: item.viewport,
    screen: item.viewport,
    deviceScaleFactor: item.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    locale: item.locale,
    timezoneId: item.timezoneId,
    timeoutMs: item.timeoutMs,
    browserState: item.browserState,
    readyCondition: item.readyCondition,
    rules: item.rules,
  };
}

function plan(
  targetNames: readonly string[],
  rules: readonly EffectiveRule[],
  disabled: Readonly<Record<string, readonly string[]>> = {},
): ResolvedCheckPlan {
  const targets = targetNames.map((name) => target(name, rules, disabled[name] ?? []));
  return { rules, targets, cases: targets.map(auditCase) };
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
    failure: { stage, code, message: `${code}`, target: null, device: null, rule: null },
  };
}

interface DepOptions {
  readonly evaluate?: (page: string, rule: EffectiveRuleForTarget) => RuleEvaluationOutcome;
  readonly openFailure?: Readonly<Record<string, Failure>>;
  readonly targetCloseFailure?: Readonly<Record<string, Failure>>;
  readonly launchFailure?: Failure;
  readonly closeFailure?: Failure;
}

function dependencies(options: DepOptions = {}): CheckDependencies<string> {
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
              const targetClose = options.targetCloseFailure?.[item.name];
              return targetClose === undefined ? boundarySuccess(undefined) : boundaryFailure(targetClose);
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

async function run(
  resolved: ResolvedCheckPlan,
  options: DepOptions = {},
): Promise<RunResultV2> {
  return runResolvedCheck(resolved, dependencies(options), { toolVersion: "0.1.0" });
}

function allFailures(result: RunResultV2): readonly Failure[] {
  return [
    ...result.failures,
    ...result.cases.flatMap((item) => item.failures),
    ...result.cases.flatMap((item) => item.rules.flatMap((entry) => entry.failure === null ? [] : [entry.failure])),
    ...result.ruleFinalizations.flatMap((item) => item.failure === null ? [] : [item.failure]),
  ];
}

/** The summary must always reconcile with the underlying facts and status. */
function reconcile(result: RunResultV2, resolved: ResolvedCheckPlan): void {
  expect(result.summary.targets.resolved).toBe(resolved.targets.length);

  const cases = result.summary.cases;
  expect(cases.resolved).toBe(resolved.cases.length);
  expect(cases.complete + cases.partial + cases.failed + cases.notExecuted).toBe(cases.resolved);

  const totalPairs = resolved.cases.reduce((count, item) => count + item.rules.length, 0);
  const evaluations = result.summary.ruleEvaluations;
  expect(
    evaluations.clean + evaluations.violations + evaluations.failed + evaluations.disabled + evaluations.notExecuted,
  ).toBe(totalPairs);

  const violationTotal = result.cases.reduce(
    (count, item) => count + item.rules.reduce((inner, entry) => inner + entry.violations.length, 0),
    0,
  );
  expect(result.summary.violations).toBe(violationTotal);

  const matchedTotal = result.cases.reduce(
    (count, item) => count + item.rules.reduce((inner, entry) => inner + entry.labelsInspected, 0),
    0,
  );
  expect(result.summary.matchedElements).toBe(matchedTotal);

  const finalizations = result.summary.ruleFinalizations;
  expect(finalizations.passed + finalizations.failed + finalizations.notExecuted).toBe(resolved.rules.length);

  const failures = allFailures(result);
  expect(result.summary.executionFailures).toBe(failures.length);
  if (failures.length > 0) {
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
  device: null,
  rule: null,
};

describe("result-transition matrix reconciles and maps exit codes", () => {
  test("all-clean run reconciles to exit 0", async () => {
    const resolved = plan(["a", "b"], [rule("tabs")]);
    const result = await run(resolved);
    reconcile(result, resolved);
    expect(result.status).toBe("clean");
    expect(result.cases.map((item) => item.status)).toEqual(["complete", "complete"]);
  });

  test("collect-all violations in case-major then rule-major order", async () => {
    const rules = [rule("first"), rule("second")];
    const resolved = plan(["a", "b"], rules);
    const result = await run(resolved, { evaluate: (page, item) => violationOutcome(page, item.name) });
    reconcile(result, resolved);
    expect(result.status).toBe("violations");
    expect(
      result.cases.flatMap((item) => item.rules.flatMap((entry) => entry.violations.map((v) => v.text))),
    ).toEqual(["a:first", "a:second", "b:first", "b:second"]);
  });

  test("navigation precondition failure collects the unfailed cases", async () => {
    const resolved = plan(["first", "broken", "later"], [rule("tabs")]);
    const result = await run(resolved, {
      openFailure: { broken: navFailure },
      evaluate: (page) => (page === "first" ? violationOutcome(page, "tabs") : cleanOutcome),
    });
    reconcile(result, resolved);
    expect(result.status).toBe("incomplete");
    // collect-all: the failing case does not stop the unstarted later case.
    expect(result.cases.map((item) => item.status)).toEqual(["complete", "failed", "complete"]);
    expect(result.cases[0]?.rules[0]?.violations).toHaveLength(1);
    expect(result.cases[1]?.rules[0]?.status).toBe("not-executed");
    expect(result.cases[2]?.rules[0]?.status).toBe("clean");
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "broken", device: "desktop", rule: null }));
  });

  test("pair failure after facts marks the case partial and stops later rules in that case", async () => {
    const rules = [rule("ok"), rule("fails"), rule("later")];
    const resolved = plan(["a", "b"], rules);
    const result = await run(resolved, {
      evaluate: (_page, item) =>
        item.name === "fails" ? failureOutcome("rule-evaluation", "rule-script-failed") : cleanOutcome,
    });
    reconcile(result, resolved);
    // collect-all: both cases run; the failing rule makes each case partial.
    expect(result.cases.map((item) => item.status)).toEqual(["partial", "partial"]);
    expect(result.cases[0]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(result.cases[1]?.rules.map((item) => item.status)).toEqual(["clean", "failed", "not-executed"]);
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "a", device: "desktop", rule: "fails" }));
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
    expect(result.cases.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
      "disabled",
      "clean",
      "disabled",
      "clean",
    ]);
    expect(evaluations).toBe(2);
  });

  test("first zero-label finalization fails in declaration order; later finalizations not-executed", async () => {
    const rules = [rule("empty-first"), rule("empty-later")];
    const resolved = plan(["a"], rules);
    const result = await run(resolved, {
      evaluate: () => ({ facts: { labelsInspected: 0, violations: [] }, failure: null }),
    });
    reconcile(result, resolved);
    expect(result.cases[0]?.status).toBe("complete");
    expect(result.ruleFinalizations.map((item) => item.status)).toEqual(["failed", "not-executed"]);
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ code: "zero-labels-global", rule: "empty-first" }));
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
        device: null,
        rule: null,
      },
    });
    reconcile(result, resolved);
    expect(result.cases.map((item) => item.status)).toEqual(["not-executed", "not-executed"]);
    expect(result.cases.flatMap((item) => item.rules.map((entry) => entry.status))).toEqual([
      "not-executed",
      "disabled",
      "not-executed",
      "disabled",
    ]);
    expect(result.ruleFinalizations.every((item) => item.status === "not-executed")).toBe(true);
  });
});

describe("combination transitions", () => {
  test("violations + disabled pair + navigation failure in one run (collect-all)", async () => {
    const rules = [rule("report"), rule("silent"), rule("after")];
    const resolved = plan(["good", "down"], rules, { good: ["silent"], down: ["silent"] });
    const result = await run(resolved, {
      openFailure: { down: navFailure },
      evaluate: (page, item) =>
        item.name === "report" ? violationOutcome(page, item.name) : cleanOutcome,
    });
    reconcile(result, resolved);
    expect(result.status).toBe("incomplete");
    expect(result.cases[0]?.rules[0]?.violations[0]?.text).toBe("good:report");
    expect(result.cases[0]?.rules.map((item) => item.status)).toEqual([
      "violations",
      "disabled",
      "clean",
    ]);
    expect(result.cases[1]?.status).toBe("failed");
    expect(result.cases[1]?.rules.map((item) => item.status)).toEqual([
      "not-executed",
      "disabled",
      "not-executed",
    ]);
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "down", device: "desktop", rule: null }));
  });

  test("disabled rule before a failing rule keeps disabled distinct from not-executed", async () => {
    const rules = [rule("skip"), rule("fails"), rule("tail")];
    const resolved = plan(["a"], rules, { a: ["skip"] });
    const result = await run(resolved, {
      evaluate: (_page, item) =>
        item.name === "fails" ? failureOutcome("rule-evaluation", "geometry-evaluation-failed") : cleanOutcome,
    });
    reconcile(result, resolved);
    expect(result.cases[0]?.rules.map((item) => item.status)).toEqual([
      "disabled",
      "failed",
      "not-executed",
    ]);
    expect(result.cases[0]?.status).toBe("partial");
    expect(result.summary.ruleEvaluations).toEqual({
      clean: 0,
      violations: 0,
      failed: 1,
      disabled: 1,
      notExecuted: 1,
    });
  });

  test("simultaneous navigation, rule, and cleanup failures complete the unfailed cases", async () => {
    const resolved = plan(["nav", "rulef", "cleanf", "ok"], [rule("fails"), rule("later")]);
    const result = await run(resolved, {
      openFailure: { nav: navFailure },
      targetCloseFailure: {
        cleanf: {
          stage: "browser-setup",
          code: "browser-cleanup-failed",
          message: "context close failed",
          target: null,
          device: null,
          rule: null,
        },
      },
      evaluate: (page, item) =>
        item.name === "fails" && page === "rulef"
          ? failureOutcome("rule-evaluation", "rule-script-failed")
          : cleanOutcome,
    });
    // collect-all: each failure type lands on its own case; the unfailed case still completes.
    reconcile(result, resolved);
    expect(result.status).toBe("incomplete");
    expect(result.cases.map((item) => item.status)).toEqual(["failed", "partial", "failed", "complete"]);
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "nav", code: "navigation-network" }));
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "rulef", rule: "fails" }));
    expect(allFailures(result)).toContainEqual(expect.objectContaining({ target: "cleanf", code: "browser-cleanup-failed" }));
    expect(result.ruleFinalizations.every((item) => item.status === "not-executed")).toBe(true);
  });
});

/**
 * Concurrency harness for the bounded collect-all scheduler. Each case opens a
 * scope instantly and then blocks its first rule evaluation on a per-case gate,
 * so the test can drive dispatch order, observe the active-count cap, and abort
 * active cases — all deterministically, without wall-clock timers.
 */
interface HarnessOptions {
  readonly evaluateOutcome?: (page: string) => RuleEvaluationOutcome;
  readonly openFailure?: Readonly<Record<string, Failure>>;
  readonly targetCloseFailure?: Readonly<Record<string, Failure>>;
  readonly closeFailure?: Failure;
  readonly launchFailure?: Failure;
}

interface CaseSignals {
  readonly evaluateGate: { promise: Promise<void>; resolve: () => void };
  readonly opened: { promise: Promise<void>; resolve: () => void };
  readonly closed: { promise: Promise<void>; resolve: () => void };
}

function concurrencyHarness(options: HarnessOptions = {}) {
  let active = 0;
  let maxActive = 0;
  const openedLog: string[] = [];
  const closedLog: string[] = [];
  const states = new Map<string, CaseSignals>();

  function signalsFor(name: string): CaseSignals {
    let s = states.get(name);
    if (s === undefined) {
      s = {
        evaluateGate: Promise.withResolvers<void>(),
        opened: Promise.withResolvers<void>(),
        closed: Promise.withResolvers<void>(),
      };
      states.set(name, s);
    }
    return s;
  }

  const deps: CheckDependencies<string> = {
    async launch() {
      if (options.launchFailure !== undefined) return boundaryFailure(options.launchFailure);
      return boundarySuccess({
        browserVersion: "149.0.7827.55",
        async openCase(item, signal): Promise<BoundaryResult<{ page: string; close(): Promise<BoundaryResult<void>> }>> {
          if (signal?.aborted) {
            return boundaryFailure({
              stage: "interrupt",
              code: "signal-interrupt",
              message: "operation cancelled",
              target: null,
              device: null,
              rule: null,
            });
          }
          const openFailure = options.openFailure?.[item.name];
          if (openFailure !== undefined) return boundaryFailure(openFailure);
          active += 1;
          if (active > maxActive) maxActive = active;
          const s = signalsFor(item.name);
          openedLog.push(item.name);
          s.opened.resolve();
          return boundarySuccess({
            page: item.name,
            close: async () => {
              active -= 1;
              closedLog.push(item.name);
              s.closed.resolve();
              const cf = options.targetCloseFailure?.[item.name];
              return cf === undefined ? boundarySuccess(undefined) : boundaryFailure(cf);
            },
          });
        },
        async close() {
          return options.closeFailure === undefined ? boundarySuccess(undefined) : boundaryFailure(options.closeFailure);
        },
      });
    },
    async evaluate(page, _item, signal) {
      const s = signalsFor(page);
      const interruptOutcome: RuleEvaluationOutcome = {
        facts: { labelsInspected: 0, violations: [] },
        failure: {
          stage: "interrupt",
          code: "signal-interrupt",
          message: "operation cancelled",
          target: null,
          device: null,
          rule: null,
        },
      };
      if (signal?.aborted) return interruptOutcome;
      const aborted = Promise.withResolvers<void>();
      if (signal !== undefined) {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      }
      await Promise.race([s.evaluateGate.promise, aborted.promise]);
      if (signal?.aborted) return interruptOutcome;
      return options.evaluateOutcome?.(page) ?? cleanOutcome;
    },
  };

  return {
    deps,
    active: () => active,
    maxActive: () => maxActive,
    openedLog: () => [...openedLog],
    closedLog: () => [...closedLog],
    opened: (name: string) => signalsFor(name).opened.promise,
    closed: (name: string) => signalsFor(name).closed.promise,
    release: (name: string) => signalsFor(name).evaluateGate.resolve(),
  };
}

describe("bounded collect-all orchestration", () => {
  test("active cases never exceed two across four cases", async () => {
    const resolved = plan(["c0", "c1", "c2", "c3"], [rule("tabs")]);
    const h = concurrencyHarness();
    const runP = runResolvedCheck(resolved, h.deps, { toolVersion: "0.1.0" });
    // Wait until the first two scopes are open and blocked in evaluation.
    await Promise.all([h.opened("c0"), h.opened("c1")]);
    expect(h.active()).toBe(2);
    // Releasing every gate lets the pool drain without ever exceeding the cap.
    for (const name of ["c0", "c1", "c2", "c3"]) h.release(name);
    const result = await runP;
    expect(h.maxActive()).toBe(2);
    expect(result.cases.map((item) => item.target.name)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(result.cases.every((item) => item.status === "complete")).toBe(true);
    expect(result.status).toBe("clean");
  });

  test("four cases completing out of declared order still emit declared order", async () => {
    const resolved = plan(["c0", "c1", "c2", "c3"], [rule("tabs")]);
    const h = concurrencyHarness();
    const runP = runResolvedCheck(resolved, h.deps, { toolVersion: "0.1.0" });
    await Promise.all([h.opened("c0"), h.opened("c1")]);
    // Drive completion in reverse-pair order; await each close before the next release.
    h.release("c1");
    await h.closed("c1");
    h.release("c0");
    await h.closed("c0");
    h.release("c3");
    await h.closed("c3");
    h.release("c2");
    await h.closed("c2");
    const result = await runP;
    // Completion order leaked nowhere: output stays in declared index order.
    expect(h.closedLog()).toEqual(["c1", "c0", "c3", "c2"]);
    expect(result.cases.map((item) => item.target.name)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(result.status).toBe("clean");
  });

  test("a single case uses one worker and never exceeds one active case", async () => {
    const resolved = plan(["solo"], [rule("tabs")]);
    const h = concurrencyHarness();
    const runP = runResolvedCheck(resolved, h.deps, { toolVersion: "0.1.0" });
    await h.opened("solo");
    expect(h.active()).toBe(1);
    h.release("solo");
    const result = await runP;
    expect(h.maxActive()).toBe(1);
    expect(result.cases.map((item) => item.status)).toEqual(["complete"]);
  });

  test("external interrupt stops new dispatch, closes active scopes, leaves unstarted not-executed", async () => {
    const resolved = plan(["c0", "c1", "c2", "c3"], [rule("tabs")]);
    const h = concurrencyHarness();
    const controller = new AbortController();
    const runP = runResolvedCheck(resolved, h.deps, {
      toolVersion: "0.1.0",
      signal: controller.signal,
    });
    await Promise.all([h.opened("c0"), h.opened("c1")]);
    // Exactly two cases started; the remaining two have not been dispatched.
    expect(h.openedLog()).toHaveLength(2);
    controller.abort();
    const result = await runP;
    reconcile(result, resolved);
    // Active scopes were closed; unstarted cases were never dispatched.
    expect(h.closedLog()).toHaveLength(2);
    expect(h.closedLog().sort()).toEqual(["c0", "c1"]);
    expect(result.cases.map((item) => item.status)).toEqual([
      "failed",
      "failed",
      "not-executed",
      "not-executed",
    ]);
    // Exactly one run-level interrupt failure; no case-level duplication.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("signal-interrupt");
    expect(result.cases.every((item) => item.failures.length === 0)).toBe(true);
    expect(result.status).toBe("incomplete");
  });

  test("a pre-aborted signal records one run interrupt and dispatches no cases", async () => {
    const resolved = plan(["c0", "c1"], [rule("tabs")]);
    const h = concurrencyHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await runResolvedCheck(resolved, h.deps, {
      toolVersion: "0.1.0",
      signal: controller.signal,
    });
    reconcile(result, resolved);
    expect(h.openedLog()).toHaveLength(0);
    expect(result.cases.map((item) => item.status)).toEqual(["not-executed", "not-executed"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe("signal-interrupt");
  });
});
