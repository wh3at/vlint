import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { RunResultV2 } from "../../src/contracts/result";

/**
 * Compiled-binary CLI contract smoke test. Consumes the already-built
 * production target at dist/vlint-linux-x64 WITHOUT building or downloading:
 * it only exercises paths that resolve a result before any browser launch
 * (--version, invalid grammar, and a no-config check). A real clean/violations
 * check would require an installed Chromium and is therefore out of scope here.
 *
 * If the binary is not present (e.g. a clean checkout that never ran
 * `build:linux-x64`), every case is skipped with an explicit dependency note
 * rather than failing or attempting a build.
 */

const binary = join(import.meta.dir, "../../dist/vlint-linux-x64");
const binaryPresent = existsSync(binary);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vlint-smoke-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function execBinary(args: readonly string[], cwd: string): Promise<ProcessResult> {
  const process = Bun.spawn([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!binaryPresent)(
  "compiled vlint binary CLI contract (dist/vlint-linux-x64 absent: build:linux-x64 dependency)",
  () => {
    test("--version prints the tool version on stdout and exits 0", async () => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(["--version"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("vlint 0.1.0\n");
      expect(result.stderr).toBe("");
    });

    test("no-config JSON check writes one result line and exits 2", async () => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      // Exactly one newline-terminated JSON line.
      expect(result.stdout.split("\n")).toHaveLength(2);
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("incomplete");
      expect(parsed.tool).toEqual({ name: "vlint", version: "0.1.0" });
      expect(parsed.failures[0]).toMatchObject({ stage: "config", code: "config-not-found" });
    });

    test("invalid grammar writes to stderr only and exits 2", async () => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(["bogus"], cwd);
      expect(result.exitCode, result.stdout).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(result.stderr).toContain("vlint: invalid-arguments:");
    });
  },
);
