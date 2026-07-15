import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devices as playwrightDevices } from "playwright";
import {
  buildStandardConfig,
  CONFIG_NAME,
  runInitCommand,
  type DeviceSource,
} from "../../src/commands/init";
import { parseConfig } from "../../src/config/schema";
import { loadConfig } from "../../src/config/load";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vlint init: standard config generation", () => {
  test("builds a two-device, no-provider, standard-rules version 2 config (AE1)", () => {
    const result = buildStandardConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.value;

    expect(config.schemaVersion).toBe(2);
    expect(config.provider).toBeUndefined();
    expect(config.devices).toHaveLength(2);
    expect(config.rules).toEqual([
      { name: "tab-label-single-line", type: "tab-label-single-line" },
      { name: "page-horizontal-overflow", type: "page-horizontal-overflow" },
    ]);

    const [macbook, iphone] = config.devices;
    expect(macbook).toEqual({
      name: "macbook-air-13-m5",
      viewport: { width: 1470, height: 956 },
      screen: { width: 1470, height: 956 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
    });
    expect(iphone).toEqual({
      name: "iphone-17",
      viewport: { width: 402, height: 681 },
      screen: { width: 402, height: 874 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: playwrightDevices["iPhone 17"].userAgent,
    });

    // MacBook keeps Chromium's default user agent (no userAgent field emitted).
    expect(JSON.stringify(macbook).includes("userAgent")).toBe(false);
    // Chromium-fixed: the WebKit defaultBrowserType must not leak into the config.
    expect(JSON.stringify(config).includes("defaultBrowserType")).toBe(false);
  });

  test("reuses the public Playwright registry as the default device source", () => {
    const result = buildStandardConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const iphone = result.value.devices[1]!;
    // The generated UA is the registry value, faithfully copied, not invented.
    expect(iphone.userAgent).toBe(playwrightDevices["iPhone 17"].userAgent);
    expect(iphone.userAgent!.startsWith("Mozilla/5.0 (iPhone")).toBe(true);
  });
});

describe("vlint init: standard device sourcing", () => {
  const validDescriptor: DeviceSource = {
    "iPhone 17": {
      userAgent: "Mozilla/5.0 (iPhone; Test) Mobile",
      viewport: { width: 402, height: 681 },
      screen: { width: 402, height: 874 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  };

  test("accepts a complete descriptor with a valid screen", () => {
    const result = buildStandardConfig(validDescriptor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.devices[1]).toMatchObject({
      name: "iphone-17",
      viewport: { width: 402, height: 681 },
      screen: { width: 402, height: 874 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
  });

  test("fails typed when the registry omits iPhone 17", () => {
    const result = buildStandardConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.stage).toBe("config");
    expect(result.failure.code).toBe("init-device-unavailable");
  });

  test("fails typed when the descriptor lacks a screen", () => {
    const noScreen: DeviceSource = {
      "iPhone 17": {
        userAgent: "ua",
        viewport: { width: 402, height: 681 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    };
    const result = buildStandardConfig(noScreen);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("init-device-unavailable");
  });

  test("fails typed when the screen shape is invalid", () => {
    const badScreen: DeviceSource = {
      "iPhone 17": {
        userAgent: "ua",
        viewport: { width: 402, height: 681 },
        screen: { width: 402, height: "tall" },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    };
    const result = buildStandardConfig(badScreen);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("init-device-unavailable");
  });

  test("fails typed when an emulation field is missing", () => {
    const missingTouch: DeviceSource = {
      "iPhone 17": {
        userAgent: "ua",
        viewport: { width: 402, height: 681 },
        screen: { width: 402, height: 874 },
        deviceScaleFactor: 3,
        isMobile: true,
      },
    };
    const result = buildStandardConfig(missingTouch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("init-device-unavailable");
  });
});

describe("vlint init: non-destructive file generation", () => {
  test("creates a loader-accepted, byte-stable config in an empty directory (AE1)", async () => {
    const dir = await temporaryDirectory();
    const outcome = await runInitCommand(dir);
    expect(outcome.ok).toBe(true);

    const path = join(dir, CONFIG_NAME);
    const first = await readFile(path, "utf8");

    // A second init in another empty directory produces byte-identical output.
    const other = await temporaryDirectory();
    const otherOutcome = await runInitCommand(other);
    expect(otherOutcome.ok).toBe(true);
    const second = await readFile(join(other, CONFIG_NAME), "utf8");
    expect(second).toEqual(first);

    // The usual loader accepts the generated file.
    const loaded = await loadConfig(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.devices).toHaveLength(2);
    expect(loaded.value.provider).toBeUndefined();

    // The schema parser accepts it too.
    expect(parseConfig(JSON.parse(first)).ok).toBe(true);
    // No Chromium-incompatible browser type leaks into the file.
    expect(first.includes("defaultBrowserType")).toBe(false);
  });

  test("refuses to overwrite an existing regular file (AE2)", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, CONFIG_NAME);
    const prior = '{"schemaVersion":2,"devices":[]}';
    await writeFile(path, prior);

    const outcome = await runInitCommand(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("config-already-exists");

    const after = await readFile(path, "utf8");
    expect(after).toBe(prior);
  });

  test("refuses to overwrite an existing directory at the config path (AE2)", async () => {
    const dir = await temporaryDirectory();
    const path = join(dir, CONFIG_NAME);
    await mkdir(path);

    const outcome = await runInitCommand(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("config-already-exists");

    const info = await stat(path);
    expect(info.isDirectory()).toBe(true);
  });

  test("refuses to overwrite a symlink whose target already exists (AE2)", async () => {
    const dir = await temporaryDirectory();
    const target = join(dir, "real-target");
    const prior = "target-bytes";
    await writeFile(target, prior);
    const link = join(dir, CONFIG_NAME);
    await symlink(target, link);

    const outcome = await runInitCommand(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("config-already-exists");

    const after = await readFile(target, "utf8");
    expect(after).toBe(prior);
  });
  test("does not create a config when initialization is already cancelled", async () => {
    const dir = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runInitCommand(dir, controller.signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("signal-interrupt");
    expect(existsSync(join(dir, CONFIG_NAME))).toBe(false);
  });

});
