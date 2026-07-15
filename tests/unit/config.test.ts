import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/load";
import { resolveAdHocTarget, resolveTargets } from "../../src/config/merge";
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
  test("loads a device-only version 2 config with deterministic presentation defaults", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, { schemaVersion: 2, devices: [DESKTOP_DEVICE] });
    const loaded = await loadConfig(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.provider).toBeUndefined();
    expect(loaded.value.devices.map((device) => device.name)).toEqual(["desk"]);
    expect(loaded.value.rules.map((rule) => rule.name)).toEqual(["tab-label-single-line"]);
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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
    const minimal = JSON.stringify({ schemaVersion: 2, devices: [DESKTOP_DEVICE] });
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
    ["version 1 config", { schemaVersion: 1, devices: [DESKTOP_DEVICE] }],
    ["version 3 config", { schemaVersion: 3, devices: [DESKTOP_DEVICE] }],
    ["unknown field", { schemaVersion: 2, devices: [DESKTOP_DEVICE], nope: true }],
    ["missing devices", { schemaVersion: 2 }],
    ["empty devices", { schemaVersion: 2, devices: [] }],
    ["devices not an array", { schemaVersion: 2, devices: "desk" }],
    [
      "duplicate device name",
      { schemaVersion: 2, devices: [DESKTOP_DEVICE, { ...DESKTOP_DEVICE, viewport: { width: 10, height: 10 } }] },
    ],
    [
      "device missing screen",
      {
        schemaVersion: 2,
        devices: [
          { name: "d", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        ],
      },
    ],
    ["device unknown field", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, extra: 1 }] }],
    ["invalid device viewport", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, viewport: { width: 0, height: 10 } }] }],
    ["invalid device screen", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, screen: { width: 10, height: 0 } }] }],
    ["out-of-range device DPR", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, deviceScaleFactor: 0.01 }] }],
    ["isMobile not boolean", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, isMobile: "yes" }] }],
    ["hasTouch not boolean", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, hasTouch: 1 }] }],
    ["empty userAgent", { schemaVersion: 2, devices: [{ ...DESKTOP_DEVICE, userAgent: "" }] }],
    [
      "duplicate target",
      {
        schemaVersion: 2,
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
    ["empty static targets", { schemaVersion: 2, devices: [DESKTOP_DEVICE], provider: { type: "static", targets: [] } }],
    [
      "unknown rule override",
      {
        schemaVersion: 2,
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
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "https://u:p@example.com" }] },
      },
    ],
    [
      "relative URL",
      {
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "/relative" }] },
      },
    ],
    [
      "unsupported URL",
      {
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE],
        provider: { type: "static", targets: [{ name: "x", url: "file:///tmp/x" }] },
      },
    ],
    [
      "target viewport no longer accepted",
      {
        schemaVersion: 2,
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
        schemaVersion: 2,
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
    const parsed = parseConfig({ schemaVersion: 2, devices: [DESKTOP_DEVICE] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.provider).toBeUndefined();
    expect(parsed.value.devices).toHaveLength(1);
  });

  test("enforces name, URL, and selector byte boundaries", () => {
    const base = {
      schemaVersion: 2,
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
});
