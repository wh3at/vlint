import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("check resolution", () => {
  test("uses built-in defaults for an ad hoc URL without a config", async () => {
    const directory = await temporaryDirectory();
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.targets).toEqual([
      expect.objectContaining({
        name: "adhoc",
        url: "https://example.com/adhoc",
        viewport: { width: 1280, height: 720 },
        rules: [expect.objectContaining({ name: "tab-label-single-line", enabled: true })],
      }),
    ]);
  });

  test("ad hoc checks use config defaults and rules without executing its provider", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: { type: "command", executable: join(directory, "must-not-run") },
        defaults: { viewport: { width: 900, height: 700 } },
        rules: [{ name: "custom", type: "tab-label-single-line", allowZeroLabels: true }],
      }),
    );
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.targets[0]).toMatchObject({
      name: "adhoc",
      viewport: { width: 900, height: 700 },
      rules: [{ name: "custom", allowZeroLabels: true }],
    });
  });

  test("does not bypass malformed config for ad hoc checks", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "vlint.config.json"), "not json");
    const result = await resolveCheckPlan(directory, "https://example.com/adhoc", {});
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.failure.code).toBe("config-invalid-json");
  });

  test("normal checks resolve static provider order", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "vlint.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [
            { name: "second", url: "https://example.com/second" },
            { name: "first", url: "https://example.com/first" },
          ],
        },
      }),
    );
    const result = await resolveCheckPlan(directory, null, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.targets.map((item) => item.name)).toEqual(["second", "first"]);
  });
});
