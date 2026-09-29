import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../../src/config/schema";
import { loadConfig } from "../../src/config/load";
import { resolveTargets } from "../../src/config/merge";
import { resolveCheckPlan } from "../../src/commands/check";

const device = { name: "desktop", viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const phone = { ...device, name: "phone", viewport: { width: 390, height: 600 }, screen: { width: 390, height: 600 } };
const target = { name: "home", url: "https://example.com/" };
const directories: string[] = [];

async function config(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-minimums-"));
  directories.push(directory);
  await writeFile(join(directory, "vlint.config.json"), JSON.stringify(value));
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
  const resolved = resolveTargets(loaded.value, loaded.value.provider.targets);
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
  await writeFile(join(directory, "vlint.config.json"), JSON.stringify({ ...base, provider: { type: "command", executable } }));
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
