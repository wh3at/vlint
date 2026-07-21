import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import vlintPackage from "../../package.json";
import type { RunResultV3 } from "../../src/contracts/result";

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
    env: { ...Bun.env, HOME: join(cwd, "home") },
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
      expect(result.stdout).toBe(`vlint ${vlintPackage.version}\n`);
      expect(result.stderr).toBe("");
    });

    test.each([
      [[], "Usage: vlint", "check"],
      [["--help"], "Usage: vlint", "browser"],
      [["check", "--help"], "Usage: vlint check", "--format"],
      [["browser", "--help"], "Usage: vlint browser", "install"],
      [["browser", "install", "--help"], "Usage: vlint browser install", "--with-deps"],
      [["browser", "status", "--help"], "Usage: vlint browser status", "--format"],
      [["init", "--help"], "Usage: vlint init", "Create vlint.config.json"],
      [["setup", "--help"], "Usage: vlint setup", "install the browser"],
      [["help", "check"], "Usage: vlint check", "--format"],
    ] as const)("renders compiled help for %#", async (args, usage, detail) => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(args, cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(usage);
      expect(result.stdout).toContain(detail);
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stderr).toBe("");
      expect(await readdir(cwd)).toEqual([]);
    });

    test.each([
      ["unsafe positional", ["check", "bad\u001b", "--help"]],
      ["invalid option value", ["check", "--format", "yaml", "--help"]],
      ["missing option value", ["check", "--format", "--help"]],
    ] as const)("compiled help wins over %s", async (_name, args) => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(args, cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Usage: vlint check");
      expect(result.stdout).not.toContain("\u001b");
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
      const parsed = JSON.parse(result.stdout) as RunResultV3;
      expect(parsed.status).toBe("incomplete");
      expect(parsed.tool).toEqual({ name: "vlint", version: vlintPackage.version });
      expect(parsed.failures[0]).toMatchObject({ stage: "config", code: "config-not-found" });
    });

    test("invalid grammar writes to stderr only and exits 1", async () => {
      const cwd = await temporaryDirectory();
      const result = await execBinary(["bogus"], cwd);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(result.stderr).toContain("error: unknown command 'bogus'");
    });

    test("compiled invalid diagnostics are inert and redact URL credentials", async () => {
      const cwd = await temporaryDirectory();
      const unsafePayloads = [
        ["\u0007", "\\u{7}"],
        ["\u009b", "\\u{9b}"],
        ["\u001b[31m", "\\u{1b}"],
        ["\u001b]0;owned\u0007", "\\u{1b}"],
        ["\r", "\\r"],
        ["\n", "\\n"],
        ["\t", "\\t"],
        ["\u061c", "\\u{61c}"],
      ] as const;
      const positions = [
        (payload: string) => [`bad${payload}`],
        (payload: string) => ["check", `--bad${payload}`],
        (payload: string) => ["check", "--format", `json${payload}`],
      ];
      for (const [payload, escaped] of unsafePayloads) {
        const markedPayload = `x${payload}y`;
        for (const args of positions.map((build) => build(markedPayload))) {
          const unsafe = await execBinary(args, cwd);
          expect(unsafe.exitCode).toBe(1);
          expect(unsafe.stdout).toBe("");
          expect(unsafe.stderr).not.toContain(markedPayload);
          expect(unsafe.stderr).toContain(escaped);
        }
      }

      const credential = await execBinary([
        "https://user:password@example.com/x?token=secret#fragment\u001b",
      ], cwd);
      expect(credential.exitCode).toBe(1);
      expect(credential.stderr).not.toContain("user:password");
      expect(credential.stderr).not.toContain("secret");
      expect(credential.stderr).not.toContain("fragment");
    }, 30_000);
  },
);
