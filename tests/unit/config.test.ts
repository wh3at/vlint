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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("configuration", () => {
  test("loads minimal static config with deterministic built-in defaults", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      schemaVersion: 1,
      provider: {
        type: "static",
        targets: [
          { name: "first", url: "http://127.0.0.1:4173/first" },
          { name: "second", url: "http://127.0.0.1:4173/second" },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.rules.map((rule) => rule.name)).toEqual(["tab-label-single-line"]);
    if (loaded.value.provider.type !== "static") throw new Error("expected static provider");
    const plan = resolveTargets(loaded.value, loaded.value.provider.targets);
    expect(plan.targets.map((target) => target.name)).toEqual(["first", "second"]);
    expect(plan.targets[0]).toMatchObject({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      timeoutMs: 30_000,
      browserState: null,
      readyCondition: null,
    });
  });

  test("applies whole-object defaults and field-level rule overrides", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      schemaVersion: 1,
      defaults: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
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
            viewport: { width: 800, height: 600 },
            readyCondition: { selector: "#target" },
            ruleOverrides: {
              tabs: { excludeSelectors: [".target-exclude"], minimumLabels: 3 },
            },
          },
        ],
      },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    if (loaded.value.provider.type !== "static") throw new Error("expected static provider");
    const target = resolveTargets(loaded.value, loaded.value.provider.targets).targets[0];
    expect(target).toMatchObject({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      timeoutMs: 12_000,
      browserState: join(directory, "state/auth.json"),
      readyCondition: { selector: "#target", state: "visible" },
    });
    expect(target?.rules[0]).toMatchObject({
      name: "tabs",
      enabled: true,
      additionalCandidateSelectors: [".tab"],
      excludeSelectors: [".global-exclude", ".target-exclude"],
      minimumLabels: 3,
      allowZeroLabels: false,
    });
  });

  test("ad hoc resolution uses defaults and rules without provider targets", async () => {
    const directory = await temporaryDirectory();
    await writeConfig(directory, {
      schemaVersion: 1,
      defaults: { viewport: { width: 900, height: 700 } },
      provider: { type: "command", executable: "/does/not/run" },
    });
    const loaded = await loadConfig(directory);
    if (!loaded.ok) throw new Error(loaded.failure.message);
    const plan = resolveAdHocTarget(loaded.value, "http://127.0.0.1:4173/adhoc");
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ name: "adhoc", viewport: { width: 900, height: 700 } });
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
    const minimal = JSON.stringify({
      schemaVersion: 1,
      provider: { type: "static", targets: [{ name: "x", url: "https://example.com" }] },
    });
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
    ["unknown field", { schemaVersion: 1, nope: true, provider: { type: "static", targets: [] } }],
    [
      "duplicate target",
      {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [
            { name: "same", url: "https://example.com/1" },
            { name: "same", url: "https://example.com/2" },
          ],
        },
      },
    ],
    [
      "unknown rule override",
      {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [
            {
              name: "x",
              url: "https://example.com",
              ruleOverrides: { missing: { enabled: false } },
            },
          ],
        },
      },
    ],
    [
      "URL userinfo",
      {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "x", url: "https://u:p@example.com" }] },
      },
    ],
    [
      "relative URL",
      {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "x", url: "/relative" }] },
      },
    ],
    [
      "unsupported URL",
      {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "x", url: "file:///tmp/x" }] },
      },
    ],
    [
      "invalid viewport",
      {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [{ name: "x", url: "https://example.com", viewport: { width: 0, height: 10 } }],
        },
      },
    ],
    [
      "invalid browser state",
      {
        schemaVersion: 1,
        defaults: { browserState: "bad\0path" },
        provider: { type: "static", targets: [{ name: "x", url: "https://example.com" }] },
      },
    ],
  ])("rejects %s", (_name, value) => {
    const parsed = parseConfig(value);
    expect(parsed.ok ? null : parsed.failure.code).toBe("config-schema-invalid");
  });

  test("enforces name, URL, and selector byte boundaries", () => {
    const base = {
      schemaVersion: 1,
      rules: [
        {
          name: "r",
          type: "tab-label-single-line",
          labelSelector: "x".repeat(64 * 1024),
        },
      ],
      provider: {
        type: "static",
        targets: [{ name: "n".repeat(1024), url: "https://example.com" }],
      },
    };
    expect(parseConfig(base).ok).toBe(true);
    expect(parseConfig({ ...base, provider: { type: "static", targets: [{ name: "n".repeat(1025), url: "https://example.com" }] } }).ok).toBe(false);
    expect(parseConfig({ ...base, rules: [{ ...base.rules[0], labelSelector: "x".repeat(64 * 1024 + 1) }] }).ok).toBe(false);
  });

  test("validates ad hoc URL with the same URL policy", () => {
    expect(parseAdHocUrl("https://example.com/path").ok).toBe(true);
    expect(parseAdHocUrl("https://user@example.com/path").ok).toBe(false);
  });
});
