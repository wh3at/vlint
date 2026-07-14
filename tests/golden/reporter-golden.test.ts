import { describe, expect, test } from "bun:test";
import type { RunResultV1 } from "../../src/contracts/result";
import { renderJson } from "../../src/output/json";
import { renderTerminal } from "../../src/output/terminal";

/**
 * Golden reporter coverage (U5). The two canonical results below carry
 * adversarial content — OSC/hyperlink escapes and bidi overrides in names,
 * query-string secrets (including a repeated key) and a fragment in the URL,
 * CRLF/tab/bidi in violation text, a newline in a locator, and fractional
 * geometry — so that the golden fixtures lock the exact rendered bytes for
 * both output formats. The assertions below guard the reporter contract:
 *
 *   - exact byte stability against the committed golden fixtures (regression lock)
 *   - render determinism (idempotent re-render)
 *   - exactly one trailing newline; JSON is a single line
 *   - JSON preserves the exact configured URL and rendered text verbatim
 *   - terminal redacts every query value, drops the fragment, and escapes
 *     every C0/C1 control and bidi formatting character to an inert literal
 */

const violations: RunResultV1 = {
  schemaVersion: 1,
  status: "violations",
  tool: { name: "vlint", version: "0.1.0" },
  environment: {
    platform: "linux",
    arch: "x64",
    browser: { name: "chromium", version: "149.0.7827.55" },
  },
  summary: {
    targets: { resolved: 2, complete: 2, partial: 0, failed: 0, notExecuted: 0 },
    ruleEvaluations: { clean: 1, violations: 1, failed: 0, disabled: 1, notExecuted: 0 },
    ruleFinalizations: { passed: 1, failed: 0, notExecuted: 0 },
    violations: 2,
    matchedElements: 3,
    executionFailures: 0,
  },
  targets: [
    {
      name: "settings\u001b]8;;https://attacker.invalid\u0007",
      url: "https://example.com/settings?token=secret&token=second#private",
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
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
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
        },
      ],
    },
    {
      name: "second",
      url: "https://example.com/x?a=1&b=2",
      viewport: { width: 900, height: 700 },
      deviceScaleFactor: 2,
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
        },
        {
          name: "off-rule",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
        },
      ],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "passed", labelsInspected: 3, failure: null }],
  failure: null,
};

const incomplete: RunResultV1 = {
  schemaVersion: 1,
  status: "incomplete",
  tool: { name: "vlint", version: "0.1.0" },
  environment: {
    platform: "linux",
    arch: "x64",
    browser: { name: "chromium", version: null },
  },
  summary: {
    targets: { resolved: 1, complete: 0, partial: 0, failed: 0, notExecuted: 1 },
    ruleEvaluations: { clean: 0, violations: 0, failed: 0, disabled: 1, notExecuted: 1 },
    ruleFinalizations: { passed: 0, failed: 0, notExecuted: 1 },
    violations: 0,
    matchedElements: 0,
    executionFailures: 1,
  },
  targets: [
    {
      name: "only",
      url: "https://example.com/only",
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      status: "not-executed",
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          status: "not-executed",
          labelsInspected: 0,
          violations: [],
        },
        {
          name: "off",
          type: "tab-label-single-line",
          status: "disabled",
          labelsInspected: 0,
          violations: [],
        },
      ],
    },
  ],
  ruleFinalizations: [{ name: "tabs", status: "not-executed", labelsInspected: 0, failure: null }],
  failure: {
    stage: "browser-setup",
    code: "browser-missing",
    message: "chromium not installed",
    target: null,
    rule: null,
  },
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
    // JSON.stringify never emits an interior newline; exactly one terminator.
    expect(rendered.split("\n")).toHaveLength(2);
    const parsed = JSON.parse(rendered) as RunResultV1;
    // JSON preserves the exact configured URL, including secrets and fragment.
    expect(parsed.targets[0]?.url).toBe(violations.targets[0]?.url);
    // JSON preserves the exact rendered text, including bidi/control bytes.
    expect(parsed.targets[0]?.rules[0]?.violations[0]?.text).toBe("first\r\nsecond\u202e");
    expect(parsed.status).toBe("violations");
  });

  test("terminal redacts every query value, drops the fragment, and escapes controls", () => {
    const rendered = renderTerminal(violations);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    // No raw secret material survives into the terminal view.
    // Raw query values and the fragment never survive into the terminal URL view.
    expect(rendered).not.toContain("token=secret");
    expect(rendered).not.toContain("token=second");
    expect(rendered).not.toContain("#private");
    // No raw control or bidi formatting character reaches the terminal.
    expect(hasRawControlOrBidi(rendered)).toBe(false);
    // The inert escaped forms are present instead.
    expect(rendered).toContain("\\u{1b}");
    expect(rendered).toContain("\\u{202e}");
    expect(rendered).toContain("redacted");
    // Repeated query key produces one redaction per value.
    expect(rendered.match(/redacted/g)).toHaveLength(4);
  });

  test("terminal preserves the fragment-free URL in the incomplete matrix", () => {
    const rendered = renderTerminal(incomplete);
    expect(rendered).toContain("target only: not-executed https://example.com/only");
    expect(rendered).toContain("failure browser-setup/browser-missing target=- rule=-");
    expect(hasRawControlOrBidi(rendered)).toBe(false);
  });
});
