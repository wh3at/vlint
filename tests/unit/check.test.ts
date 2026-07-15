import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCheckPlan } from "../../src/commands/check";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-check-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

async function writeSentinelProvider(directory: string, sentinel: string, targetsJson: string): Promise<string> {
  const script = join(directory, "provider.sh");
  await writeFile(script, `#!/bin/sh\ntouch "$1"\necho '${targetsJson}'\n`);
  await chmod(script, 0o755);
  return script;
}

describe("check resolution", () => {
  test("requires a config even for an ad hoc URL (no implicit fallback)", async () => {
    const directory = await temporaryDirectory();
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config-not-found");
  });

  test("does not bypass a malformed config for ad hoc checks", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "vlint.config.json"), "not json");
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("config-invalid-json");
  });

  test("resolves an ad hoc URL across all configured devices without calling the provider", async () => {
    const directory = await temporaryDirectory();
    const sentinel = join(directory, "provider-ran");
    const script = await writeSentinelProvider(
      directory,
      sentinel,
      '{"targets":[{"name":"from-provider","url":"http://127.0.0.1:4173/provided"}]}',
    );
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
        provider: { type: "command", executable: script, args: [sentinel] },
      }),
    );
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    // Provider call count must be 0: the sentinel is created only if the provider runs.
    expect(existsSync(sentinel)).toBe(false);
    expect(result.value.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual(["adhoc/desk", "adhoc/phone"]);
    expect(result.value.targets.map((target) => target.name)).toEqual(["adhoc"]);
  });

  test("resolves provider targets across all devices when no URL is given (sentinel proves invocation)", async () => {
    const directory = await temporaryDirectory();
    const sentinel = join(directory, "provider-ran");
    const script = await writeSentinelProvider(
      directory,
      sentinel,
      '{"targets":[{"name":"second","url":"http://127.0.0.1:4173/second"},{"name":"first","url":"http://127.0.0.1:4173/first"}]}',
    );
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
        provider: { type: "command", executable: script, args: [sentinel] },
      }),
    );
    const result = await resolveCheckPlan(directory, null, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(existsSync(sentinel)).toBe(true);
    expect(result.value.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual([
      "second/desk",
      "second/phone",
      "first/desk",
      "first/phone",
    ]);
  });

  test("fails with targets-empty before any browser dependency when there is no URL and no provider", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({ schemaVersion: 2, devices: [DESKTOP_DEVICE] }),
    );
    const result = await resolveCheckPlan(directory, null, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("targets-empty");
    expect(result.failure.stage).toBe("config");
  });

  test("resolves two static-provider targets by two devices into four ordered cases", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 2,
        devices: [DESKTOP_DEVICE, MOBILE_DEVICE],
        provider: {
          type: "static",
          targets: [
            { name: "second", url: "http://127.0.0.1:4173/second" },
            { name: "first", url: "http://127.0.0.1:4173/first" },
          ],
        },
      }),
    );
    const result = await resolveCheckPlan(directory, null, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.cases.map((c) => `${c.name}/${c.deviceName}`)).toEqual([
      "second/desk",
      "second/phone",
      "first/desk",
      "first/phone",
    ]);
  });
});
