import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/load";
import { mergeJsonSettings, resolveAdHocTarget, resolveTargets } from "../../src/config/merge";
import { parseConfig, parseAdHocUrl } from "../../src/config/schema";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(directory: string, value: unknown): Promise<void> {
  await Bun.write(join(directory, "vlint.config.json"), JSON.stringify(value));
}

const DESKTOP_DEVICE = {
  name: "desk",
  viewport: { width: 1470, height: 956 },
  screen: { width: 1470, height: 956 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
};

const MOBILE_DEVICE = {
  name: "phone",
  viewport: { width: 402, height: 681 },
  screen: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (TestPhone)",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("configuration", () => {
  test("loads a device-only config with deterministic presentation defaults", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, { devices: [DESKTOP_DEVICE] });
    const loaded = await loadConfig(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.provider).toBeUndefined();
    expect(loaded.value.devices.map((device) => device.name)).toEqual(["desk"]);
    expect(loaded.value.rules.map((rule) => rule.name)).toEqual([
      "tab-label-single-line",
      "page-horizontal-overflow",
      "table-header-single-line",
    ]);
    const plan = resolveAdHocTarget(loaded.value, "http://127.0.0.1:4173/adhoc");
    expect(plan.targets.map((target) => target.name)).toEqual(["adhoc"]);
    expect(plan.cases).toHaveLength(1);
    expect(plan.cases[0]).toMatchObject({
      name: "adhoc",
      url: "http://127.0.0.1:4173/adhoc",
      deviceName: "desk",
      viewport: { width: 1470, height: 956 },
      screen: { width: 1470, height: 956 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
      userAgent: null,
      locale: "en-US",
      timezoneId: "UTC",
      timeoutMs: 30_000,
      browserState: null,
      readyCondition: null,
    });
  });

  test("resolves two targets by two devices into four cases in target-major device-minor order", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
      provider: {
        type: "static",
        targets: [
          { name: "first", url: "http://127.0.0.1:4173/first" },
          { name: "second", url: "http://127.0.0.1:4173/second" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    if (loaded.value.provider === undefined || loaded.value.provider.type !== "static") {
      throw new Error("expected static provider");
    }
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.targets.map((target) => target.name)).toEqual(["first", "second"]);
    expect(plan.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual([
      "first/desk",
      "first/phone",
      "second/desk",
      "second/phone",
    ]);
    expect(plan.cases[1]).toMatchObject({
      viewport: { width: 402, height: 681 },
      isMobile: true,
      userAgent: "Mozilla/5.0 (TestPhone)",
    });
  });

  test("editing devices to one yields exactly one case per target", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE],
      provider: {
        type: "static",
        targets: [
          { name: "first", url: "http://127.0.0.1:4173/first" },
          { name: "second", url: "http://127.0.0.1:4173/second" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    if (loaded.value.provider === undefined || loaded.value.provider.type !== "static") {
      throw new Error("expected static provider");
    }
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual(["first/desk", "second/desk"]);
  });

  test("applies presentation defaults and rule overrides to every case regardless of device", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
      defaults: {
        locale: "fr-FR",
        timezoneId: "Europe/Paris",
        timeoutMs: 12_000,
        browserState: "state/auth.json",
        readyCondition: { selector: "#default", state: "hidden" },
      },
      rules: [
        {
          name: "tabs",
          type: "tab-label-single-line",
          additionalCandidateSelectors: [".tab"],
          excludeSelectors: [".global-exclude"],
          minimumLabels: 2,
        },
      ],
      provider: {
        type: "static",
        targets: [
          {
            name: "settings",
            url: "https://example.com/settings",
            ruleOverrides: { tabs: { excludeSelectors: [".target-exclude"], minimumLabels: 3 } },
          },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    if (loaded.value.provider === undefined || loaded.value.provider.type !== "static") {
      throw new Error("expected static provider");
    }
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    for (const c of plan.cases) {
      expect(c).toMatchObject({
        locale: "fr-FR",
        timezoneId: "Europe/Paris",
        timeoutMs: 12_000,
        browserState: join(directory, "state/auth.json"),
        readyCondition: { selector: "#default", state: "hidden" },
      });
      expect(c.rules[0]).toMatchObject({
        name: "tabs",
        enabled: true,
        additionalCandidateSelectors: [".tab"],
        excludeSelectors: [".global-exclude", ".target-exclude"],
        minimumLabels: 3,
        allowZeroLabels: false,
      });
    }
    expect(plan.cases[0]).toMatchObject({ deviceName: "desk", viewport: { width: 1470, height: 956 } });
    expect(plan.cases[1]).toMatchObject({ deviceName: "phone", viewport: { width: 402, height: 681 } });
  });

  test("ad hoc resolution builds cases from the URL, not the configured provider targets", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
      provider: {
        type: "static",
        targets: [
          { name: "ignored-a", url: "http://127.0.0.1:4173/a" },
          { name: "ignored-b", url: "http://127.0.0.1:4173/b" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    const plan = resolveAdHocTarget(loaded.value, "http://127.0.0.1:4173/adhoc");
    expect(plan.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual(["adhoc/desk", "adhoc/phone"]);
    expect(plan.targets.map((target) => target.name)).toEqual(["adhoc"]);
  });

  test("classifies config file failures before provider resolution", async () => {
    const missing = await loadConfig(await temporaryDirectory());
    expect(missing.ok ? null : missing.failure.code).toBe("config-not-found");

    const directoryConfig = await temporaryDirectory();
    await mkdir(join(directoryConfig, "vlint.config.json"));
    const directory = await loadConfig(directoryConfig);
    expect(directory.ok ? null : directory.failure.code).toBe("config-read-failed");

    const malformedDirectory = await temporaryDirectory();
    await Bun.write(join(malformedDirectory, "vlint.config.json"), "{");
    const malformed = await loadConfig(malformedDirectory);
    expect(malformed.ok ? null : malformed.failure.code).toBe("config-invalid-json");
  });

  test("accepts exactly 8 MiB and rejects one byte more", async () => {
    const minimal = JSON.stringify({devices: [DESKTOP_DEVICE] });
    const exactDirectory = await temporaryDirectory();
    await Bun.write(
      join(exactDirectory, "vlint.config.json"),
      minimal + " ".repeat(8 * 1024 * 1024 - Buffer.byteLength(minimal)),
    );
    expect((await loadConfig(exactDirectory)).ok).toBe(true);

    const oversizedDirectory = await temporaryDirectory();
    await Bun.write(
      join(oversizedDirectory, "vlint.config.json"),
      minimal + " ".repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength(minimal)),
    );
    const oversized = await loadConfig(oversizedDirectory);
    expect(oversized.ok ? null : oversized.failure.code).toBe("config-too-large");
  });

  test.each([
    ["schemaVersion field", { schemaVersion: 1, devices: [DESKTOP_DEVICE] }],
    ["schemaVersion field with value 4", { schemaVersion: 4, devices: [DESKTOP_DEVICE] }],
    ["unknown field", { devices: [DESKTOP_DEVICE], nope: true }],
    ["missing devices", {}],
    ["empty devices", {devices: [] }],
    ["devices not an array", {devices: "desk" }],
    [
      "duplicate device name",
      {devices: [DESKTOP_DEVICE, { ...DESKTOP_DEVICE, viewport: { width: 10, height: 10 } }] },
    ],
    [
      "device missing screen",
      {
devices: [
          { name: "d", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        ],
      },
    ],
    ["device unknown field", {devices: [{ ...DESKTOP_DEVICE, extra: 1 }] }],
    ["invalid device viewport", {devices: [{ ...DESKTOP_DEVICE, viewport: { width: 0, height: 10 } }] }],
    ["invalid device screen", {devices: [{ ...DESKTOP_DEVICE, screen: { width: 10, height: 0 } }] }],
    ["out-of-range device DPR", {devices: [{ ...DESKTOP_DEVICE, deviceScaleFactor: 0.01 }] }],
    ["isMobile not boolean", {devices: [{ ...DESKTOP_DEVICE, isMobile: "yes" }] }],
    ["hasTouch not boolean", {devices: [{ ...DESKTOP_DEVICE, hasTouch: 1 }] }],
    ["empty userAgent", {devices: [{ ...DESKTOP_DEVICE, userAgent: "" }] }],
    [
      "duplicate target",
      {
devices: [DESKTOP_DEVICE],
        provider: {
          type: "static",
          targets: [
            { name: "same", url: "https://example.com/1" },
            { name: "same", url: "https://example.com/2" },
          ],
        },
      },
    ],
    ["empty static targets", {devices: [DESKTOP_DEVICE], provider: { type: "static", targets: [] } }],
    [
      "unknown rule override",
      {
devices: [DESKTOP_DEVICE],
        provider: {
          type: "static",
          targets: [{ name: "x", url: "https://example.com", ruleOverrides: { missing: { enabled: false } } }],
        },
      },
    ],
    [
      "URL userinfo",
      {
devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "https://u:p@example.com" }] },
      },
    ],
    [
      "relative URL",
      {
devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "/relative" }] },
      },
    ],
    [
      "unsupported URL",
      {
devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "file:///tmp/x" }] },
      },
    ],
    [
      "target viewport no longer accepted",
      {
devices: [DESKTOP_DEVICE],
        provider: {
          type: "static",
          targets: [{ name: "x", url: "https://example.com", viewport: { width: 800, height: 600 } }],
        },
      },
    ],
    [
      "defaults viewport no longer accepted",
      {
devices: [DESKTOP_DEVICE],
        defaults: { viewport: { width: 800, height: 600 } },
        provider: { type: "static", targets: [{ name: "x", url: "https://example.com" }] },
      },
    ],
  ])("rejects %s", (_name, value) => {
    const parsed = parseConfig(value);
    expect(parsed.ok ? null : parsed.failure.code).toBe("config-schema-invalid");
  });

  test("accepts an optional provider and omits it from the loaded config", () => {
    const parsed = parseConfig({devices: [DESKTOP_DEVICE] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.provider).toBeUndefined();
    expect(parsed.value.devices).toHaveLength(1);
  });

  test("enforces name, URL, and selector byte boundaries", () => {
    const base = {
devices: [{ ...DESKTOP_DEVICE, name: "d".repeat(1024) }],
      rules: [{ name: "r", type: "tab-label-single-line", labelSelector: "x".repeat(64 * 1024) }],
      provider: { type: "static", targets: [{ name: "n".repeat(1024), url: "https://example.com" }] },
    };
    expect(parseConfig(base).ok).toBe(true);
    expect(parseConfig({ ...base, devices: [{ ...DESKTOP_DEVICE, name: "d".repeat(1025) }] }).ok).toBe(false);
    expect(
      parseConfig({
        ...base,
        provider: { type: "static", targets: [{ name: "n".repeat(1025), url: "https://example.com" }] },
      }).ok,
    ).toBe(false);
    expect(parseConfig({ ...base, rules: [{ ...base.rules[0], labelSelector: "x".repeat(64 * 1024 + 1) }] }).ok).toBe(false);
  });

  test("validates ad hoc URL with the same URL policy", () => {
    expect(parseAdHocUrl("https://example.com/path").ok).toBe(true);
    expect(parseAdHocUrl("https://user@example.com/path").ok).toBe(false);
  });
  test("injects missing built-ins in tab-then-configured-then-overflow order", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE],
      rules: [{ name: "wide-page", type: "page-horizontal-overflow", tolerancePx: 4 }],
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    expect(loaded.value.rules).toEqual([
      {
        name: "tab-label-single-line",
        type: "tab-label-single-line",
        enabled: true,
        additionalCandidateSelectors: [],
        excludeSelectors: [],
        labelSelector: null,
        minimumLabels: 0,
        allowZeroLabels: false,
      },
      {
        name: "wide-page",
        type: "page-horizontal-overflow",
        enabled: true,
        tolerancePx: 4,
      },
      {
        name: "table-header-single-line",
        type: "table-header-single-line",
        enabled: true,
        additionalCandidateSelectors: [],
        excludeSelectors: [],
        lineTopTolerancePx: 1,
        minimumHeaders: 0,
        allowZeroHeaders: true,
      },
    ]);
  });

  test("applies overflow project and target enablement precedence", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE],
      rules: [{ name: "overflow", type: "page-horizontal-overflow", enabled: false }],
      provider: {
        type: "static",
        targets: [
          {
            name: "enabled-target",
            url: "https://example.com",
            ruleOverrides: { overflow: { enabled: true } },
          },
          { name: "disabled-target", url: "https://example.com/disabled" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("expected loaded static config");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.cases[0]?.rules.find((rule) => rule.name === "overflow")?.enabled).toBe(true);
    expect(plan.cases[1]?.rules.find((rule) => rule.name === "overflow")?.enabled).toBe(false);
  });

  test("preserves an explicit false target override for an enabled overflow rule", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
devices: [DESKTOP_DEVICE],
      rules: [{ name: "overflow", type: "page-horizontal-overflow" }],
      provider: {
        type: "static",
        targets: [
          {
            name: "disabled-target",
            url: "https://example.com",
            ruleOverrides: { overflow: { enabled: false } },
          },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("expected loaded static config");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.cases[0]?.rules.find((rule) => rule.name === "overflow")?.enabled).toBe(false);
  });

  test.each([
    ["duplicate rule type", [{ name: "a", type: "page-horizontal-overflow" }, { name: "b", type: "page-horizontal-overflow" }]],
    ["overflow tab field", [{ name: "overflow", type: "page-horizontal-overflow", excludeSelectors: [".x"] }]],
    ["tab overflow field", [{ name: "tabs", type: "tab-label-single-line", tolerancePx: 1 }]],
    ["negative tolerance", [{ name: "overflow", type: "page-horizontal-overflow", tolerancePx: -1 }]],
    ["excessive tolerance", [{ name: "overflow", type: "page-horizontal-overflow", tolerancePx: 101 }]],
    ["non-finite tolerance", [{ name: "overflow", type: "page-horizontal-overflow", tolerancePx: Number.POSITIVE_INFINITY }]],
  ])("rejects %s", (_name, rules) => {
    expect(parseConfig({devices: [DESKTOP_DEVICE], rules }).ok).toBe(false);
  });

  test("accepts multiple named tab rules", () => {
    expect(
      parseConfig({
devices: [DESKTOP_DEVICE],
        rules: [
          { name: "primary-tabs", type: "tab-label-single-line" },
          { name: "secondary-tabs", type: "tab-label-single-line" },
        ],
      }).ok,
    ).toBe(true);
  });

  test.each([0, 1, 100])("accepts overflow tolerance %p", (tolerancePx) => {
    expect(
      parseConfig({
devices: [DESKTOP_DEVICE],
        rules: [{ name: "overflow", type: "page-horizontal-overflow", tolerancePx }],
      }).ok,
    ).toBe(true);
  });

  test("validates target overrides against the referenced rule type", () => {
    const base = {
devices: [DESKTOP_DEVICE],
      rules: [{ name: "overflow", type: "page-horizontal-overflow" }],
    };
    expect(
      parseConfig({
        ...base,
        provider: {
          type: "static",
          targets: [{
            name: "bad",
            url: "https://example.com",
            ruleOverrides: { overflow: { minimumLabels: 1 } },
          }],
        },
      }).ok,
    ).toBe(false);
  });

  test("accepts a config with one local declaration and injects built-ins", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE],
      rules: [
        {
          name: "spacing",
          type: "local",
          path: "rules/spacing.ts",
          settings: { tolerancePx: 4 },
        },
      ],
    });
    const loaded = await loadConfig(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.rules.map((rule) => `${rule.name}:${rule.type}`)).toEqual([
      "tab-label-single-line:tab-label-single-line",
      "spacing:local",
      "page-horizontal-overflow:page-horizontal-overflow",
      "table-header-single-line:table-header-single-line",
    ]);
    const local = loaded.value.rules.find((rule) => rule.type === "local");
    expect(local).toMatchObject({
      name: "spacing",
      path: "rules/spacing.ts",
      settings: { tolerancePx: 4 },
      enabled: true,
    });
  });

  test.each([
    [
      "duplicate local name",
      {
        devices: [DESKTOP_DEVICE],
        rules: [
          { name: "dup", type: "local", path: "rules/a.ts" },
          { name: "dup", type: "local", path: "rules/b.ts" },
        ],
      },
    ],
    [
      "missing local path",
      {devices: [DESKTOP_DEVICE], rules: [{ name: "spacing", type: "local" }] },
    ],
    [
      "unknown local field",
      {
        devices: [DESKTOP_DEVICE],
        rules: [{ name: "spacing", type: "local", path: "rules/spacing.ts", extra: true }],
      },
    ],
    [
      "non-json settings",
      {
        devices: [DESKTOP_DEVICE],
        rules: [{ name: "spacing", type: "local", path: "rules/spacing.ts", settings: "bad" }],
      },
    ],
    [
      "absolute local path",
      {
        devices: [DESKTOP_DEVICE],
        rules: [{ name: "spacing", type: "local", path: "/etc/passwd" }],
      },
    ],
    [
      "escaping local path",
      {
        devices: [DESKTOP_DEVICE],
        rules: [{ name: "spacing", type: "local", path: "../outside.ts" }],
      },
    ],
  ])("rejects invalid local config: %s", (_name, value) => {
    const parsed = parseConfig(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.code).toBe("config-schema-invalid");
  });

  test("accepts structural local target overrides with enabled and settings overlay", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE],
      rules: [
        {
          name: "spacing",
          type: "local",
          path: "rules/spacing.ts",
          settings: { shell: { gap: 8 }, enabledPairs: ["desktop"] },
        },
      ],
      provider: {
        type: "static",
        targets: [
          {
            name: "settings",
            url: "https://example.com/settings",
            ruleOverrides: {
              spacing: {
                enabled: false,
                settings: { shell: { gap: 4 }, extra: true },
              },
            },
          },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("expected loaded static config");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    const local = plan.cases[0]?.rules.find((rule) => rule.type === "local");
    expect(local).toMatchObject({
      name: "spacing",
      enabled: false,
      settings: { shell: { gap: 4 }, enabledPairs: ["desktop"], extra: true },
    });
  });

  test("rejects prototype keys in settings and never mutates Object.prototype", () => {
    const pollutedBefore = (Object.prototype as { polluted?: boolean }).polluted;
    const settings = Object.create(null) as Record<string, unknown>;
    settings.__proto__ = { polluted: true };
    expect(
      parseConfig({
        devices: [DESKTOP_DEVICE],
        rules: [
          {
            name: "spacing",
            type: "local",
            path: "rules/spacing.ts",
            settings,
          },
        ],
      }).ok,
    ).toBe(false);
    expect((Object.prototype as { polluted?: boolean }).polluted).toBe(pollutedBefore);
    expect(
      parseConfig({
        devices: [DESKTOP_DEVICE],
        rules: [
          {
            name: "spacing",
            type: "local",
            path: "rules/spacing.ts",
            settings: { nested: { constructor: { polluted: true } } },
          },
        ],
      }).ok,
    ).toBe(false);
  });

  test("mergeJsonSettings uses prototype-safe recursive object merge", () => {
    const merged = mergeJsonSettings(
      { shell: { gap: 8, mode: "strict" }, tags: ["a"] },
      { shell: { gap: 4 }, tags: ["b"], added: 1 },
    );
    expect(merged).toEqual({
      shell: { gap: 4, mode: "strict" },
      tags: ["b"],
      added: 1,
    });
    expect(Object.getPrototypeOf(merged)).toBeNull();
  });

  test("resolves no-rule config to tab, overflow, then table defaults with table defaults materialized", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, { devices: [DESKTOP_DEVICE] });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    const table = loaded.value.rules.find((rule) => rule.type === "table-header-single-line");
    expect(table).toEqual({
      name: "table-header-single-line",
      type: "table-header-single-line",
      enabled: true,
      additionalCandidateSelectors: [],
      excludeSelectors: [],
      lineTopTolerancePx: 1,
      minimumHeaders: 0,
      allowZeroHeaders: true,
    });
  });

  test("materializes a complete explicit table rule and suppresses the injected default", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE],
      rules: [
        {
          name: "tables",
          type: "table-header-single-line",
          additionalCandidateSelectors: ["[data-table-header]"],
          excludeSelectors: [".intentional-wrap"],
          lineTopTolerancePx: 2,
          minimumHeaders: 1,
          allowZeroHeaders: false,
        },
      ],
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    expect(loaded.value.rules).toEqual([
      expect.objectContaining({ name: "tab-label-single-line" }),
      {
        name: "tables",
        type: "table-header-single-line",
        enabled: true,
        additionalCandidateSelectors: ["[data-table-header]"],
        excludeSelectors: [".intentional-wrap"],
        lineTopTolerancePx: 2,
        minimumHeaders: 1,
        allowZeroHeaders: false,
      },
      expect.objectContaining({ name: "page-horizontal-overflow" }),
    ]);
  });

  test.each([
    ["unknown field", { extra: true }],
    ["negative tolerance", { lineTopTolerancePx: -0.5 }],
    ["excessive tolerance", { lineTopTolerancePx: 101 }],
    ["non-finite tolerance", { lineTopTolerancePx: Number.POSITIVE_INFINITY }],
    ["negative minimum headers", { minimumHeaders: -1 }],
    ["non-integer minimum headers", { minimumHeaders: 1.5 }],
    ["non-boolean zero coverage", { allowZeroHeaders: "yes" }],
    ["overflow field on table rule", { tolerancePx: 1 }],
  ])("rejects invalid table rule: %s", (_name, fields) => {
    const parsed = parseConfig({
      devices: [DESKTOP_DEVICE],
      rules: [{ name: "tables", type: "table-header-single-line", ...fields }],
    });
    expect(parsed.ok ? null : parsed.failure.code).toBe("config-schema-invalid");
  });

  test("permits multiple named table rules without injecting a second default", () => {
    const parsed = parseConfig({
      devices: [DESKTOP_DEVICE],
      rules: [
        { name: "primary-tables", type: "table-header-single-line" },
        { name: "strict-tables", type: "table-header-single-line", allowZeroHeaders: false },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  test("accepts selector strings at schema time and defers CSS validity to evaluation", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE],
      rules: [
        {
          name: "tables",
          type: "table-header-single-line",
          additionalCandidateSelectors: ["th[scope="],
          excludeSelectors: ["###not-a-selector"],
        },
      ],
    });
    const loaded = await loadConfig(directory);
    expect(loaded.ok).toBe(true);
  });

  test("merges target exclusions after instance exclusions, replaces the target minimum, and keeps zero coverage instance-scoped", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
      rules: [
        {
          name: "tables",
          type: "table-header-single-line",
          excludeSelectors: [".global-exclude"],
          minimumHeaders: 1,
          allowZeroHeaders: true,
        },
      ],
      provider: {
        type: "static",
        targets: [
          {
            name: "settings",
            url: "https://example.com/settings",
            ruleOverrides: { tables: { excludeSelectors: [".target-exclude"], minimumHeaders: 3 } },
          },
          { name: "plain", url: "https://example.com/plain" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("expected loaded static config");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    for (const c of plan.cases) {
      if (c.name === "settings") {
        expect(c.rules.find((rule) => rule.name === "tables")).toMatchObject({
          enabled: true,
          excludeSelectors: [".global-exclude", ".target-exclude"],
          minimumHeaders: 3,
          allowZeroHeaders: true,
        });
      } else {
        expect(c.rules.find((rule) => rule.name === "tables")).toMatchObject({
          enabled: true,
          excludeSelectors: [".global-exclude"],
          minimumHeaders: 1,
          allowZeroHeaders: true,
        });
      }
    }
  });

  test("applies an explicit false table target override to disable the rule per target", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      devices: [DESKTOP_DEVICE],
      rules: [{ name: "tables", type: "table-header-single-line" }],
      provider: {
        type: "static",
        targets: [
          { name: "kept", url: "https://example.com/kept" },
          {
            name: "off",
            url: "https://example.com/off",
            ruleOverrides: { tables: { enabled: false } },
          },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok || loaded.value.provider?.type !== "static") throw new Error("expected loaded static config");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.cases[0]?.rules.find((rule) => rule.name === "tables")?.enabled).toBe(true);
    expect(plan.cases[1]?.rules.find((rule) => rule.name === "tables")?.enabled).toBe(false);
  });

  test("validates table target overrides against the restricted key set", () => {
    const base = {
      devices: [DESKTOP_DEVICE],
      rules: [{ name: "tables", type: "table-header-single-line" }],
    };
    expect(
      parseConfig({
        ...base,
        provider: {
          type: "static",
          targets: [{
            name: "bad",
            url: "https://example.com",
            ruleOverrides: { tables: { allowZeroHeaders: false } },
          }],
        },
      }).ok,
    ).toBe(false);
  });
});
