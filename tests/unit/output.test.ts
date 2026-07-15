import { describe, expect, test } from "bun:test";
import type { RunResultV2 } from "../../src/contracts/result";
import { renderJson } from "../../src/output/json";
import { escapeTerminal, redactUrlForTerminal, renderTerminal } from "../../src/output/terminal";

const result: RunResultV2 = {
  schemaVersion: 2,
  status: "violations",
  tool: { name: "vlint", version: "0.1.0" },
  environment: {
    platform: "linux",
    arch: "x64",
    browser: { name: "chromium", version: "149.0.7827.55" },
  },
  summary: {
    targets: { resolved: 1 },
    cases: { resolved: 1, complete: 1, partial: 0, failed: 0, notExecuted: 0 },
    ruleEvaluations: { clean: 0, violations: 1, failed: 0, disabled: 0, notExecuted: 0 },
    ruleFinalizations: { passed: 1, failed: 0, notExecuted: 0 },
    violations: 1,
    matchedElements: 1,
    executionFailures: 0,
  },
  cases: [
    {
      target: {
        name: "settings\u001b]8;;https://attacker.invalid\u0007",
        url: "https://example.com/settings?token=secret&token=second#private",
      },
      device: {
        name: "MacBook Air 13",
        viewport: { width: 1470, height: 956 },
        screen: { width: 1470, height: 956 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: false,
        userAgent: null,
      },
      locale: "en-US",
      timezoneId: "UTC",
      status: "complete",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "violations",
          labelsInspected: 1,
          violations: [
            {
              text: "first\r\nsecond\u202e",
              lineCount: 2,
              geometry: { x: 1.125, y: 2, width: 30, height: 40 },
              locator: "#tab\nnext",
            },
          ],
          failure: null,
        },
      ],
      failures: [],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "passed", labelsInspected: 1, failure: null }],
  failures: [],
};

describe("output", () => {
  test("serializes stable JSON from the canonical result without redaction", () => {
    const first = renderJson(result);
    const second = renderJson(result);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first) as RunResultV2;
    expect(parsed.cases[0]?.target.url).toBe(result.cases[0]?.target.url);
    expect(parsed.cases[0]?.rules[0]?.violations[0]?.text).toBe("first\r\nsecond\u202e");
  });

  test("escapes terminal controls and bidi characters", () => {
    expect(escapeTerminal("a\u001b[31m\r\n\u202eb")).toBe("a\\u{1b}[31m\\r\\n\\u{202e}b");
  });

  test("redacts every query value and removes the fragment", () => {
    const safe = redactUrlForTerminal("https://example.com/x?a=secret&a=second&b=third#fragment");
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("second");
    expect(safe).not.toContain("third");
    expect(safe).not.toContain("fragment");
    expect(safe.match(/redacted/g)).toHaveLength(3);
  });

  test("renders diagnostics only through the inert terminal view", () => {
    const output = renderTerminal(result);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("second#private");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("\\u{1b}");
    expect(output).toContain("first\\r\\nsecond\\u{202e}");
    expect(output.endsWith("\n")).toBe(true);
  });

  test("renders nested rule and finalization failure diagnostics", () => {
    const failure = {
      stage: "rule-evaluation" as const,
      code: "rule-script-failed" as const,
      message: "selector failed",
      target: "settings",
      device: "macbook",
      rule: "tabs",
    };
    const failed: RunResultV2 = {
      ...result,
      cases: [{
        ...result.cases[0]!,
        rules: [{ ...result.cases[0]!.rules[0]!, status: "failed", failure }],
      }],
      ruleFinalizations: [{
        name: "tabs",
        status: "failed",
        labelsInspected: 0,
        failure: { ...failure, code: "zero-labels-global", message: "no labels" },
      }],
    };

    const output = renderTerminal(failed);
    expect(output).toContain("rule-evaluation/rule-script-failed");
    expect(output).toContain("rule-evaluation/zero-labels-global");
    expect(output).toContain("selector failed");
    expect(output).toContain("no labels");
  });
});
