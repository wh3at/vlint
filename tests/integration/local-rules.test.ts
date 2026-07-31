/**
 * Integration tests for local rule browser evaluation (U3).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import type { EffectiveAuditCase, EffectiveLocalRule } from "../../src/contracts/config";
import type { JsonSettings } from "../../src/contracts/plugins";
import type { LocalViolation, RuleEvaluationOutcome } from "../../src/contracts/evaluation";
import { evaluateLocalRule } from "../../src/plugins/evaluate";
import { loadPluginContract } from "../../src/plugins/load";
import { PLUGIN_EVALUATION_TIMEOUT_MS } from "../../src/plugins/evaluate";
import { startFixtureServer } from "../fixtures/app/server";

const fixtureRoot = `${import.meta.dir}/../fixtures/plugins`;

const DESKTOP_CASE: EffectiveAuditCase = {
  name: "spacing-fixture",
  url: "http://127.0.0.1/spacing-violation.html",
  deviceName: "desk",
  viewport: { width: 1280, height: 800 },
  screen: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  userAgent: null,
  locale: "en-US",
  timezoneId: "UTC",
  timeoutMs: 30_000,
  browserState: null,
  readyCondition: null,
  rules: [],
};

const MOBILE_CASE: EffectiveAuditCase = {
  ...DESKTOP_CASE,
  deviceName: "phone",
  viewport: { width: 402, height: 681 },
  screen: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (TestPhone)",
};

function localRule(name: string, settings: JsonSettings = {}): EffectiveLocalRule {
  return {
    name,
    type: "local",
    enabled: true,
    path: "duplicate-spacing-rule.ts",
    settings,
  };
}

let browser: Browser;
let fixtureUrl: string;
let fixtureClose: () => Promise<void>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const server = await startFixtureServer();
  fixtureUrl = server.url;
  fixtureClose = server.close;
});

afterAll(async () => {
  await browser.close().catch(() => undefined);
  await fixtureClose().catch(() => undefined);
});

async function newPage(width = 1280, height = 800): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  return context.newPage();
}

async function loadSpacingContract(directory: string, ruleFile = "duplicate-spacing-rule.ts") {
  return loadPluginContract({
    configDirectory: directory,
    relativePath: ruleFile,
    ruleName: "duplicate-spacing",
  });
}

async function measureSpacing(
  path: string,
  rule: EffectiveLocalRule,
  auditCase: EffectiveAuditCase,
  directory: string,
): Promise<RuleEvaluationOutcome<LocalViolation>> {
  const loaded = await loadSpacingContract(directory, rule.path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.failure.message);
  const page = await newPage(auditCase.viewport.width, auditCase.viewport.height);
  await page.goto(`${fixtureUrl}${path}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  const outcome = await evaluateLocalRule(page, rule, loaded.value, auditCase);
  await page.close();
  return outcome;
}

describe("local rule browser evaluation", () => {
  test("duplicate shell and content spacing yields one actionable violation (AE1)", async () => {
    const directory = `${fixtureRoot}`;
    const rule = localRule("duplicate-spacing", {
      shellSelector: "#app-shell",
      contentSelector: "#content",
    });
    const auditCase = { ...DESKTOP_CASE, rules: [rule] };
    const outcome = await measureSpacing("/spacing-violation.html", rule, auditCase, directory);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.elementsInspected).toBe(2);
    expect(outcome.facts.violations).toHaveLength(1);
    const violation = outcome.facts.violations[0]!;
    expect(violation).toMatchObject({
      type: "local",
      message: "duplicate horizontal spacing in content region",
      locator: "#content",
      details: { shellPaddingPx: 32, contentPaddingPx: 32 },
    });
    expect(violation.geometry.width).toBeGreaterThan(0);
    expect(violation.geometry.height).toBeGreaterThan(0);
  });

  test("clean spacing fixture yields a clean local result (AE2)", async () => {
    const directory = `${fixtureRoot}`;
    const rule = localRule("duplicate-spacing", {
      shellSelector: "#app-shell",
      contentSelector: "#content",
    });
    const auditCase = { ...DESKTOP_CASE, rules: [rule] };
    const outcome = await measureSpacing("/spacing-clean.html", rule, auditCase, directory);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts).toEqual({ elementsInspected: 2, violations: [] });
  });

  test("observes changed rule path on mobile fixture", async () => {
    const directory = `${fixtureRoot}`;
    const rule = localRule("duplicate-spacing", {
      shellSelector: "#app-shell",
      contentSelector: "#content",
    });
    const auditCase = { ...MOBILE_CASE, rules: [rule] };
    const outcome = await measureSpacing("/spacing-violation.html", rule, auditCase, directory);
    expect(outcome.failure).toBeNull();
    expect(outcome.facts.violations).toHaveLength(1);
    expect(outcome.facts.violations[0]?.locator).toBe("#content");
  });

  test("preserves partial facts when later locator verification fails", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-partial-locator-rule.ts",
      ruleName: "partial-locator",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "partial-locator",
      type: "local",
      enabled: true,
      path: "eval-partial-locator-rule.ts",
      settings: {},
    };
    const page = await newPage();
    await page.setContent(
      `<!doctype html><html><body><main id="content">ok</main></body></html>`,
      { waitUntil: "load" },
    );
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE);
    await page.close();
    expect(outcome.failure?.code).toBe("geometry-evaluation-failed");
    expect(outcome.facts.elementsInspected).toBe(2);
    expect(outcome.facts.violations).toHaveLength(1);
    expect(outcome.facts.violations[0]).toMatchObject({
      type: "local",
      message: "first valid",
      locator: "#content",
    });
  });

  test("maps thrown evaluator to plugin-evaluator-invalid (AE4)", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-throwing-rule.ts",
      ruleName: "eval-throwing",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "eval-throwing",
      type: "local",
      enabled: true,
      path: "eval-throwing-rule.ts",
      settings: {},
    };
    const page = await newPage();
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE);
    await page.close();
    expect(outcome.failure?.code).toBe("plugin-evaluator-invalid");
    expect(outcome.facts.violations).toEqual([]);
  });

  test("maps invalid fact count to local-fact-invalid", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-invalid-return-rule.ts",
      ruleName: "eval-invalid-return",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "eval-invalid-return",
      type: "local",
      enabled: true,
      path: "eval-invalid-return-rule.ts",
      settings: {},
    };
    const page = await newPage();
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE);
    await page.close();
    expect(outcome.failure?.code).toBe("local-fact-invalid");
  });

  test("rejects cyclic return values inside normalization boundary", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-cyclic-return-rule.ts",
      ruleName: "eval-cyclic-return",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "eval-cyclic-return",
      type: "local",
      enabled: true,
      path: "eval-cyclic-return-rule.ts",
      settings: {},
    };
    const page = await newPage();
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE);
    await page.close();
    expect(outcome.failure?.code).toBe("local-violation-invalid");
  });

  test("maps never-resolving evaluator to plugin-evaluation-timeout", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-never-resolves-rule.ts",
      ruleName: "eval-never-resolves",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "eval-never-resolves",
      type: "local",
      enabled: true,
      path: "eval-never-resolves-rule.ts",
      settings: {},
    };
    const page = await newPage();
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    const started = Date.now();
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE);
    await page.close();
    expect(outcome.failure?.code).toBe("plugin-evaluation-timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(PLUGIN_EVALUATION_TIMEOUT_MS - 500);
  }, PLUGIN_EVALUATION_TIMEOUT_MS + 5_000);

  test("maps abort to signal-interrupt", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "eval-never-resolves-rule.ts",
      ruleName: "eval-never-resolves",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const rule: EffectiveLocalRule = {
      name: "eval-never-resolves",
      type: "local",
      enabled: true,
      path: "eval-never-resolves-rule.ts",
      settings: {},
    };
    const controller = new AbortController();
    const page = await newPage();
    await page.setContent("<!doctype html><html><body></body></html>", { waitUntil: "load" });
    setTimeout(() => controller.abort(), 50);
    const outcome = await evaluateLocalRule(page, rule, loaded.value, DESKTOP_CASE, DESKTOP_CASE.name, controller.signal);
    await page.close();
    expect(outcome.failure?.code).toBe("signal-interrupt");
  });

  test("concurrent cases do not share in-page evaluation state", async () => {
    const directory = `${fixtureRoot}`;
    const loaded = await loadSpacingContract(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const ruleA: EffectiveLocalRule = {
      name: "spacing-a",
      type: "local",
      enabled: true,
      path: "duplicate-spacing-rule.ts",
      settings: { shellSelector: "#app-shell", contentSelector: "#content" },
    };
    const ruleB: EffectiveLocalRule = {
      name: "spacing-b",
      type: "local",
      enabled: true,
      path: "duplicate-spacing-rule.ts",
      settings: { shellSelector: "#app-shell", contentSelector: "#content" },
    };
    const pageA = await newPage();
    const pageB = await newPage();
    await pageA.goto(`${fixtureUrl}/spacing-violation.html`, { waitUntil: "domcontentloaded" });
    await pageB.goto(`${fixtureUrl}/spacing-clean.html`, { waitUntil: "domcontentloaded" });
    const [outcomeA, outcomeB] = await Promise.all([
      evaluateLocalRule(pageA, ruleA, loaded.value, DESKTOP_CASE),
      evaluateLocalRule(pageB, ruleB, loaded.value, MOBILE_CASE),
    ]);
    await pageA.close();
    await pageB.close();
    expect(outcomeA.facts.violations).toHaveLength(1);
    expect(outcomeB.facts.violations).toHaveLength(0);
    expect(outcomeA.facts.elementsInspected).toBe(2);
    expect(outcomeB.facts.elementsInspected).toBe(2);
  });
});
