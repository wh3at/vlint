import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EffectiveLocalRule } from "../../src/contracts/config";
import type { FailureCode } from "../../src/contracts/failure";
import { loadPluginContract } from "../../src/plugins/load";
import {
  buildLocalRuleObservations,
  finalizeLocalRule,
  MAX_FINALIZATION_OBSERVATION_BYTES,
  MAX_FINALIZATION_OBSERVATIONS,
} from "../../src/plugins/finalize";

const fixtureRoot = join(import.meta.dir, "../fixtures/plugins");

function localRule(name: string, path: string): EffectiveLocalRule {
  return { name, type: "local", enabled: true, path, settings: {} };
}

function makePlan(targetNames: readonly string[], rules: readonly EffectiveLocalRule[]) {
  const targets = targetNames.map((name) => ({
    name,
    url: `https://example.com/${name}`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    timeoutMs: 30_000,
    browserState: null,
    readyCondition: null,
    rules: rules.map((item) => ({ ...item })),
  }));
  const cases = targets.map((target) => ({
    name: target.name,
    url: target.url,
    deviceName: "desktop",
    viewport: target.viewport,
    screen: target.viewport,
    deviceScaleFactor: target.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
    userAgent: null,
    locale: target.locale,
    timezoneId: target.timezoneId,
    timeoutMs: target.timeoutMs,
    browserState: target.browserState,
    readyCondition: target.readyCondition,
    rules: target.rules,
  }));
  return { rules, targets, cases };
}

function seededCases(plan: ReturnType<typeof makePlan>) {
  return plan.cases.map((auditCase) => ({
    target: { name: auditCase.name, url: auditCase.url },
    device: { name: auditCase.deviceName },
    status: "complete" as const,
    rules: auditCase.rules.map((rule) => ({
      name: rule.name,
      type: rule.type,
      status: "clean" as const,
      elementsInspected: 1,
      violations: [] as const,
      failure: null,
    })),
    failures: [],
  }));
}

function observationByteLength(
  rule: EffectiveLocalRule,
  plan: ReturnType<typeof makePlan>,
  cases: Parameters<typeof finalizeLocalRule>[3],
): number {
  return new TextEncoder().encode(JSON.stringify(buildLocalRuleObservations(rule, plan, cases, 0))).byteLength;
}

function seededCasesWithViolationDetails(plan: ReturnType<typeof makePlan>, detailsPayload: string) {
  return plan.cases.map((auditCase) => ({
    target: { name: auditCase.name, url: auditCase.url },
    device: { name: auditCase.deviceName },
    status: "complete" as const,
    rules: auditCase.rules.map((rule) => ({
      name: rule.name,
      type: rule.type,
      status: "violations" as const,
      elementsInspected: 1,
      violations: [
        {
          type: "local" as const,
          message: "spacing violation",
          locator: "#content",
          geometry: { x: 0, y: 0, width: 1, height: 1 },
          details: { payload: detailsPayload },
        },
      ],
      failure: null,
    })),
    failures: [],
  }));
}

function payloadForObservationBytes(
  rule: EffectiveLocalRule,
  targetBytes: number,
): { plan: ReturnType<typeof makePlan>; cases: Parameters<typeof finalizeLocalRule>[3] } {
  const plan = makePlan(["a"], [rule]);
  let low = 0;
  let high = targetBytes;
  let bestPayload = "x";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const payload = "x".repeat(mid);
    const cases = seededCasesWithViolationDetails(plan, payload);
    const bytes = observationByteLength(rule, plan, cases);
    if (bytes <= targetBytes) {
      bestPayload = payload;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { plan, cases: seededCasesWithViolationDetails(plan, bestPayload) };
}

describe("plugin finalizer adapter", () => {
  test("passing finalizer records passed", async () => {
    const rule = localRule("passing", "finalize-passing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-passing-rule.ts",
      ruleName: "passing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plan = makePlan(["a"], [rule]);
    const result = await finalizeLocalRule(rule, loaded.value, plan, seededCases(plan), 0);
    expect(result).toEqual({ name: "passing", status: "passed", elementsInspected: 1, failure: null });
  });

  test("returned failure, thrown finalizer, malformed result, and oversize message map to typed failures", async () => {
    const cases: Array<{ fixture: string; code: FailureCode }> = [
      { fixture: "finalize-failing-rule.ts", code: "plugin-finalizer-invalid" },
      { fixture: "finalize-throwing-rule.ts", code: "plugin-finalizer-invalid" },
      { fixture: "finalize-malformed-rule.ts", code: "plugin-finalizer-invalid" },
      { fixture: "finalize-oversize-message-rule.ts", code: "plugin-diagnostic-too-large" },
    ];
    for (const item of cases) {
      const rule = localRule(item.fixture, item.fixture);
      const loaded = await loadPluginContract({
        configDirectory: fixtureRoot,
        relativePath: item.fixture,
        ruleName: item.fixture,
      });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      const plan = makePlan(["a"], [rule]);
      const result = await finalizeLocalRule(rule, loaded.value, plan, seededCases(plan), 0);
      expect(result.status).toBe("failed");
      expect(result.failure?.code).toBe(item.code);
    }
  });

  test("never-resolving finalizer maps to plugin-finalization-timeout", async () => {
    const rule = localRule("never", "finalize-never-resolves-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-never-resolves-rule.ts",
      ruleName: "never",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plan = makePlan(["a"], [rule]);
    const result = await finalizeLocalRule(rule, loaded.value, plan, seededCases(plan), 0, undefined, {
      timeoutMs: 25,
    });
    expect(result.failure?.code).toBe("plugin-finalization-timeout");
  });

  test("rules without finalize auto-pass", async () => {
    const rule = localRule("noop", "finalize-noop-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-noop-rule.ts",
      ruleName: "noop",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plan = makePlan(["a"], [rule]);
    const result = await finalizeLocalRule(rule, loaded.value, plan, seededCases(plan), 0);
    expect(result.status).toBe("passed");
  });

  test("observation count at the limit passes", async () => {
    const rule = localRule("passing", "finalize-passing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-passing-rule.ts",
      ruleName: "passing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plan = makePlan(
      Array.from({ length: MAX_FINALIZATION_OBSERVATIONS }, (_, index) => `t-${index}`),
      [rule],
    );
    const cases = seededCases(plan);
    const observations = buildLocalRuleObservations(rule, plan, cases, 0);
    expect(observations.cases).toHaveLength(MAX_FINALIZATION_OBSERVATIONS);
    const result = await finalizeLocalRule(rule, loaded.value, plan, cases, 0);
    expect(result.status).toBe("passed");
    expect(new TextEncoder().encode(JSON.stringify(observations)).byteLength).toBeLessThanOrEqual(
      MAX_FINALIZATION_OBSERVATION_BYTES,
    );
  });

  test("inputs above observation count fail before finalizer invocation", async () => {
    const rule = localRule("passing", "finalize-passing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-passing-rule.ts",
      ruleName: "passing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const plan = makePlan(
      Array.from({ length: MAX_FINALIZATION_OBSERVATIONS + 1 }, (_, index) => `t-${index}`),
      [rule],
    );
    const result = await finalizeLocalRule(rule, loaded.value, plan, seededCases(plan), 0);
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("plugin-finalizer-invalid");
    expect(result.failure?.message).toContain("observation count");
  });

  test("aggregate observation bytes at the limit passes", async () => {
    const rule = localRule("passing", "finalize-passing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-passing-rule.ts",
      ruleName: "passing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { plan, cases } = payloadForObservationBytes(rule, MAX_FINALIZATION_OBSERVATION_BYTES);
    const bytes = observationByteLength(rule, plan, cases);
    expect(bytes).toBeLessThanOrEqual(MAX_FINALIZATION_OBSERVATION_BYTES);
    const result = await finalizeLocalRule(rule, loaded.value, plan, cases, 0);
    expect(result.status).toBe("passed");
  });

  test("inputs above aggregate observation bytes fail before finalizer invocation", async () => {
    const rule = localRule("failing", "finalize-failing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: fixtureRoot,
      relativePath: "finalize-failing-rule.ts",
      ruleName: "failing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { plan, cases } = payloadForObservationBytes(rule, MAX_FINALIZATION_OBSERVATION_BYTES + 1);
    const bytes = observationByteLength(rule, plan, cases);
    expect(bytes).toBeGreaterThan(MAX_FINALIZATION_OBSERVATION_BYTES);
    const result = await finalizeLocalRule(rule, loaded.value, plan, cases, 0);
    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("plugin-finalizer-invalid");
    expect(result.failure?.message).toContain("serialized byte limit");
    expect(result.failure?.message).not.toContain("aggregate contract failed");
  });
});
