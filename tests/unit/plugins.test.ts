import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLUGIN_CONTRACT_VERSION } from "../../src/contracts/plugins";
import {
  loadLocalPluginRegistry,
  loadPluginContract,
  localPluginsConfigured,
  transpilePluginCallbackSource,
} from "../../src/plugins/load";
import { validatePluginSettings } from "../../src/plugins/schema";
import type { LoadedConfig } from "../../src/contracts/config";
import { resolveTargets } from "../../src/config/merge";
import { MAX_PLUGIN_SOURCE_BYTES } from "../../src/plugins/types";

const fixtureRoot = join(import.meta.dir, "../fixtures/plugins");
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-plugins-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function loadedConfig(directory: string, rules: LoadedConfig["rules"]): LoadedConfig {
  return {
    path: join(directory, "vlint.config.json"),
    directory,
    schemaVersion: 3,
    devices: [
      {
        name: "desk",
        viewport: { width: 1280, height: 800 },
        screen: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    ],
    defaults: {},
    rules,
  };
}

async function copyFixture(directory: string, name: string, targetName = name): Promise<string> {
  const source = join(fixtureRoot, name);
  const target = join(directory, targetName);
  await writeFile(target, await readFile(source));
  return targetName;
}

describe("plugin loader", () => {
  test("loads a valid plugin and validates base settings", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "valid-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "spacing-check",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.descriptor.contractVersion).toBe(PLUGIN_CONTRACT_VERSION);
    expect(loaded.value.descriptor.metadata.name).toBe("spacing-check");
    expect(loaded.value.descriptor.evaluateSource).toContain("async (context");
    expect(loaded.value.finalize).not.toBeNull();
    const settings = validatePluginSettings(
      loaded.value.descriptor.settingsSchema,
      { tolerance: 1 },
      "rules.spacing-check.settings",
      "spacing-check",
    );
    expect(settings.ok).toBe(true);
  });

  test("rejects invalid base settings before browser launch", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "valid-rule.ts");
    const config = loadedConfig(directory, [
      {
        name: "spacing-check",
        type: "local",
        enabled: true,
        path,
        settings: { tolerance: "bad" },
      },
    ]);
    const registry = await loadLocalPluginRegistry(config);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.failure.code).toBe("plugin-settings-invalid");
    expect(registry.failure.message).toContain("rules.spacing-check.settings.tolerance");
  });

  test("validates command-provider target overrides after provider resolution", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "valid-rule.ts");
    const providerScript = join(directory, "provider.sh");
    await writeFile(
      providerScript,
      `#!/bin/sh\necho '{"targets":[{"name":"settings","url":"https://example.com","ruleOverrides":{"spacing-check":{"settings":{"tolerance":2}}}}]}'\n`,
    );
    await chmod(providerScript, 0o755);
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 3,
        devices: [
          {
            name: "desk",
            viewport: { width: 1280, height: 800 },
            screen: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
          },
        ],
        provider: { type: "command", executable: providerScript },
        rules: [{ name: "spacing-check", type: "local", path, settings: { tolerance: 1 } }],
      }),
    );
    const { resolveCheckPlan } = await import("../../src/commands/check");
    const resolved = await resolveCheckPlan(directory, null, {});
    expect(resolved.ok).toBe(true);
  });

  test("rejects forbidden relative imports", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "imported-rule.ts");
    await copyFixture(directory, "helper.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "imported",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-dependency-forbidden");
  });

  test("rejects re-export runtime dependencies", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "reexport-rule.ts");
    await copyFixture(directory, "helper.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "reexport",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-dependency-forbidden");
    expect(loaded.failure.message).toContain("./helper");
  });

  test("rejects dynamic import() runtime dependencies", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "dynamic-import-rule.ts");
    await copyFixture(directory, "helper.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "dynamic-import",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-dependency-forbidden");
    expect(loaded.failure.message).toContain("./helper");
  });

  test("rejects require() runtime dependencies", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "require-rule.ts");
    await copyFixture(directory, "helper.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "require-rule",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-dependency-forbidden");
    expect(loaded.failure.message).toContain("./helper");
  });

  test("allows type-only imports reported by the scanner", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "type-only-rule.ts");
    await copyFixture(directory, "types-only.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "type-only",
    });
    expect(loaded.ok).toBe(true);
  });

  test("rejects contract version mismatch", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "contract-mismatch-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "mismatch",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-contract-version-mismatch");
  });

  test("maps top-level throws to plugin-load-failed", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "throwing-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "throwing",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-load-failed");
  });

  test("rejects malformed exports", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "malformed-rule.ts");
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: path,
      ruleName: "malformed",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-contract-invalid");
  });

  test("rejects missing plugin files", async () => {
    const directory = await temporaryDirectory();
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "missing.ts",
      ruleName: "missing",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-file-not-found");
  });

  test("rejects parent-escaping and absolute paths", async () => {
    const directory = await temporaryDirectory();
    const outside = await loadPluginContract({
      configDirectory: directory,
      relativePath: "../outside.ts",
      ruleName: "outside",
    });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.failure.code).toBe("plugin-path-invalid");

    const absolute = await loadPluginContract({
      configDirectory: directory,
      relativePath: "/tmp/rule.ts",
      ruleName: "absolute",
    });
    expect(absolute.ok).toBe(false);
    if (absolute.ok) return;
    expect(absolute.failure.code).toBe("plugin-path-invalid");
  });

  test("rejects symlinked plugin paths", async () => {
    const directory = await temporaryDirectory();
    const real = join(directory, "real-rule.ts");
    await copyFixture(directory, "valid-rule.ts", "real-rule.ts");
    const link = join(directory, "linked-rule.ts");
    await symlink(real, link);
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "linked-rule.ts",
      ruleName: "linked",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-path-invalid");
  });

  test("rejects sources larger than 8 MiB", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "huge.ts");
    await writeFile(path, `export default { contractVersion: 1, metadata: { name: "huge" }, settingsSchema: { type: "object", exactKeys: [] }, evaluate: async () => ({ elementsInspected: 0, violations: [] }) };${" ".repeat(MAX_PLUGIN_SOURCE_BYTES)}`);
    const loaded = await loadPluginContract({
      configDirectory: directory,
      relativePath: "huge.ts",
      ruleName: "huge",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.failure.code).toBe("plugin-source-too-large");
  });

  test("executes the verified snapshot even when the project file changes after read", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "race.ts");
    await writeFile(path, await readFile(join(fixtureRoot, "valid-rule.ts")));
    const first = await loadPluginContract({
      configDirectory: directory,
      relativePath: "race.ts",
      ruleName: "spacing-check",
    });
    await writeFile(path, await readFile(join(fixtureRoot, "contract-mismatch-rule.ts")));
    const second = await loadPluginContract({
      configDirectory: directory,
      relativePath: "race.ts",
      ruleName: "spacing-check",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.code).toBe("plugin-contract-version-mismatch");
  });

  test("does not invoke the loader for built-in-only configs", async () => {
    const directory = await temporaryDirectory();
    const config = loadedConfig(directory, [
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
    ]);
    expect(localPluginsConfigured(config.rules)).toBe(false);
    const registry = await loadLocalPluginRegistry(config);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value).toBeNull();
  });

  test("shares one loaded contract for duplicate paths with separate names", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "valid-rule.ts");
    const config = loadedConfig(directory, [
      { name: "spacing-a", type: "local", enabled: true, path, settings: { tolerance: 1 } },
      { name: "spacing-b", type: "local", enabled: true, path, settings: { tolerance: 2 } },
    ]);
    const registry = await loadLocalPluginRegistry(config);
    expect(registry.ok).toBe(true);
    if (!registry.ok || registry.value === null) return;
    expect(registry.value.get("spacing-a")).toBe(registry.value.get("spacing-b"));
  });

  test("rejects invalid effective target settings after merge", async () => {
    const directory = await temporaryDirectory();
    const path = await copyFixture(directory, "valid-rule.ts");
    const config = loadedConfig(directory, [
      { name: "spacing-check", type: "local", enabled: true, path, settings: { tolerance: 1 } },
    ]);
    const plan = resolveTargets(config, [
      {
        name: "settings",
        url: "https://example.com",
        ruleOverrides: { "spacing-check": { settings: { tolerance: "bad" } } },
      },
    ]);
    const registry = await loadLocalPluginRegistry(config);
    expect(registry.ok).toBe(true);
    if (!registry.ok || registry.value === null) return;
    const { validateEffectiveLocalSettings } = await import("../../src/plugins/load");
    const effective = validateEffectiveLocalSettings(registry.value, plan);
    expect(effective.ok).toBe(false);
  });

  test("transpilePluginCallbackSource preserves callbacks with interior semicolons", () => {
    const source =
      'async (ctx) => { for (let i = 0; i < 1; i++) { const msg = "a; b"; return { elementsInspected: 0, violations: [] }; } }';
    const transpiled = transpilePluginCallbackSource(source);
    expect(transpiled).toContain("for (let i = 0");
    expect(transpiled).toContain('const msg = "a; b"');
    expect(transpiled).toContain("elementsInspected: 0");
  });
});

describe("compiled plugin loader feasibility", () => {
  const binary = join(import.meta.dir, "../../dist/vlint-linux-x64");

  test.skipIf(!existsSync(binary))(
    "compiled linux artifact loads a valid descriptor and maps top-level throws",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "vlint-plugin-feasibility-"));
      try {
        const validPath = await copyFixture(directory, "valid-rule.ts");
        const valid = await loadPluginContract({
          configDirectory: directory,
          relativePath: validPath,
          ruleName: "spacing-check",
          executablePath: binary,
        });
        expect(valid.ok).toBe(true);

        const throwPath = await copyFixture(directory, "throwing-rule.ts");
        const thrown = await loadPluginContract({
          configDirectory: directory,
          relativePath: throwPath,
          ruleName: "throwing",
          executablePath: binary,
        });
        expect(thrown.ok).toBe(false);
        if (thrown.ok) return;
        expect(thrown.failure.code).toBe("plugin-load-failed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
