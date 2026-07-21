import { describe, expect, test } from "bun:test";
import type { RunResultV3 } from "../../src/contracts/result";
import type { BoundaryResult } from "../../src/contracts/failure";
import { boundaryFailure, boundarySuccess } from "../../src/contracts/failure";
import type { InitResult } from "../../src/commands/init";
import type { SetupResult } from "../../src/commands/setup";
import { runCli, type CliIo, type CliRuntime } from "../../src/cli";

function result(status: RunResultV3["status"]): RunResultV3 {
  return {
    schemaVersion: 3,
    status,
    tool: { name: "vlint", version: "0.1.0" },
    environment: { platform: "linux", arch: "x64", browser: { name: "chromium", version: null } },
    summary: {
      targets: { resolved: 0 },
      cases: { resolved: 0, complete: 0, partial: 0, failed: 0, notExecuted: 0 },
      ruleEvaluations: { clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 },
      ruleFinalizations: { passed: 0, failed: 0, notExecuted: 0 },
      violations: status === "violations" ? 1 : 0,
      elementsInspected: 0,
      executionFailures: status === "incomplete" ? 1 : 0,
    },
    cases: [],
    ruleFinalizations: [],
    failures:
      status === "incomplete"
        ? [{ stage: "config", code: "config-not-found", message: "missing", target: null, device: null, rule: null }]
        : [],
  };
}

function harness(options: {
  checkResult?: RunResultV3;
  initResult?: BoundaryResult<InitResult>;
  setupResult?: BoundaryResult<SetupResult>;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let checks = 0;
  let installs = 0;
  let inits = 0;
  let setups = 0;
  const installRequests: Array<{ force: boolean; withDeps: boolean }> = [];
  const io: CliIo = { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) };
  const runtime: CliRuntime = {
    version: "0.1.0",
    async check() {
      checks += 1;
      return options.checkResult ?? result("clean");
    },
    async install(force, withDeps) {
      installs += 1;
      installRequests.push({ force, withDeps });
      return boundarySuccess({ revision: "1228", action: force ? "reinstalled" : "installed" });
    },
    async init() {
      inits += 1;
      return options.initResult ?? boundarySuccess({ path: "/cwd/vlint.config.json" });
    },
    async setup() {
      setups += 1;
      return options.setupResult ?? boundarySuccess({
        config: "created",
        browser: {
          kind: "installed",
          browser: {
            name: "chromium-headless-shell",
            revision: "1228",
            browserVersion: "122.8.0.0",
            executablePath: "/cache/chromium",
          },
        },
      });
    },
    async status() {
      return boundarySuccess({ output: "browser status: ready\n", ready: true });
    },
  };
  return {
    stdout,
    stderr,
    io,
    runtime,
    installRequests,
    counts: () => ({ checks, installs, inits, setups }),
  };
}

describe("CLI process contract", () => {
  test("answers version without invoking config, browser, or installer", async () => {
    const testHarness = harness();
    expect(await runCli(["--version"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toEqual(["vlint 0.1.0\n"]);
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts()).toEqual({ checks: 0, installs: 0, inits: 0, setups: 0 });
  });

  test("rejects grammar and ad hoc URL errors without creating a result", async () => {
    for (const args of [["check", "extra"], ["check", "--url", "file:///tmp/page"]]) {
      const testHarness = harness();
      expect(await runCli(args, testHarness.runtime, testHarness.io)).toBe(1);
      expect(testHarness.stdout).toEqual([]);
      expect(testHarness.stderr).toHaveLength(1);
      expect(testHarness.stderr[0]?.endsWith("\n")).toBe(true);
      expect(testHarness.counts().checks).toBe(0);
    }
  });

  test.each([
    [[], "Usage: vlint"],
    [["--help"], "Usage: vlint"],
    [["check", "--help"], "Usage: vlint check"],
    [["browser", "--help"], "Usage: vlint browser"],
    [["browser", "install", "--help"], "Usage: vlint browser install"],
    [["browser", "status", "--help"], "Usage: vlint browser status"],
    [["help", "check"], "Usage: vlint check"],
  ] as const)("renders side-effect-free help for %#", async (args, usage) => {
    const testHarness = harness();
    expect(await runCli(args, testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toHaveLength(1);
    expect(testHarness.stdout[0]).toContain(usage);
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts()).toEqual({ checks: 0, installs: 0, inits: 0, setups: 0 });
  });

  test.each([
    ["clean", 0],
    ["violations", 1],
    ["incomplete", 2],
  ] as const)("maps %s result to exit %d and stdout-only JSON", async (status, exitCode) => {
    const testHarness = harness({ checkResult: result(status) });
    expect(await runCli(["check", "--format", "json"], testHarness.runtime, testHarness.io)).toBe(exitCode);
    expect(testHarness.stdout).toHaveLength(1);
    expect(JSON.parse(testHarness.stdout[0] ?? "{}").status).toBe(status);
    expect(testHarness.stderr).toEqual([]);
  });

  test("prints successful force reinstall on stdout", async () => {
    const testHarness = harness();
    expect(await runCli(["browser", "install", "--force"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toEqual(["vlint browser: chromium 1228 ready (reinstalled)\n"]);
    expect(testHarness.stderr).toEqual([]);
  });

  test("passes explicit dependency installation through to the runtime", async () => {
    const testHarness = harness();
    expect(await runCli(
      ["browser", "install", "--with-deps"],
      testHarness.runtime,
      testHarness.io,
    )).toBe(0);
    expect(testHarness.installRequests).toEqual([{ force: false, withDeps: true }]);
  });

  test("prints sanitized installer failure on stderr only", async () => {
    const testHarness = harness();
    testHarness.runtime.install = async () =>
      boundaryFailure({
        stage: "browser-setup",
        code: "browser-install-failed",
        message: "safe\u001b\r\n",
        target: null,
        device: null,
        rule: null,
      });
    expect(await runCli(["browser", "install"], testHarness.runtime, testHarness.io)).toBe(2);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toEqual(["vlint: browser-install-failed: safe\\u{1b}\\r\\n\n"]);
  });
  test("rejects init grammar without invoking the filesystem", async () => {
    for (const args of [["init", "--foo"], ["init", "extra"], ["init", "init"]]) {
      const testHarness = harness();
      expect(await runCli(args, testHarness.runtime, testHarness.io)).toBe(1);
      expect(testHarness.stdout).toEqual([]);
      expect(testHarness.stderr).toHaveLength(1);
      expect(testHarness.counts().inits).toBe(0);
    }
  });

  test("prints successful init on stdout only with exit 0", async () => {
    const testHarness = harness();
    expect(await runCli(["init"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toEqual(["vlint init: created vlint.config.json\n"]);
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts()).toEqual({ checks: 0, installs: 0, inits: 1, setups: 0 });
  });

  test("prints sanitized init failure on stderr only with exit 2", async () => {
    const testHarness = harness({
      initResult: boundaryFailure({
        stage: "config",
        code: "config-already-exists",
        message: "vlint.config.json already exists\u001b\r\n",
        target: null,
        device: null,
        rule: null,
      }),
    });
    expect(await runCli(["init"], testHarness.runtime, testHarness.io)).toBe(2);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toEqual([
      "vlint: config-already-exists: vlint.config.json already exists\\u{1b}\\r\\n\n",
    ]);
    expect(testHarness.counts().inits).toBe(1);
  });

  test("prints successful setup with config and browser outcomes", async () => {
    const testHarness = harness();
    expect(await runCli(["setup"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toEqual([
      "vlint setup: config created; chromium 1228 ready (installed)\n",
    ]);
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts().setups).toBe(1);
  });

  test("prints a sanitized setup failure", async () => {
    const testHarness = harness({
      setupResult: boundaryFailure({
        stage: "config",
        code: "config-invalid-json",
        message: "invalid\u001b",
        target: null,
        device: null,
        rule: null,
      }),
    });
    expect(await runCli(["setup"], testHarness.runtime, testHarness.io)).toBe(2);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toEqual([
      "vlint: config-invalid-json: invalid\\u{1b}\n",
    ]);
  });

  test("status returns ready for a ready runtime and does not increment check/install counters", async () => {
    const testHarness = harness();
    expect(await runCli(["browser", "status"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toHaveLength(1);
    expect(testHarness.stdout[0]).toContain("browser status:");
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts()).toEqual({ checks: 0, installs: 0, inits: 0, setups: 0 });
  });

  test("status with invalid format exits 1 as parse error before runtime", async () => {
    const testHarness = harness();
    expect(await runCli(
      ["browser", "status", "--format", "xml"],
      testHarness.runtime,
      testHarness.io,
    )).toBe(1);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toHaveLength(1);
  });
});
