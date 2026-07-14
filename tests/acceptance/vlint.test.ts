import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { RunResultV1 } from "../../src/contracts/result";
import { startFixtureServer } from "../fixtures/app/server";
import { startAcceptanceServer, type AcceptanceServer } from "./server";
import type { FixtureServer } from "../fixtures/app/server";

/**
 * Compiled-binary acceptance coverage (U6). Every scenario drives the REAL
 * production target at dist/vlint-linux-x64 — no runCli injection, no adapter
 * stubs — against a pinned Playwright Chromium and deterministic loopback
 * fixture pages. Resources are closed in finally/afterEach; no wall-clock
 * sleeps are used (the only real timers live inside the binary under test).
 *
 * If the binary is absent (clean checkout without build:linux-x64), the
 * entire suite is skipped with an explicit dependency note.
 */

const binary = join(import.meta.dir, "../../dist/vlint-linux-x64");
const binaryPresent = existsSync(binary);
const CAT = "/bin/cat";
/** Per-test ceiling for browser-launching checks (launch + navigate + evaluate + close). */
const CHECK_TIMEOUT = 60_000;

const temporaryDirectories: string[] = [];

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function execBinary(args: readonly string[], cwd: string): Promise<ProcessResult> {
  const proc = Bun.spawn([binary, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vlint-accept-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writeConfig(directory: string, value: unknown): Promise<void> {
  await writeFile(
    join(directory, "vlint.config.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe.skipIf(!binaryPresent)(
  "compiled vlint binary acceptance (dist/vlint-linux-x64 absent: run build:linux-x64)",
  () => {
    let acceptance: AcceptanceServer;
    let fixture: FixtureServer;

    beforeAll(() => {
      acceptance = startAcceptanceServer();
      fixture = startFixtureServer();
    });

    beforeEach(() => {
      acceptance.setSettingsWrapped(true);
    });

    afterAll(async () => {
      await acceptance.close().catch(() => undefined);
      await fixture.close().catch(() => undefined);
    });

    afterEach(async () => {
      await Promise.all(
        temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
      );
    });

    // ------------------------------------------------------------------ version

    test("--version prints tool version on stdout, exits 0, empty stderr", async () => {
      const cwd = await tempDir();
      const result = await execBinary(["--version"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("vlint 0.1.0\n");
      expect(result.stderr).toBe("");
    });

    // ----------------------------------------------------- clean Static (exit 0)

    test("clean Static run completes with exit 0 and valid JSON schema", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "clean", url: `${acceptance.url}/clean` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.split("\n")).toHaveLength(2);

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.status).toBe("clean");
      expect(parsed.tool).toEqual({ name: "vlint", version: "0.1.0" });
      expect(parsed.environment).toMatchObject({ platform: "linux", arch: "x64" });
      expect(typeof parsed.environment.browser.version).toBe("string");
      expect(parsed.environment.browser.version!.length).toBeGreaterThan(0);
      expect(parsed.summary.targets).toMatchObject({ resolved: 1, complete: 1, failed: 0, notExecuted: 0 });
      expect(parsed.summary.violations).toBe(0);
      expect(parsed.summary.matchedElements).toBe(2);
      expect(parsed.targets[0]).toMatchObject({ name: "clean", status: "complete" });
      expect(parsed.targets[0]!.rules[0]).toMatchObject({ status: "clean", labelsInspected: 2 });
      expect(parsed.targets[0]!.rules[0]!.violations).toHaveLength(0);
      expect(parsed.ruleFinalizations[0]).toMatchObject({ status: "passed", labelsInspected: 2 });
      expect(parsed.failure).toBeNull();
    }, CHECK_TIMEOUT);

    // ----------------------------------------- wrapped-tabs violations (exit 1)

    test("wrapped-tabs violations exit 1 with schema/context/locator fields", async () => {
      const cwd = await tempDir();
      const targetUrl = `${acceptance.url}/settings`;
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "settings", url: targetUrl }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.status).toBe("violations");
      expect(parsed.summary.violations).toBe(1);
      expect(parsed.summary.matchedElements).toBe(1);

      const target = parsed.targets[0]!;
      expect(target.name).toBe("settings");
      expect(target.url).toBe(targetUrl);
      expect(target.viewport).toEqual({ width: 1280, height: 720 });
      expect(target.deviceScaleFactor).toBe(1);
      expect(target.status).toBe("complete");

      const rule = target.rules[0]!;
      expect(rule.name).toBe("tab-label-single-line");
      expect(rule.status).toBe("violations");
      expect(rule.labelsInspected).toBe(1);

      const violation = rule.violations[0]!;
      expect(violation.text).toBe("Account Settings");
      expect(violation.lineCount).toBe(2);
      expect(violation.locator).toBe('[data-testid="settings"]');
      expect(violation.geometry.x).toBeTypeOf("number");
      expect(violation.geometry.y).toBeTypeOf("number");
      expect(violation.geometry.width).toBeGreaterThan(0);
      expect(violation.geometry.height).toBeGreaterThan(0);
    }, CHECK_TIMEOUT);

    // ------------------------ mixed violation then navigation failure (exit 2)

    test("mixed first-target violation then navigation failure exits 2, retains prior facts and not-executed matrix", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [
            { name: "violations", url: `${acceptance.url}/settings` },
            { name: "broken", url: `${fixture.url}/status?code=500` },
            { name: "pending", url: `${acceptance.url}/clean` },
          ],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.status).toBe("incomplete");

      // Prior violations survive the fail-fast.
      expect(parsed.summary.violations).toBeGreaterThanOrEqual(1);
      expect(parsed.targets[0]!.status).toBe("complete");
      expect(parsed.targets[0]!.rules[0]!.violations.length).toBeGreaterThanOrEqual(1);

      // Failing target.
      expect(parsed.targets[1]!.status).toBe("failed");

      // Not-executed target and its rule.
      expect(parsed.targets[2]!.status).toBe("not-executed");
      expect(parsed.targets[2]!.rules[0]!.status).toBe("not-executed");

      // Authoritative failure points at the navigation target.
      expect(parsed.failure).toMatchObject({
        stage: "navigation",
        code: "navigation-http-status",
        target: "broken",
      });

      // Finalizations not reached because the run failed mid-loop.
      for (const fin of parsed.ruleFinalizations) {
        expect(fin.status).toBe("not-executed");
      }
    }, CHECK_TIMEOUT);

    // ------------------------- authenticated state: valid and invalid (R42-R45)

    test("valid authenticated browser state reaches clean tabs behind auth gate (exit 0)", async () => {
      const cwd = await tempDir();
      const statePath = join(cwd, "state.json");
      // Generated in a temp file — never persisted in shared fixtures.
      await writeFile(statePath, JSON.stringify({
        cookies: [{
          name: "session",
          value: "authenticated",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        }],
        origins: [],
      }));
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [{ name: "secure", url: `${acceptance.url}/secure`, browserState: statePath }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.status).toBe("clean");
      expect(parsed.summary.matchedElements).toBe(2);
      expect(parsed.targets[0]!.status).toBe("complete");
      expect(parsed.failure).toBeNull();
    }, CHECK_TIMEOUT);

    test("invalid browser state fails at authentication stage (exit 2)", async () => {
      const cwd = await tempDir();
      const statePath = join(cwd, "bad-state.json");
      await writeFile(statePath, JSON.stringify({ cookies: "not-an-array", origins: 42 }));
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [{ name: "secure", url: `${acceptance.url}/secure`, browserState: statePath }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "authentication", code: "state-invalid", target: "secure" });
      expect(parsed.targets[0]!.status).toBe("failed");
    }, CHECK_TIMEOUT);

    // ----------------------------------- typed execution failures (navigation/font/ready)

    test("navigation HTTP failure classifies navigation-http-status (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "http500", url: `${fixture.url}/status?code=500` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "navigation", code: "navigation-http-status", target: "http500" });
    }, CHECK_TIMEOUT);

    test("web-font load failure classifies font-load-failed (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "font", url: `${fixture.url}/font-error.html` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "web-font", code: "font-load-failed", target: "font" });
    }, CHECK_TIMEOUT);

    test("invalid ready selector classifies ready-invalid-selector (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: {
          type: "static",
          targets: [{
            name: "ready",
            url: `${fixture.url}/index.html`,
            readyCondition: { selector: ":::invalid", state: "attached" },
          }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "ready-condition", code: "ready-invalid-selector", target: "ready" });
    }, CHECK_TIMEOUT);

    // --------------- ad hoc URL bypasses a deliberately failing provider (R21)

    test("ad hoc --url bypasses failing command provider and applies config defaults/global rules", async () => {
      const cwd = await tempDir();
      // Deliberately failing provider: cat of a non-existent path exits nonzero.
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "command", executable: CAT, args: [join(cwd, "missing.json")] },
        defaults: { viewport: { width: 800, height: 600 } },
        rules: [{ name: "custom-tabs", type: "tab-label-single-line" }],
      });
      const adhocUrl = `${acceptance.url}/clean`;
      const result = await execBinary(["check", "--url", adhocUrl, "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.status).toBe("clean");
      expect(parsed.failure).toBeNull();
      // Ad hoc target name and exact URL.
      expect(parsed.targets[0]!.name).toBe("adhoc");
      expect(parsed.targets[0]!.url).toBe(adhocUrl);
      // Config defaults applied.
      expect(parsed.targets[0]!.viewport).toEqual({ width: 800, height: 600 });
      // Global rule from config applied.
      expect(parsed.targets[0]!.rules[0]!.name).toBe("custom-tabs");
      expect(parsed.targets[0]!.rules[0]!.status).toBe("clean");
    }, CHECK_TIMEOUT);

    // ------------------------- Command Provider parity and failure (R17-R20)

    test("Command Provider returns same verdict as Static for identical targets", async () => {
      const targetUrl = `${acceptance.url}/clean`;

      const staticCwd = await tempDir();
      await writeConfig(staticCwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "cmd-parity", url: targetUrl }] },
      });
      const staticResult = await execBinary(["check", "--format", "json"], staticCwd);

      const cmdCwd = await tempDir();
      const targetsFile = join(cmdCwd, "targets.json");
      await writeFile(targetsFile, JSON.stringify({ targets: [{ name: "cmd-parity", url: targetUrl }] }));
      await writeConfig(cmdCwd, {
        schemaVersion: 1,
        provider: { type: "command", executable: CAT, args: [targetsFile] },
      });
      const cmdResult = await execBinary(["check", "--format", "json"], cmdCwd);

      expect(cmdResult.exitCode).toBe(staticResult.exitCode);
      const cmdParsed = JSON.parse(cmdResult.stdout) as RunResultV1;
      const staticParsed = JSON.parse(staticResult.stdout) as RunResultV1;
      expect(cmdParsed.status).toBe(staticParsed.status);
      expect(cmdParsed.summary.violations).toBe(staticParsed.summary.violations);
      expect(cmdParsed.summary.matchedElements).toBe(staticParsed.summary.matchedElements);
      expect(cmdParsed.targets[0]!.name).toBe("cmd-parity");
      expect(cmdParsed.targets[0]!.rules[0]!.status).toBe("clean");
    }, CHECK_TIMEOUT);

    test("Command Provider nonzero exit classifies provider-exit-nonzero (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "command", executable: CAT, args: [join(cwd, "nonexistent")] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "provider", code: "provider-exit-nonzero" });
    }, CHECK_TIMEOUT);

    test("Command Provider invalid JSON classifies provider-output-invalid (exit 2)", async () => {
      const cwd = await tempDir();
      const badFile = join(cwd, "bad.json");
      await writeFile(badFile, "definitely not json");
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "command", executable: CAT, args: [badFile] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV1;
      expect(parsed.failure).toMatchObject({ stage: "provider", code: "provider-output-invalid" });
    }, CHECK_TIMEOUT);

    // --------------- terminal secret redaction, control escaping, JSON exactness

    test("terminal redacts query secrets and fragments, escapes control/bidi chars; JSON preserves exact data", async () => {
      const cwd = await tempDir();
      // Generated in test memory — never a persisted credential fixture.
      const secret = "S3CR3T-VALUE-9k2";
      const controlName = "t\u0001ab\u202e";
      const secretUrl = `${acceptance.url}/clean?token=${secret}#section`;
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: controlName, url: secretUrl }] },
      });

      const termResult = await execBinary(["check", "--format", "terminal"], cwd);
      expect(termResult.exitCode, termResult.stderr).toBe(0);
      expect(termResult.stderr).toBe("");

      // Secret value must not leak to terminal.
      expect(termResult.stdout).not.toContain(secret);
      // Fragment removed from terminal URL.
      expect(termResult.stdout).not.toContain("#section");
      // Query key retained but value redacted.
      expect(termResult.stdout).toContain("token=");
      expect(termResult.stdout).toContain("redacted");
      // Control char escaped (literal backslash-u-brace form).
      expect(termResult.stdout).toContain("\\u{1}");
      // Bidi override escaped.
      expect(termResult.stdout).toContain("\\u{202e}");
      // Raw control / bidi bytes absent.
      expect(termResult.stdout).not.toContain("\u0001");
      expect(termResult.stdout).not.toContain("\u202e");

      const jsonResult = await execBinary(["check", "--format", "json"], cwd);
      expect(jsonResult.exitCode, jsonResult.stderr).toBe(0);
      const parsed = JSON.parse(jsonResult.stdout) as RunResultV1;
      // JSON preserves the exact configured URL (secret + fragment intact).
      expect(parsed.targets[0]!.url).toBe(secretUrl);
      // JSON preserves the exact target name with raw control/bidi code points.
      expect(parsed.targets[0]!.name).toBe(controlName);
    }, CHECK_TIMEOUT);

    // --------------------------------------- deterministic repeated JSON (R51, KTD11)

    test("repeated identical check produces byte-identical JSON", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "det", url: `${acceptance.url}/settings` }] },
      });
      const first = await execBinary(["check", "--format", "json"], cwd);
      const second = await execBinary(["check", "--format", "json"], cwd);
      expect(first.exitCode).toBe(1);
      expect(first.stdout).toBe(second.stdout);
    }, CHECK_TIMEOUT);

    // ---------------------- concurrent check processes with no vlint lock (R47)

    test("two concurrent check processes both complete without interference", async () => {
      const cwdA = await tempDir();
      const cwdB = await tempDir();
      await writeConfig(cwdA, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "conc-a", url: `${acceptance.url}/clean` }] },
      });
      await writeConfig(cwdB, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "conc-b", url: `${acceptance.url}/clean` }] },
      });
      const [a, b] = await Promise.all([
        execBinary(["check", "--format", "json"], cwdA),
        execBinary(["check", "--format", "json"], cwdB),
      ]);
      expect(a.exitCode, a.stderr).toBe(0);
      expect(b.exitCode, b.stderr).toBe(0);
      expect(a.stderr).toBe("");
      expect(b.stderr).toBe("");
      const pa = JSON.parse(a.stdout) as RunResultV1;
      const pb = JSON.parse(b.stdout) as RunResultV1;
      expect(pa.status).toBe("clean");
      expect(pb.status).toBe("clean");
      expect(pa.targets[0]!.name).toBe("conc-a");
      expect(pb.targets[0]!.name).toBe("conc-b");
    }, CHECK_TIMEOUT);

    // --------------------- agent fix-and-rerun: exit 1 then corrected exit 0

    test("agent fix-and-rerun: wrapped page exit 1, corrected page exit 0", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 1,
        provider: { type: "static", targets: [{ name: "fix", url: `${acceptance.url}/settings` }] },
      });

      // Before fix: tab wraps → violation.
      acceptance.setSettingsWrapped(true);
      const before = await execBinary(["check", "--format", "json"], cwd);
      expect(before.exitCode, before.stderr).toBe(1);
      const beforeParsed = JSON.parse(before.stdout) as RunResultV1;
      expect(beforeParsed.status).toBe("violations");
      expect(beforeParsed.summary.violations).toBe(1);

      // Agent widens the tab → no wrap.
      acceptance.setSettingsWrapped(false);
      const after = await execBinary(["check", "--format", "json"], cwd);
      expect(after.exitCode, after.stderr).toBe(0);
      const afterParsed = JSON.parse(after.stdout) as RunResultV1;
      expect(afterParsed.status).toBe("clean");
      expect(afterParsed.summary.violations).toBe(0);
    }, CHECK_TIMEOUT);
  },
);
