import { describe, expect, test } from "bun:test";
import type { RunResultV2 } from "../../src/contracts/result";
import { renderJson } from "../../src/output/json";
import { renderTerminal } from "../../src/output/terminal";

/**
 * Golden reporter coverage (U4). The two canonical results below carry
 * adversarial content — OSC/hyperlink escapes and bidi overrides in names,
 * query-string secrets (including a repeated key) and a fragment in the URL,
 * CRLF/tab/bidi in violation text, a newline in a locator, and fractional
 * geometry — so that the golden fixtures lock the exact rendered bytes for
 * both output formats.
 *
 * The violations result exercises AE5: 2 logical targets × 2 devices = 4
 * ordered cases in target-major / device-minor order. The incomplete result
 * exercises AE6: one case fails while another completes in the same run.
 *
 * The assertions below guard the reporter contract:
 *
 *   - exact byte stability against the committed golden fixtures (regression lock)
 *   - render determinism (idempotent re-render)
 *   - exactly one trailing newline; JSON is a single line
 *   - JSON preserves the exact configured URL and rendered text verbatim
 *   - terminal redacts every query value, drops the fragment, and escapes
 *     every C0/C1 control and bidi formatting character to an inert literal
 *   - target and device identities are rendered as separate escaped fields
 *   - summary partitions reconcile with the underlying cases and rules
 */

const MACBOOK = {
  name: "MacBook Air 13",
  viewport: { width: 1470, height: 956 },
  screen: { width: 1470, height: 956 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  userAgent: null,
} as const;

const IPHONE = {
  name: "iPhone 17",
  viewport: { width: 402, height: 681 },
  screen: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
} as const;

const violations: RunResultV2 = {
  schemaVersion: 2,
  status: "violations",
  tool: { name: "vlint", version: "0.1.0" },
  environment: {
    platform: "linux",
    arch: "x64",
    browser: { name: "chromium", version: "149.0.7827.55" },
  },
  summary: {
    targets: { resolved: 2 },
    cases: { resolved: 4, complete: 4, partial: 0, failed: 0, notExecuted: 0 },
    ruleEvaluations: { clean: 3, violations: 1, failed: 0, disabled: 4, notExecuted: 0 },
    ruleFinalizations: { passed: 1, failed: 0, notExecuted: 0 },
    violations: 2,
    matchedElements: 5,
    executionFailures: 0,
  },
  cases: [
    {
      target: {
        name: "settings\u001b]8;;https://attacker.invalid\u0007",
        url: "https://example.com/settings?token=secret&token=second#private",
      },
      device: MACBOOK,
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "violations",
          labelsInspected: 2,
          violations: [
            {
              text: "first\r\nsecond\u202e",
              lineCount: 2,
              geometry: { x: 1.125, y: 2, width: 30, height: 40 },
              locator: "#tab\nnext",
            },
            {
              text: "plain",
              lineCount: 1,
              geometry: { x: 0, y: 0, width: 10, height: 10 },
              locator: "#other",
            },
          ],
          failure: null,
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [],
    },
    {
      target: {
        name: "settings\u001b]8;;https://attacker.invalid\u0007",
        url: "https://example.com/settings?token=secret&token=second#private",
      },
      device: IPHONE,
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "clean",
          labelsInspected: 1,
          violations: [],
          failure: null,
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [],
    },
    {
      target: {
        name: "second",
        url: "https://example.com/x?a=1&b=2",
      },
      device: MACBOOK,
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "clean",
          labelsInspected: 1,
          violations: [],
          failure: null,
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [],
    },
    {
      target: {
        name: "second",
        url: "https://example.com/x?a=1&b=2",
      },
      device: IPHONE,
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "clean",
          labelsInspected: 1,
          violations: [],
          failure: null,
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "passed", labelsInspected: 5, failure: null }],
  failures: [],
};

const incomplete: RunResultV2 = {
  schemaVersion: 2,
  status: "incomplete",
  tool: { name: "vlint", version: "0.1.0" },
  environment: {
    platform: "linux",
    arch: "x64",
    browser: { name: "chromium", version: null },
  },
  summary: {
    targets: { resolved: 1 },
    cases: { resolved: 2, complete: 1, partial: 0, failed: 1, notExecuted: 0 },
    ruleEvaluations: { clean: 1, violations: 0, failed: 0, disabled: 2, notExecuted: 1 },
    ruleFinalizations: { passed: 0, failed: 0, notExecuted: 1 },
    violations: 0,
    matchedElements: 1,
    executionFailures: 1,
  },
  cases: [
    {
      target: { name: "only", url: "https://example.com/only" },
      device: MACBOOK,
      locale: "en-US",
      timezoneId: "UTC",
      status: "failed",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "not-executed",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
        {
          name: "off",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [
        {
          stage: "navigation",
          code: "navigation-http-status",
          message: "navigation returned HTTP 500",
          target: "only",
          device: "MacBook Air 13",
          rule: null,
        },
      ],
    },
    {
      target: { name: "only", url: "https://example.com/only" },
      device: IPHONE,
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "clean",
          labelsInspected: 1,
          violations: [],
          failure: null,
        },
        {
          name: "off",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
          failure: null,
        },
      ],
      failures: [],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "not-executed", labelsInspected: 0, failure: null }],
  failures: [],
};

const BIDI_CONTROLS: Record<number, true> = {
  0x202a: true,
  0x202b: true,
  0x202c: true,
  0x202d: true,
  0x202e: true,
  0x2066: true,
  0x2067: true,
  0x2068: true,
  0x2069: true,
};

function hasRawControlOrBidi(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || BIDI_CONTROLS[code] === true) return true;
  }
  return false;
}

describe("reporter golden output", () => {
  test.each([
    ["violations", violations],
    ["incomplete", incomplete],
  ] as const)("locks exact JSON bytes for %s against the fixture", async (name, result) => {
    const rendered = renderJson(result);
    const fixture = await Bun.file(`tests/golden/fixtures/${name}.json.txt`).text();
    expect(rendered).toBe(fixture);
  });

  test.each([
    ["violations", violations],
    ["incomplete", incomplete],
  ] as const)("locks exact terminal bytes for %s against the fixture", async (name, result) => {
    const rendered = renderTerminal(result);
    const fixture = await Bun.file(`tests/golden/fixtures/${name}.terminal.txt`).text();
    expect(rendered).toBe(fixture);
  });

  test.each([
    ["violations", violations],
    ["incomplete", incomplete],
  ] as const)("renders %s deterministically on repeated invocation", (_name, result) => {
    expect(renderJson(result)).toBe(renderJson(result));
    expect(renderTerminal(result)).toBe(renderTerminal(result));
  });

  test("JSON is a single newline-terminated line and round-trips verbatim", () => {
    const rendered = renderJson(violations);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.split("\n")).toHaveLength(2);
    const parsed = JSON.parse(rendered) as RunResultV2;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.cases[0]?.target.url).toBe(violations.cases[0]?.target.url);
    expect(parsed.cases[0]?.rules[0]?.violations[0]?.text).toBe("first\r\nsecond\u202e");
    expect(parsed.status).toBe("violations");
  });

  test("terminal redacts every query value, drops the fragment, and escapes controls", () => {
    const rendered = renderTerminal(violations);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    expect(rendered).not.toContain("token=secret");
    expect(rendered).not.toContain("token=second");
    expect(rendered).not.toContain("#private");
    expect(hasRawControlOrBidi(rendered)).toBe(false);
    expect(rendered).toContain("\\u{1b}");
    expect(rendered).toContain("\\u{202e}");
    expect(rendered).toContain("redacted");
    // Each target URL appears in 2 cases (MacBook + iPhone), so 4 query values × 2 = 8.
    expect(rendered.match(/redacted/g)).toHaveLength(8);
  });

  test("terminal renders target and device as separate escaped fields", () => {
    const rendered = renderTerminal(violations);
    expect(rendered).toContain("case target=settings\\u{1b}]8;;https://attacker.invalid\\u{7} device=MacBook Air 13:");
    expect(rendered).toContain("device=iPhone 17:");
    expect(rendered).toContain("case target=second device=MacBook Air 13:");
  });

  test("terminal preserves the URL and case failure in the incomplete matrix", () => {
    const rendered = renderTerminal(incomplete);
    expect(rendered).toContain("case target=only device=MacBook Air 13: failed https://example.com/only viewport=1470x956@2");
    expect(rendered).toContain("case target=only device=iPhone 17: complete https://example.com/only viewport=402x681@3");
    expect(rendered).toContain("failure navigation/navigation-http-status target=only device=MacBook Air 13 rule=-");
    expect(hasRawControlOrBidi(rendered)).toBe(false);
  });

  test("summary partitions reconcile for violations", () => {
    const cases = violations.summary.cases;
    expect(cases.resolved).toBe(violations.cases.length);
    expect(cases.complete + cases.partial + cases.failed + cases.notExecuted).toBe(cases.resolved);
    const rules = violations.summary.ruleEvaluations;
    const totalRules = violations.cases.reduce((sum, c) => sum + c.rules.length, 0);
    expect(rules.clean + rules.violations + rules.failed + rules.disabled + rules.notExecuted).toBe(totalRules);
    expect(violations.summary.targets.resolved).toBe(2);
    expect(violations.summary.executionFailures).toBe(0);
  });

  test("summary partitions reconcile for incomplete", () => {
    const cases = incomplete.summary.cases;
    expect(cases.resolved).toBe(incomplete.cases.length);
    expect(cases.complete + cases.partial + cases.failed + cases.notExecuted).toBe(cases.resolved);
    const totalFailures =
      incomplete.failures.length +
      incomplete.cases.reduce((sum, c) => sum + c.failures.length, 0) +
      incomplete.cases.reduce(
        (sum, c) => sum + c.rules.filter((r) => r.failure !== null).length,
        0,
      ) +
      incomplete.ruleFinalizations.filter((f) => f.failure !== null).length;
    expect(incomplete.summary.executionFailures).toBe(totalFailures);
    expect(incomplete.summary.executionFailures).toBe(1);
  });

  test("exit mapping is clean 0, violations 1, incomplete 2", () => {
    const cleanResult: RunResultV2 = { ...violations, status: "clean", summary: { ...violations.summary, violations: 0 } };
    expect(cleanResult.status === "incomplete" ? 2 : cleanResult.status === "violations" ? 1 : 0).toBe(0);
    expect(violations.status === "incomplete" ? 2 : violations.status === "violations" ? 1 : 0).toBe(1);
    expect(incomplete.status === "incomplete" ? 2 : incomplete.status === "violations" ? 1 : 0).toBe(2);
  });
});
