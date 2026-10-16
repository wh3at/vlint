import { withEnvironments } from "../fixtures/environments";
import { expect, test } from "bun:test";
import { normalizeRules, resolveTargets } from "../../src/config/merge";
import { parseConfig as parseRawConfig } from "../../src/config/schema";
const parseConfig = (value: unknown) => parseRawConfig(withEnvironments(value));

const device = {
  name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 },
  deviceScaleFactor: 1, isMobile: false, hasTouch: false,
};

test("SVG text clipping is enabled by default with a one CSS pixel tolerance", () => {
  expect(normalizeRules(undefined).find((rule) => rule.type === "svg-text-clipping")).toEqual({
    name: "svg-text-clipping", type: "svg-text-clipping", enabled: true,
    minimumInspected: null, tolerancePx: 1, excludeSelectors: [],
  });
});

test("SVG clipping configuration validates tolerance and merges target exclusions", () => {
  const parsed = parseConfig({ devices: [device], rules: [{
    name: "svg", type: "svg-text-clipping", tolerancePx: 0.5, excludeSelectors: [".intentional"],
  }], provider: { type: "static", targets: [{ name: "chart", url: "http://localhost/",
    ruleOverrides: { svg: { enabled: false, excludeSelectors: ["#label"], minimumInspected: 2 } },
  }] } });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.provider?.type !== "static") throw new Error("invalid config");
  const plan = resolveTargets({ path: "config", directory: ".", defaults: {}, devices: [device],
    environments: parsed.value.environments,
    rules: normalizeRules(parsed.value.rules) }, parsed.value.provider.targets);
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.violation.message);
  expect(plan.value.cases[0]?.rules.find((rule) => rule.name === "svg")).toMatchObject({
    enabled: false, tolerancePx: 0.5, minimumInspected: 2, excludeSelectors: [".intentional", "#label"],
  });
  for (const tolerancePx of [-1, 100.1, NaN, Infinity, "1"]) {
    expect(parseConfig({ devices: [device], rules: [{ name: "svg", type: "svg-text-clipping", tolerancePx }] }).ok).toBe(false);
  }
  for (const tolerancePx of [0, 100]) {
    expect(parseConfig({ devices: [device], rules: [{ name: "svg", type: "svg-text-clipping", tolerancePx }] }).ok).toBe(true);
  }
});
