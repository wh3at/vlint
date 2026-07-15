import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunResultV2 } from "../../src/contracts/result";
import { boundarySuccess } from "../../src/contracts/failure";
import { runCli, type BrowserInstallResult, type CliIo, type CliRuntime } from "../../src/cli";
import { runCheckCommand } from "../../src/commands/check";
import { runInitCommand } from "../../src/commands/init";
import type { SetupResult } from "../../src/commands/setup";
import { loadConfig } from "../../src/config/load";

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

const MINIMAL_DEVICE = {
  name: "standard",
  viewport: { width: 1280, height: 720 },
  screen: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;

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
    init: () => runInitCommand(cwd),
    setup: async () => boundarySuccess<SetupResult>({
      config: "already-present",
      browser: {
        kind: "already-present",
        browser: {
          name: "chromium-headless-shell",
          revision: "test",
          browserVersion: "test",
          executablePath: "/test/chromium",
        },
      },
    }),
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

function jsonResult(output: Captured): RunResultV2 {
  expect(output.stdout).toHaveLength(1);
  expect(output.stderr).toEqual([]);
  const line = output.stdout[0]!;
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as RunResultV2;
}

function runFailure(output: Captured): RunResultV2["failures"][number] | undefined {
  return jsonResult(output).failures[0];
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
    expect(result.failures[0]).toMatchObject({ stage: "config", code: "config-not-found" });
    expect(result.cases).toEqual([]);
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
    expect(runFailure(output)).toMatchObject({ code: "config-invalid-json" });
  });

  test("config-schema-invalid (empty static targets)", async () => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, { schemaVersion: 2, devices: [MINIMAL_DEVICE], provider: { type: "static", targets: [] } });
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(runFailure(output)).toMatchObject({ code: "config-schema-invalid" });
  });

  test("config-too-large (file exceeds 8 MiB before parsing)", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "vlint.config.json"), "x".repeat(8 * 1024 * 1024 + 1));
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(runFailure(output)).toMatchObject({ code: "config-too-large" });
  });
});

describe("provider failure matrix maps to exit 2 with the correct code", () => {
  function commandConfig(executable: string, args: readonly string[]) {
    return {
      schemaVersion: 2,
      devices: [MINIMAL_DEVICE],
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
    expect(runFailure(output)).toMatchObject({ stage: "provider", code });
  });

  test("classifies provider-spawn-failed for a missing executable", async () => {
    const cwd = await temporaryDirectory();
    await writeConfig(cwd, commandConfig(join(cwd, "does-not-exist"), []));
    const { exit, output } = await runCheck(cwd, ["check", "--format", "json"]);
    expect(exit).toBe(2);
    expect(runFailure(output)).toMatchObject({ code: "provider-spawn-failed" });
  });

  // provider-timeout is deliberately omitted: exercising it requires a wall-clock
  // sleep in the provider fixture, which the deterministic-test constraint forbids.
});

describe("init boundary: non-destructive standard config generation", () => {
  test("creates a stable config on stdout only with exit 0 (AE1)", async () => {
    const cwd = await temporaryDirectory();
    const { exit, output } = await runCheck(cwd, ["init"]);
    expect(exit).toBe(0);
    expect(output.stdout).toEqual(["vlint init: created vlint.config.json\n"]);
    expect(output.stderr).toEqual([]);

    const configPath = join(cwd, "vlint.config.json");
    const created = await readFile(configPath, "utf8");
    // The generated file is accepted by the usual loader and schema parser.
    const loaded = await loadConfig(cwd);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.devices).toHaveLength(2);
    expect(loaded.value.provider).toBeUndefined();
    // No Chromium-incompatible browser type leaks into the generated file.
    expect(created.includes("defaultBrowserType")).toBe(false);
  });

  test("refuses to overwrite an existing config with exit 2 (AE2)", async () => {
    const cwd = await temporaryDirectory();
    const configPath = join(cwd, "vlint.config.json");
    const prior = "prior-bytes";
    await writeFile(configPath, prior);

    const { exit, output } = await runCheck(cwd, ["init"]);
    expect(exit).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(output.stderr[0]?.endsWith("\n")).toBe(true);
    expect(output.stderr[0]).toContain("config-already-exists");

    const after = await readFile(configPath, "utf8");
    expect(after).toBe(prior);
  });
});

