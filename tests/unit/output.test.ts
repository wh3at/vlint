import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../src/contracts/result";
import { isLocalViolation, isTabLabelSingleLineViolation } from "../../src/contracts/evaluation";
import { renderJson } from "../../src/output/json";
import { escapeTerminal, redactUrlForTerminal, renderTerminal } from "../../src/output/terminal";

const result: RunResult = {
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
    elementsInspected: 1,
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
          elementsInspected: 1,
          violations: [
            { type: "tab-label-single-line", text: "first\r\nsecond\u202e", lineCount: 2, geometry: { x: 1.125, y: 2, width: 30, height: 40 }, locator: "#tab\nnext" },
          ],
          failure: null,
        },
      ],
      failures: [],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "passed", elementsInspected: 1, failure: null }],
  failures: [],
};

describe("output", () => {
  test("serializes stable JSON from the canonical result without redaction", () => {
    const first = renderJson(result);
    const second = renderJson(result);
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first) as RunResult;
    expect(parsed.cases[0]?.target.url).toBe(result.cases[0]?.target.url);
    expect(
      parsed.cases[0]?.rules[0]?.violations.filter(isTabLabelSingleLineViolation)[0]?.text,
    ).toBe("first\r\nsecond\u202e");
  });

  test("escapes terminal controls and bidi characters", () => {
    expect(escapeTerminal("a\u001b[31m\r\n\u061c\u200e\u200f\u202eb")).toBe(
      "a\\u{1b}[31m\\r\\n\\u{61c}\\u{200e}\\u{200f}\\u{202e}b",
    );
  });

  test("redacts userinfo and every query value, and removes the fragment", () => {
    const safe = redactUrlForTerminal("https://user:password@example.com/x?a=secret&a=second&b=third#fragment");
    expect(safe).not.toContain("user");
    expect(safe).not.toContain("password");
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

  test("renders overflow diagnostics with the fixed computed-style evidence", () => {
    const overflowResult: RunResult = {
      ...result,
      cases: [{
        ...result.cases[0]!,
        rules: [{
          name: "page-horizontal-overflow",
          type: "page-horizontal-overflow",
          status: "violations",
          elementsInspected: 1,
          violations: [{
            type: "page-horizontal-overflow",
            overflowPx: 12.5,
            geometry: { x: -2, y: 3, width: 414, height: 50 },
            locator: "#wide\npanel",
            computedStyle: {
              display: "block",
              position: "static",
              boxSizing: "border-box",
              width: "414px",
              minWidth: "auto",
              maxWidth: "none",
              whiteSpace: "normal",
              overflowX: "visible",
              flex: "0 1 auto",
              flexBasis: "auto",
              flexGrow: "0",
              flexShrink: "1",
              gridTemplateColumns: "none",
              gridAutoColumns: "auto",
            },
          }],
          failure: null,
        }],
      }],
      ruleFinalizations: [{
        name: "page-horizontal-overflow",
        status: "passed",
        elementsInspected: 1,
        failure: null,
      }],
    };

    expect(renderTerminal(overflowResult)).toContain(
      '    violation overflow=12.5px locator=#wide\\npanel box=-2,3,414,50 css={"display":"block","position":"static","boxSizing":"border-box","width":"414px","minWidth":"auto","maxWidth":"none","whiteSpace":"normal","overflowX":"visible","flex":"0 1 auto","flexBasis":"auto","flexGrow":"0","flexShrink":"1","gridTemplateColumns":"none","gridAutoColumns":"auto"}',
    );
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
    const failed: RunResult = {
      ...result,
      cases: [{
        ...result.cases[0]!,
        rules: [{ ...result.cases[0]!.rules[0]!, status: "failed", failure }],
      }],
      ruleFinalizations: [{
        name: "tabs",
        status: "failed",
        elementsInspected: 0,
        failure: { ...failure, code: "zero-labels-global", message: "no labels" },
      }],
    };

    const output = renderTerminal(failed);
    expect(output).toContain("rule-evaluation/rule-script-failed");
    expect(output).toContain("rule-evaluation/zero-labels-global");
    expect(output).toContain("selector failed");
    expect(output).toContain("no labels");
  });

  test("renders local violations without interpreting project details", () => {
    const localResult: RunResult = {
      ...result,
      cases: [{
        ...result.cases[0]!,
        rules: [{
          name: "duplicate-spacing",
          type: "local",
          status: "violations",
          elementsInspected: 2,
          violations: [{
            type: "local",
            message: "duplicate horizontal spacing in content region",
            locator: "#content",
            geometry: { x: 16, y: 16, width: 200, height: 40 },
            details: { shellPaddingPx: 32, contentPaddingPx: 32, secret: "S3CR3T" },
          }],
          failure: null,
        }],
      }],
      ruleFinalizations: [{ name: "duplicate-spacing", status: "passed", elementsInspected: 2, failure: null }],
    };

    const terminal = renderTerminal(localResult);
    const json = JSON.parse(renderJson(localResult)) as RunResult;
    const violation = json.cases[0]?.rules[0]?.violations[0];
    if (!violation || !isLocalViolation(violation)) throw new Error("expected local violation");

    expect(terminal).toContain("message=duplicate horizontal spacing in content region");
    expect(terminal).toContain("locator=#content");
    expect(terminal).toContain("box=16,16,200,40");
    expect(terminal).not.toContain("S3CR3T");
    expect(terminal).not.toContain("shellPaddingPx");
    expect(violation.message).toBe("duplicate horizontal spacing in content region");
    expect(violation.details).toEqual({ shellPaddingPx: 32, contentPaddingPx: 32, secret: "S3CR3T" });
  });

  test("escapes plugin failure messages with controls and does not leak paths in JSON", () => {
    const secretPath = "/home/secret/project/rule.ts";
    const pluginFailure = {
      stage: "config" as const,
      code: "plugin-dependency-forbidden" as const,
      message: `forbidden import in ${secretPath}\u001b[31mstack`,
      target: null,
      device: null,
      rule: "spacing",
    };
    const failed: RunResult = {
      ...result,
      status: "incomplete",
      summary: { ...result.summary, executionFailures: 1 },
      failures: [pluginFailure],
    };

    const terminal = renderTerminal(failed);
    const json = renderJson(failed);
    expect(terminal).toContain("config/plugin-dependency-forbidden");
    expect(terminal).toContain("\\u{1b}");
    expect(terminal).not.toContain("\u001b");
    expect(json).not.toContain(secretPath);
    expect(json).toContain("plugin-dependency-forbidden");
  });

  test("preserves mixed built-in and local violations in declaration order", () => {
    const mixed: RunResult = {
      ...result,
      summary: {
        ...result.summary,
        ruleEvaluations: { clean: 0, violations: 2, failed: 0, disabled: 0, notExecuted: 0 },
        violations: 2,
        elementsInspected: 3,
      },
      cases: [{
        ...result.cases[0]!,
        rules: [
          {
            name: "tabs",
            type: "tab-label-single-line",
            status: "violations",
            elementsInspected: 1,
            violations: [{
              type: "tab-label-single-line",
              text: "wrapped",
              lineCount: 2,
              geometry: { x: 0, y: 0, width: 10, height: 10 },
              locator: "#tab",
            }],
            failure: null,
          },
          {
            name: "duplicate-spacing",
            type: "local",
            status: "violations",
            elementsInspected: 2,
            violations: [{
              type: "local",
              message: "duplicate horizontal spacing",
              locator: "#content",
              geometry: { x: 1, y: 2, width: 3, height: 4 },
              details: null,
            }],
            failure: null,
          },
        ],
      }],
      ruleFinalizations: [
        { name: "tabs", status: "passed", elementsInspected: 1, failure: null },
        { name: "duplicate-spacing", status: "passed", elementsInspected: 2, failure: null },
      ],
    };

    const output = renderTerminal(mixed);
    const tabIndex = output.indexOf("rule tabs:");
    const localIndex = output.indexOf("rule duplicate-spacing:");
    expect(tabIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeGreaterThan(tabIndex);
    expect(output).toContain("violations=2");
  });

  test("renders complete table-header evidence and retains candidate diagnostics in JSON", () => {
    const tableResult: RunResult = {
      ...result,
      cases: [{
        ...result.cases[0]!,
        rules: [{
          name: "tables",
          type: "table-header-single-line",
          status: "violations",
          elementsInspected: 1,
          violations: [{
            type: "table-header-single-line",
            candidateSource: "native",
            text: "Review\nscore",
            lineCount: 2,
            lineTops: [10.125, 30.5],
            lineTopTolerancePx: 1,
            geometry: { x: 1, y: 2, width: 80, height: 40 },
            locator: "#review\nscore",
          }],
          candidateDiagnostics: [{
            kind: "excluded",
            locator: "#intentional",
            excludeSelector: ".allow-wrap",
          }],
          failure: null,
        }],
      }],
      ruleFinalizations: [{ name: "tables", status: "passed", elementsInspected: 1, failure: null }],
    };

    expect(renderTerminal(tableResult)).toContain(
      "violation lines=2 tops=10.125,30.5 tolerance=1px source=native locator=#review\\nscore box=1,2,80,40 text=Review\\nscore",
    );
    const parsed = JSON.parse(renderJson(tableResult)) as RunResult;
    expect(parsed.cases[0]?.rules[0]?.candidateDiagnostics).toEqual([
      { kind: "excluded", locator: "#intentional", excludeSelector: ".allow-wrap" },
    ]);
  });
});
