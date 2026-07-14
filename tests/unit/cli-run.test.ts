import { describe, expect, test } from "bun:test";
import type { RunResultV1 } from "../../src/contracts/result";
import { boundaryFailure, boundarySuccess } from "../../src/contracts/failure";
import { runCli, type CliIo, type CliRuntime } from "../../src/cli";

function result(status: RunResultV1["status"]): RunResultV1 {
  return {
    schemaVersion: 1,
    status,
    tool: { name: "vlint", version: "0.1.0" },
    environment: { platform: "linux", arch: "x64", browser: { name: "chromium", version: null } },
    summary: {
      targets: { resolved: 0, complete: 0, partial: 0, failed: 0, notExecuted: 0 },
      ruleEvaluations: { clean: 0, violations: 0, failed: 0, disabled: 0, notExecuted: 0 },
      ruleFinalizations: { passed: 0, failed: 0, notExecuted: 0 },
      violations: status === "violations" ? 1 : 0,
      matchedElements: 0,
      executionFailures: status === "incomplete" ? 1 : 0,
    },
    targets: [],
    ruleFinalizations: [],
    failure:
      status === "incomplete"
        ? { stage: "config", code: "config-not-found", message: "missing", target: null, rule: null }
        : null,
  };
}

function harness(checkResult: RunResultV1 = result("clean")) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let checks = 0;
  let installs = 0;
  const io: CliIo = { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) };
  const runtime: CliRuntime = {
    version: "0.1.0",
    async check() {
      checks += 1;
      return checkResult;
    },
    async install(force) {
      installs += 1;
      return boundarySuccess({ revision: "1228", action: force ? "reinstalled" : "installed" });
    },
  };
  return { stdout, stderr, io, runtime, counts: () => ({ checks, installs }) };
}

describe("CLI process contract", () => {
  test("answers version without invoking config, browser, or installer", async () => {
    const testHarness = harness();
    expect(await runCli(["--version"], testHarness.runtime, testHarness.io)).toBe(0);
    expect(testHarness.stdout).toEqual(["vlint 0.1.0\n"]);
    expect(testHarness.stderr).toEqual([]);
    expect(testHarness.counts()).toEqual({ checks: 0, installs: 0 });
  });

  test("rejects grammar and ad hoc URL errors without creating a result", async () => {
    for (const args of [["check", "extra"], ["check", "--url", "file:///tmp/page"]]) {
      const testHarness = harness();
      expect(await runCli(args, testHarness.runtime, testHarness.io)).toBe(2);
      expect(testHarness.stdout).toEqual([]);
      expect(testHarness.stderr).toHaveLength(1);
      expect(testHarness.stderr[0]?.endsWith("\n")).toBe(true);
      expect(testHarness.counts().checks).toBe(0);
    }
  });

  test.each([
    ["clean", 0],
    ["violations", 1],
    ["incomplete", 2],
  ] as const)("maps %s result to exit %d and stdout-only JSON", async (status, exitCode) => {
    const testHarness = harness(result(status));
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

  test("prints sanitized installer failure on stderr only", async () => {
    const testHarness = harness();
    testHarness.runtime.install = async () =>
      boundaryFailure({
        stage: "browser-setup",
        code: "browser-install-failed",
        message: "safe\u001b\r\n",
        target: null,
        rule: null,
      });
    expect(await runCli(["browser", "install"], testHarness.runtime, testHarness.io)).toBe(2);
    expect(testHarness.stdout).toEqual([]);
    expect(testHarness.stderr).toEqual(["vlint: browser-install-failed: safe\\u{1b}\\r\\n\n"]);
  });
});
