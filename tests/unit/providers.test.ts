import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandProviderConfig, EffectiveRule } from "../../src/contracts/config";
import { resolveCommandProvider } from "../../src/providers/command";
import type { ProviderContext } from "../../src/providers/types";

const fixture = join(import.meta.dir, "../fixtures/providers/provider.ts");
const rules: readonly EffectiveRule[] = [
  {
    name: "tab-label-single-line",
    type: "tab-label-single-line",
    additionalCandidateSelectors: [],
    excludeSelectors: [],
    labelSelector: null,
    minimumLabels: 0,
    allowZeroLabels: false,
  },
];
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-provider-"));
  temporaryDirectories.push(directory);
  return directory;
}

function context(directory: string, environment = process.env): ProviderContext {
  return { directory, rules, environment };
}

function command(mode: string, args: readonly string[] = [], timeoutMs = 2_000): CommandProviderConfig {
  return { type: "command", executable: process.execPath, args: [fixture, mode, ...args], timeoutMs };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("command provider", () => {
  test("preserves ordered targets from the canonical output object", async () => {
    const directory = await temporaryDirectory();
    const result = await resolveCommandProvider(command("valid"), context(directory));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((target) => target.name)).toEqual(["settings"]);
  });

  test("passes argv literally, without shell interpretation, and inherits environment", async () => {
    const directory = await temporaryDirectory();
    const literal = "; echo shell-was-not-used";
    const result = await resolveCommandProvider(
      command("echo-argv", [literal]),
      context(directory, { ...process.env, VLINT_PROVIDER_TEST: "inherited" }),
    );
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value[0]?.name).toBe(`${literal}:inherited`);
  });

  test.each([
    ["nonzero", "provider-exit-nonzero"],
    ["invalid-json", "provider-output-invalid"],
    ["bare-array", "provider-output-invalid"],
    ["unknown-field", "provider-output-invalid"],
    ["unmatched-override", "provider-output-invalid"],
    ["duplicate", "provider-output-invalid"],
    ["empty", "provider-empty"],
  ] as const)("classifies %s", async (mode, expected) => {
    const directory = await temporaryDirectory();
    const result = await resolveCommandProvider(command(mode), context(directory));
    expect(result.ok ? null : result.failure.code).toBe(expected);
  });

  test("classifies direct spawn failures", async () => {
    const directory = await temporaryDirectory();
    const result = await resolveCommandProvider(
      { type: "command", executable: join(directory, "missing"), timeoutMs: 100 },
      context(directory),
    );
    expect(result.ok ? null : result.failure.code).toBe("provider-spawn-failed");
  });

  // This integration boundary deliberately exercises Bun's real subprocess timeout clock.
  test.each([
    ["timeout", "provider-timeout", 100],
    ["stdout-cap", "provider-output-too-large", 2_000],
    ["stderr-cap", "provider-output-too-large", 2_000],
    ["open-pipe", "provider-timeout", 100],
  ] as const)("bounds and cleans up %s", async (mode, expected, timeoutMs) => {
    const directory = await temporaryDirectory();
    const result = await resolveCommandProvider(command(mode, [], timeoutMs), context(directory));
    expect(result.ok ? null : result.failure.code).toBe(expected);
  });

  test("kills a graceful-termination-resistant grandchild process group", async () => {
    const directory = await temporaryDirectory();
    const pidFile = join(directory, "pid");
    const result = await resolveCommandProvider(command("grandchild", [pidFile], 150), context(directory));
    expect(result.ok ? null : result.failure.code).toBe("provider-timeout");
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("maps caller cancellation to an interrupt failure", async () => {
    const directory = await temporaryDirectory();
    const controller = new AbortController();
    const promise = resolveCommandProvider(command("timeout", [], 2_000), {
      ...context(directory),
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;
    expect(result.ok ? null : result.failure).toMatchObject({
      stage: "interrupt",
      code: "signal-interrupt",
      target: null,
      rule: null,
    });
  });
});
