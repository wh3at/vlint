import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunResultV1 } from "../../src/contracts/result";
import { boundarySuccess } from "../../src/contracts/failure";
import { runCli, type BrowserInstallResult, type CliIo, type CliRuntime } from "../../src/cli";
import { runCheckCommand } from "../../src/commands/check";

/**
 * CLI acceptance boundary (U5/U7). Every scenario here drives the REAL check
 * pipeline — `runCli` → `runCheckCommand` → live config loading → live command
 * provider resolution → result → reporter → exit code — by wiring a CliRuntime
 * whose `check` is the production `runCheckCommand` pointed at a controlled
 * temp directory. No browser is ever launched: every path under test fails at
 * config or provider resolution, which is precisely the boundary the unit
 * `cli-run` test stubs out with an injected result. This locks the end-to-end
 * contract that a valid `check` writes exactly one newline-terminated result to
 * stdout and nothing to stderr, and that each reachable failure maps to exit 2
 * with the correct failure code.
 *
 * Exit 0 (clean) and exit 1 (violations) require an installed Chromium to clear
 * resolution; they are marked below as browser-gated rather than weakened.
 */

const providerFixture = join(import.meta.dir, "../fixtures/providers/provider.ts");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-cli-accept-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(directory: string, value: unknown): Promise<void> {
  await writeFile(join(directory, "vlint.config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Captured {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

function capture(): { io: CliIo; output: () => Captured } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    output: () => ({ stdout: [...stdout], stderr: [...stderr] }),
  };
}

function runtimeFor(cwd: string, version = "0.1.0"): CliRuntime {
  return {
    version,
    check: (url, signal) => runCheckCommand(cwd, url, process.env, version, signal),
    // No scenario in this file invokes `browser install`; the fake exists only
    // to satisfy the CliRuntime contract deterministically.
    install: async () =>
      boundarySuccess<BrowserInstallResult>({ revision: "test", action: "already-present" }),
  };
}

async function runCheck(
  cwd: string,
  args: readonly string[],
): Promise<{ exit: 0 | 1 | 2; output: Captured }> {
  const harness = capture();
  const exit = await runCli(args, runtimeFor(cwd), harness.io);
  return { exit, output: harness.output() };
}

function jsonResult(output: Captured): RunResultV1 {
  expect(output.stdout).toHaveLength(1);
  expect(output.stderr).toEqual([]);
  const line = output.stdout[0]!;
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as RunResultV1;
}

describe("CLI version and invalid-argument boundary", () => {
  test("answers --version on stdout only with exit 0", async () => {
    const cwd = await temporaryDirectory();
    const { exit, output } = await runCheck(cwd, ["--version"]);
    expect(exit).toBe(0);
    expect(output.stdout).toEqual(["vlint 0.1.0\n"]);
    expect(output.stderr).toEqual([]);
  });

  test.each([
    ["unknown command", ["bogus"]],
    ["duplicate --url", ["check", "--url", "https://a.example", "--url", "https://b.example"]],
    ["missing --format value", ["check", "--format"]],
    ["bad --format value", ["check", "--format", "yaml"]],
    ["non-http ad hoc url", ["check", "--url", "file:///tmp/page"]],
    ["userinfo ad hoc url", ["check", "--url", "https://user:pass@example.com/x"]],
  ] as const)("rejects %s on stderr only with exit 2", async (_name, args) => {
    const cwd = await temporaryDirectory();
    const { exit, output } = await runCheck(cwd, args);
    expect(exit).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(output.stderr[0]?.endsWith("\n")).toBe(true);
  });
});

describe("valid check boundary: exactly one stdout result, no stderr", () => {
  test("no config and no url resolves to config-not-found over JSON", async () => {
    const cwd = await temporaryDirectory();
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    const result = jsonResult(output);
    expect(result.status).toBe("incomplete");
    expect(result.failure).toMatchObject({ stage: "config", code: "config-not-found" });
    expect(result.targets).toEqual([]);
  });

  test("no config and no url renders the terminal view", async () => {
    const cwd = await temporaryDirectory();
    const { exit, output } = await runCheck(cwd, ["check"]);
    expect(exit).toBe(2);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    const rendered = output.stdout[0]!;
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).toContain("vlint 0.1.0: incomplete");
    expect(rendered).toContain("config/config-not-found");
  });
});

describe("config failure matrix maps to exit 2 with the correct code", () => {
  test("config-invalid-json", async () => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, "not json");
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(jsonResult(output).failure).toMatchObject({ code: "config-invalid-json" });
  });

  test("config-schema-invalid (empty static targets)", async () => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, { schemaVersion: 1, provider: { type: "static", targets: [] } });
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(jsonResult(output).failure).toMatchObject({ code: "config-schema-invalid" });
  });

  test("config-too-large (file exceeds 8 MiB before parsing)", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "vlint.config.json"), "x".repeat(8 * 1024 * 1024 + 1));
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(jsonResult(output).failure).toMatchObject({ code: "config-too-large" });
  });
});

describe("provider failure matrix maps to exit 2 with the correct code", () => {
  function commandConfig(executable: string, args: readonly string[]) {
    return {
      schemaVersion: 1,
      provider: { type: "command" as const, executable, args, timeoutMs: 5000 },
    };
  }

  test.each([
    ["provider-exit-nonzero", "nonzero"],
    ["provider-output-invalid", "invalid-json"],
    ["provider-empty", "empty"],
  ] as const)("classifies %s over the real command provider", async (code, mode) => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, commandConfig(process.execPath, [providerFixture, mode]));
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(jsonResult(output).failure).toMatchObject({ stage: "provider", code });
  });

  test("classifies provider-spawn-failed for a missing executable", async () => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, commandConfig(join(cwd, "does-not-exist"), []));
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(jsonResult(output).failure).toMatchObject({ code: "provider-spawn-failed" });
  });

  // provider-timeout is deliberately omitted: exercising it requires a wall-clock
  // sleep in the provider fixture, which the deterministic-test constraint forbids.
});

