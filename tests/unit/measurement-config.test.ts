import { withEnvironments } from "../fixtures/environments";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig as parseRawConfig } from "../../src/config/schema";
const parseConfig = (value: unknown) => parseRawConfig(withEnvironments(value));
import { loadConfig } from "../../src/config/load";
import { resolveAdHocTarget, resolveTargets } from "../../src/config/merge";
import { resolveCheckPlan } from "../../src/commands/check";

const device = { name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const phone = { ...device, name: "phone", viewport: { width: 390, height: 600 }, screen: { width: 390, height: 600 } };
const target = { name: "home", url: "https://example.com/" };
const directories: string[] = [];

async function config(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-minimums-"));
  directories.push(directory);
  await writeFile(join(directory, "vlint.config.json"), JSON.stringify(withEnvironments(value)));
  return directory;
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

test("rule, target, device and combination minimums resolve per case", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 2 } }, phone],
    rules: [{ name: "tabs", type: "tab-label-single-line", minimumInspected: 1 }],
    provider: { type: "static", targets: [
      { ...target, ruleOverrides: { tabs: { minimumInspected: 2 } }, deviceRuleMinimums: { phone: { tabs: 4 } } },
      { name: "other", url: "https://example.com/other" },
    ] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("invalid config");
  const resolution = resolveTargets(loaded.value, loaded.value.provider.targets);
  if (!resolution.ok) throw new Error(resolution.violation.message);
  const resolved = resolution.value;
  expect(resolved.cases.map((audit) => audit.rules.find((item) => item.name === "tabs")?.minimumInspected)).toEqual([2, 4, 2, 1]);
});

test("conflicting target and device minimums require a combination override", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 3 } }],
    rules: [{ name: "tabs", type: "tab-label-single-line" }],
    provider: { type: "static", targets: [{ ...target, ruleOverrides: { tabs: { minimumInspected: 2 } } }] },
  });
  const resolved = await resolveCheckPlan(directory, null, {});
  expect(resolved.ok ? null : resolved.failure).toMatchObject({ code: "config-schema-invalid", target: "home", device: "desktop", rule: "tabs" });
});

test.each([
  [{ minimumLabels: 1 }, "tab-label-single-line"],
  [{ allowZeroHeaders: true }, "table-header-single-line"],
  [{ minimumInspected: -1 }, "table-cell-text-overlap"],
  [{ minimumInspected: 1 }, "page-horizontal-overflow"],
])("rejects unsupported or invalid minimum %j", (extra, type) => {
  const parsed = parseConfig({ devices: [device], rules: [{ name: "check", type, ...extra }] });
  expect(parsed.ok ? null : parsed.failure.code).toBe("config-schema-invalid");
});

test("accepts local rule minimums and disabled target overrides", () => {
  const parsed = parseConfig({ devices: [device], rules: [{ name: "custom", type: "local", path: "rules/custom.ts", minimumInspected: 1 }], provider: { type: "static", targets: [{ ...target, ruleOverrides: { custom: { enabled: false, minimumInspected: 2 } } }] } });
  expect(parsed.ok).toBe(true);
});

async function commandConfig(base: Record<string, unknown>, targets: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-minimums-"));
  directories.push(directory);
  const executable = join(directory, "provider.sh");
  await writeFile(executable, `#!/bin/sh\necho '${JSON.stringify({ targets })}'\n`);
  await chmod(executable, 0o755);
  await writeFile(join(directory, "vlint.config.json"), JSON.stringify(withEnvironments({ ...base, provider: { type: "command", executable } })));
  return directory;
}

test("validates static target device minimums during ad-hoc runs", async () => {
  const directory = await config({
    devices: [device],
    rules: [{ name: "tabs", type: "tab-label-single-line" }],
    provider: { type: "static", targets: [{ ...target, deviceRuleMinimums: { tablet: { tabs: 2 } } }] },
  });
  const adHoc = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
  const configured = await resolveCheckPlan(directory, null, {});
  expect(adHoc.ok ? null : adHoc.failure).toMatchObject({ stage: "config", code: "config-schema-invalid", target: "home", device: "tablet" });
  expect(configured.ok ? null : configured.failure).toMatchObject({ stage: "config", code: "config-schema-invalid", target: "home", device: "tablet" });
});

test("classifies invalid command provider minimums as provider output invalid", async () => {
  const unknownDevice = await commandConfig(
    { devices: [device], rules: [{ name: "tabs", type: "tab-label-single-line" }] },
    [{ ...target, deviceRuleMinimums: { tablet: { tabs: 2 } } }],
  );
  const unresolvedDevice = await resolveCheckPlan(unknownDevice, null, {});
  expect(unresolvedDevice.ok ? null : unresolvedDevice.failure).toMatchObject({ stage: "provider", code: "provider-output-invalid", target: "home", device: "tablet" });

  const conflict = await commandConfig(
    { devices: [{ ...device, ruleMinimums: { tabs: 3 } }], rules: [{ name: "tabs", type: "tab-label-single-line" }] },
    [{ ...target, ruleOverrides: { tabs: { minimumInspected: 2 } } }],
  );
  const unresolvedConflict = await resolveCheckPlan(conflict, null, {});
  expect(unresolvedConflict.ok ? null : unresolvedConflict.failure).toMatchObject({ stage: "provider", code: "provider-output-invalid", target: "home", device: "desktop", rule: "tabs" });
});

test("plan resolution rejects conflicting minimums without a separate validation step", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 3 } }],
    rules: [{ name: "tabs", type: "tab-label-single-line" }],
    provider: { type: "static", targets: [{ ...target, ruleOverrides: { tabs: { minimumInspected: 2 } } }] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("invalid config");
  expect(resolveTargets(loaded.value, loaded.value.provider.targets)).toEqual({
    ok: false,
    violation: {
      reason: "conflicting-minimums",
      message: "target and device minimums conflict; specify deviceRuleMinimums",
      target: "home", device: "desktop", rule: "tabs",
    },
  });
});

test.each([
  { name: "undeclared", common: undefined, page: undefined, device: undefined, combined: undefined, expected: null },
  { name: "common", common: 1, page: undefined, device: undefined, combined: undefined, expected: 1 },
  { name: "target overrides common", common: 1, page: 2, device: undefined, combined: undefined, expected: 2 },
  { name: "device overrides common", common: 1, page: undefined, device: 3, combined: undefined, expected: 3 },
  { name: "equal target and device", common: 1, page: 2, device: 2, combined: undefined, expected: 2 },
  { name: "combination resolves conflict", common: 1, page: 2, device: 3, combined: 4, expected: 4 },
  { name: "combination overrides equal declarations", common: 1, page: 2, device: 2, combined: 4, expected: 4 },
  { name: "common zero", common: 0, page: undefined, device: undefined, combined: undefined, expected: 0 },
  { name: "target zero", common: 1, page: 0, device: undefined, combined: undefined, expected: 0 },
  { name: "device zero", common: 1, page: undefined, device: 0, combined: undefined, expected: 0 },
  { name: "equal zero", common: 1, page: 0, device: 0, combined: undefined, expected: 0 },
  { name: "combination zero resolves conflict", common: 1, page: 2, device: 3, combined: 0, expected: 0 },
])("resolves $name minimums through the plan interface", async (values) => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: values.device } }],
    rules: [{ name: "tabs", type: "tab-label-single-line", minimumInspected: values.common }],
    provider: { type: "static", targets: [{
      ...target,
      ruleOverrides: { tabs: { minimumInspected: values.page } },
      deviceRuleMinimums: { desktop: { tabs: values.combined } },
    }] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("invalid config");
  const resolved = resolveTargets(loaded.value, loaded.value.provider.targets);
  if (!resolved.ok) throw new Error(resolved.violation.message);
  expect(resolved.value.cases[0]?.rules.find((rule) => rule.name === "tabs")?.minimumInspected).toBe(values.expected);
  expect(resolved.value.targets[0]?.rules.find((rule) => rule.name === "tabs")?.minimumInspected).toBe(values.expected);
});

test("unknown devices take precedence over conflicts across all targets in either resolution path", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 3 } }],
    rules: [{ name: "tabs", type: "tab-label-single-line" }],
    provider: { type: "static", targets: [
      { ...target, ruleOverrides: { tabs: { minimumInspected: 2 } } },
      { name: "other", url: "https://example.com/other", deviceRuleMinimums: { tablet: { tabs: 1 }, watch: { tabs: 2 } } },
    ] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("invalid config");
  const expected = {
    ok: false,
    violation: { reason: "unknown-device", message: "unknown device minimum: tablet", target: "other", device: "tablet", rule: null },
  } as const;
  expect(resolveTargets(loaded.value, loaded.value.provider.targets)).toEqual(expected);
  expect(resolveAdHocTarget(loaded.value, "https://example.com/adhoc")).toEqual(expected);
});

test("ad-hoc resolution rejects conflicts in unused static targets", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 3 } }],
    rules: [{ name: "tabs", type: "tab-label-single-line" }],
    provider: { type: "static", targets: [{ ...target, ruleOverrides: { tabs: { minimumInspected: 0 } } }] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok) throw new Error("invalid config");
  expect(resolveAdHocTarget(loaded.value, "https://example.com/adhoc")).toMatchObject({
    ok: false, violation: { reason: "conflicting-minimums", target: "home", device: "desktop", rule: "tabs" },
  });
  const command = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
  expect(command.ok ? null : command.failure).toMatchObject({
    stage: "config", code: "config-schema-invalid", target: "home", device: "desktop", rule: "tabs",
  });
});

test("ad-hoc plans use only common and device minimums, not static target declarations", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { tabs: 3 } }, phone],
    rules: [{ name: "tabs", type: "tab-label-single-line", minimumInspected: 1 }],
    provider: { type: "static", targets: [{
      ...target, ruleOverrides: { tabs: { minimumInspected: 2 } },
      deviceRuleMinimums: { desktop: { tabs: 4 }, phone: { tabs: 5 } },
    }] },
  });
  const command = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
  if (!command.ok) throw new Error(command.failure.message);
  expect(command.value.plan.cases.map((audit) => ({
    name: audit.name, url: audit.url, minimum: audit.rules.find((rule) => rule.name === "tabs")?.minimumInspected,
  }))).toEqual([
    { name: "adhoc", url: "https://example.com/adhoc", minimum: 3 },
    { name: "adhoc", url: "https://example.com/adhoc", minimum: 1 },
  ]);
});

test("ad-hoc commands do not execute a configured command provider", async () => {
  const directory = await config({
    devices: [device],
    rules: [{ name: "tabs", type: "tab-label-single-line", minimumInspected: 1 }],
    provider: { type: "command", executable: "/does-not-exist/vlint-provider" },
  });
  const command = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
  if (!command.ok) throw new Error(command.failure.message);
  expect(command.value.plan.cases[0]).toMatchObject({ name: "adhoc", url: "https://example.com/adhoc" });
  expect(command.value.plan.cases[0]?.rules.find((rule) => rule.name === "tabs")?.minimumInspected).toBe(1);
});

test("local and disabled rules retain minimum resolution and conflict validation", async () => {
  const directory = await config({
    devices: [{ ...device, ruleMinimums: { custom: 3 } }, { ...phone, ruleMinimums: { custom: 3 } }],
    rules: [{ name: "custom", type: "local", path: "rules/missing.ts", minimumInspected: 1 }],
    provider: { type: "static", targets: [
      { ...target, ruleOverrides: { custom: { enabled: false, minimumInspected: 2 } }, deviceRuleMinimums: { desktop: { custom: 0 }, phone: { custom: 4 } } },
      { name: "other", url: "https://example.com/other", ruleOverrides: { custom: { enabled: false, minimumInspected: 2 } } },
    ] },
  });
  const loaded = await loadConfig(directory);
  if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("invalid config");
  const first = loaded.value.provider.targets[0]!;
  const resolved = resolveTargets(loaded.value, [first]);
  if (!resolved.ok) throw new Error(resolved.violation.message);
  expect(resolved.value.cases.map((audit) => audit.rules.find((rule) => rule.name === "custom"))).toEqual([
    expect.objectContaining({ type: "local", enabled: false, minimumInspected: 0 }),
    expect.objectContaining({ type: "local", enabled: false, minimumInspected: 4 }),
  ]);
  expect(resolveTargets(loaded.value, loaded.value.provider.targets)).toMatchObject({
    ok: false, violation: { reason: "conflicting-minimums", target: "other", device: "desktop", rule: "custom" },
  });
  const command = await resolveCheckPlan(directory, null, {});
  expect(command.ok ? null : command.failure).toMatchObject({
    stage: "config", code: "config-schema-invalid", target: "other", device: "desktop", rule: "custom",
  });
});
