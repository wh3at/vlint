/**
 * One-command local release validation (U6/U7).
 *
 * Builds the exact production binary and release fixture from the current
 * checkout, stages the versioned archive (vlint mode 0755 + README.md) and a
 * filename-relative SHA256SUMS, invokes the clean Ubuntu 24.04 release
 * validator (tests/release/validate.sh), and always removes temporary
 * staging — even on failure or signal.
 *
 * Design:
 *   - Immutable inputs: reads only from the current checkout (package.json,
 *     source, README.md). The script itself performs no network access; the
 *     Docker guest inside validate.sh performs the only browser download.
 *   - No shell interpolation: every subprocess is invoked with an explicit
 *     argv array via spawnSync — never through a shell.
 *   - Bounded execution: every subprocess has a hard timeout.
 *   - Failure propagation: the first non-zero exit or abnormal termination
 *     throws immediately; nothing is swallowed.
 *   - Safe cleanup: the temporary staging directory is removed on normal
 *     exit, on any exception, and on SIGINT/SIGTERM.
 *
 * Requires Docker (the validator builds a disposable ubuntu:24.04 guest).
 * Intended to be exposed as `bun run release:validate`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BUN = process.execPath;

const BUILD_TIMEOUT_MS = 5 * 60_000;
const STAGE_TIMEOUT_MS = 60_000;
const VALIDATE_TIMEOUT_MS = 20 * 60_000;

// ---------------------------------------------------------------------------
// Cleanup — registered once at module load, activated when stageDir is set.
// ---------------------------------------------------------------------------

let stageDir: string | null = null;
let cleaned = false;

function cleanupStage(): void {
  if (cleaned || stageDir === null) return;
  cleaned = true;
  rmSync(stageDir, { recursive: true, force: true });
}

process.on("exit", cleanupStage);
process.on("SIGINT", () => {
  cleanupStage();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupStage();
  process.exit(143);
});

// ---------------------------------------------------------------------------
// Bounded subprocess execution — argv arrays, never a shell.
// ---------------------------------------------------------------------------

/** Structural subset of spawnSync's return — avoids importing the generic. */
interface SyncResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer | string;
  readonly stderr: Buffer | string;
}

function assertOk(result: SyncResult, label: string, timeoutMs: number): void {
  if (result.status === null || result.signal !== null) {
    if (result.signal === "SIGTERM") {
      throw new Error(`${label}: timed out after ${timeoutMs / 1000}s`);
    }
    throw new Error(`${label}: process did not exit normally (signal: ${result.signal ?? "none"})`);
  }
  if (result.status !== 0) {
    const stderrText = result.stderr ? result.stderr.toString().trim() : "";
    throw new Error(`${label}: exited with code ${result.status}${stderrText ? ` — ${stderrText}` : ""}`);
  }
}

/** Runs a subprocess with inherited stdio (output streams to the terminal). */
function run(cmd: string, args: readonly string[], cwd: string, timeoutMs: number, label: string): void {
  const result = spawnSync(cmd, [...args], { cwd, stdio: "inherit", timeout: timeoutMs });
  assertOk(result, label, timeoutMs);
}

/** Runs a subprocess with piped stdout and returns the captured output. */
function capture(cmd: string, args: readonly string[], cwd: string, timeoutMs: number, label: string): string {
  const result = spawnSync(cmd, [...args], { cwd, stdio: "pipe", timeout: timeoutMs });
  assertOk(result, label, timeoutMs);
  return result.stdout.toString();
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Version from the current checkout's package.json (trusted immutable input).
  const pkg = (await Bun.file(join(root, "package.json")).json()) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json: version is missing or empty");
  }
  const archiveName = `vlint-v${pkg.version}-linux-x64.tar.gz`;
  console.error(`release-validate: staging ${archiveName}`);

  // Pre-flight: Docker is required by the validator.
  const dockerCheck = spawnSync("docker", ["--version"], { stdio: "ignore", timeout: 10_000 });
  if (dockerCheck.status !== 0) {
    throw new Error("Docker is required for release validation but was not found");
  }

  // ---- Build exact production and fixture binaries from the current checkout.

  console.error("release-validate: building production binary");
  run(BUN, ["run", "build:linux-x64"], root, BUILD_TIMEOUT_MS, "production build");

  // Release fixture: compiled directly (not via build.ts target map) so the
  // build target registry stays unchanged. Matches the release workflow.
  console.error("release-validate: building release fixture");
  run(
    BUN,
    [
      "build",
      "tests/release/release-fixture-server.ts",
      "--compile",
      "--target",
      "bun-linux-x64-baseline",
      "--outfile",
      join(root, "dist", "vlint-release-fixture-server"),
    ],
    root,
    BUILD_TIMEOUT_MS,
    "release fixture build",
  );

  // Verify artifacts exist.
  const binaryPath = join(root, "dist", "vlint-linux-x64");
  const fixturePath = join(root, "dist", "vlint-release-fixture-server");
  if (!existsSync(binaryPath)) throw new Error(`production build: expected ${binaryPath}`);
  if (!existsSync(fixturePath)) throw new Error(`fixture build: expected ${fixturePath}`);
  if (!existsSync(join(root, "README.md"))) throw new Error("README.md: not found in repository root");

  // ---- Stage archive + checksum in a temporary directory.
  stageDir = mkdtempSync(join(tmpdir(), "vlint-release-"));
  try {
    // Stage: vlint (mode 0755) + README.md.
    copyFileSync(binaryPath, join(stageDir, "vlint"));
    chmodSync(join(stageDir, "vlint"), 0o755);
    copyFileSync(join(root, "README.md"), join(stageDir, "README.md"));

    // Archive root: exactly vlint and README.md with deterministic ownership.
    const archivePath = join(stageDir, archiveName);
    console.error(`release-validate: creating archive ${archiveName}`);
    run(
      "tar",
      ["--owner=0", "--group=0", "--numeric-owner", "-czf", archivePath, "-C", stageDir, "vlint", "README.md"],
      root,
      STAGE_TIMEOUT_MS,
      "archive staging",
    );

    // Filename-relative SHA256SUMS: run sha256sum from within the stage
    // directory so the recorded path is the bare archive name.
    console.error("release-validate: generating checksum");
    const checksumLine = capture("sha256sum", [archiveName], stageDir, STAGE_TIMEOUT_MS, "checksum generation");
    if (checksumLine.trim().length === 0) {
      throw new Error("checksum generation: sha256sum produced no output");
    }
    await Bun.write(join(stageDir, "SHA256SUMS"), checksumLine);

    // ---- Invoke the clean Ubuntu 24.04 release validator.
    // validate.sh resolves absolute mount paths for the Docker guests and
    // exercises checksum verification, extraction, browser install, idempotent
    // re-install, force repair, offline check, and missing-browser failure.
    console.error("release-validate: running clean-guest validation (Docker)");
    run(
      "sh",
      [
        join(root, "tests", "release", "validate.sh"),
        "release",
        archivePath,
        join(stageDir, "SHA256SUMS"),
        fixturePath,
      ],
      root,
      VALIDATE_TIMEOUT_MS,
      "release validation",
    );

    console.error(`release-validate: passed (${pkg.version})`);
  } finally {
    cleanupStage();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`release-validate: ${message}`);
  process.exit(1);
});
