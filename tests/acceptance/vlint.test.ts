import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { RunResultV2 } from "../../src/contracts/result";
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

const TEST_DEVICE = {
  name: "desktop",
  viewport: { width: 1280, height: 720 },
  screen: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;

/** Exact iPhone 17 user agent from Playwright 1.61.1 registry. */
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1";

/** Standard MacBook Air 13" (M5) profile — matches vlint init output. */
const MACBOOK_DEVICE = {
  name: "macbook-air-13-m5",
  viewport: { width: 1470, height: 956 },
  screen: { width: 1470, height: 956 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
} as const;

/** Standard iPhone 17 profile — matches vlint init output. */
const IPHONE_DEVICE = {
  name: "iphone-17",
  viewport: { width: 402, height: 681 },
  screen: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: IPHONE_UA,
} as const;

const STANDARD_DEVICES = [MACBOOK_DEVICE, IPHONE_DEVICE] as const;

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
  const content = typeof value === "string"
    ? value
    : JSON.stringify({ devices: [TEST_DEVICE], ...(value as Record<string, unknown>) });
  await writeFile(join(directory, "vlint.config.json"), content);
}

async function readConfigFile(directory: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(directory, "vlint.config.json"), "utf8");
  return JSON.parse(content) as Record<string, unknown>;
}

function firstFailure(result: RunResultV2): RunResultV2["failures"][number] | undefined {
  return result.failures[0]
    ?? result.cases.find((item) => item.failures.length > 0)?.failures[0]
    ?? result.cases.flatMap((item) => item.rules).find((item) => item.failure !== null)?.failure
    ?? result.ruleFinalizations.find((item) => item.failure !== null)?.failure
    ?? undefined;
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
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "clean", url: `${acceptance.url}/clean` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.split("\n")).toHaveLength(2);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.status).toBe("clean");
      expect(parsed.tool).toEqual({ name: "vlint", version: "0.1.0" });
      expect(parsed.environment).toMatchObject({ platform: "linux", arch: "x64" });
      expect(typeof parsed.environment.browser.version).toBe("string");
      expect(parsed.environment.browser.version!.length).toBeGreaterThan(0);
      expect(parsed.summary.cases).toMatchObject({ resolved: 1, complete: 1, failed: 0, notExecuted: 0 });
      expect(parsed.summary.violations).toBe(0);
      expect(parsed.summary.matchedElements).toBe(2);
      expect(parsed.cases[0]).toMatchObject({ target: { name: "clean" }, status: "complete" });
      expect(parsed.cases[0]!.rules[0]).toMatchObject({ status: "clean", labelsInspected: 2 });
      expect(parsed.cases[0]!.rules[0]!.violations).toHaveLength(0);
      expect(parsed.ruleFinalizations[0]).toMatchObject({ status: "passed", labelsInspected: 2 });
      expect(firstFailure(parsed)).toBeUndefined();
    }, CHECK_TIMEOUT);

    // ----------------------------------------- wrapped-tabs violations (exit 1)

    test("wrapped-tabs violations exit 1 with schema/context/locator fields", async () => {
      const cwd = await tempDir();
      const targetUrl = `${acceptance.url}/settings`;
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "settings", url: targetUrl }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("violations");
      expect(parsed.summary.violations).toBe(1);
      expect(parsed.summary.matchedElements).toBe(1);

      const auditCase = parsed.cases[0]!;
      expect(auditCase.target.name).toBe("settings");
      expect(auditCase.target.url).toBe(targetUrl);
      expect(auditCase.device.viewport).toEqual({ width: 1280, height: 720 });
      expect(auditCase.device.deviceScaleFactor).toBe(1);
      expect(auditCase.status).toBe("complete");

      const rule = auditCase.rules[0]!;
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

    // -------------- mixed violation + navigation failure: collect-all (exit 2)

    test("mixed violation and navigation failure exits 2 incomplete, collects all cases", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
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

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("incomplete");

      // Collect-all: prior violations survive alongside the failing target.
      expect(parsed.summary.violations).toBeGreaterThanOrEqual(1);
      expect(parsed.cases[0]!.status).toBe("complete");
      expect(parsed.cases[0]!.rules[0]!.violations.length).toBeGreaterThanOrEqual(1);

      // Failing target.
      expect(parsed.cases[1]!.status).toBe("failed");

      // Remaining target completes despite the individual navigation failure.
      expect(parsed.cases[2]!.status).toBe("complete");
      expect(parsed.cases[2]!.rules[0]!.status).toBe("clean");

      // Authoritative failure points at the navigation target.
      expect(firstFailure(parsed)).toMatchObject({
        stage: "navigation",
        code: "navigation-http-status",
        target: "broken",
      });

      // Finalizations not evaluated because at least one case failed.
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
        schemaVersion: 2,
        provider: {
          type: "static",
          targets: [{ name: "secure", url: `${acceptance.url}/secure`, browserState: statePath }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("clean");
      expect(parsed.summary.matchedElements).toBe(2);
      expect(parsed.cases[0]!.status).toBe("complete");
      expect(firstFailure(parsed)).toBeUndefined();
    }, CHECK_TIMEOUT);

    test("invalid browser state fails at authentication stage (exit 2)", async () => {
      const cwd = await tempDir();
      const statePath = join(cwd, "bad-state.json");
      await writeFile(statePath, JSON.stringify({ cookies: "not-an-array", origins: 42 }));
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: {
          type: "static",
          targets: [{ name: "secure", url: `${acceptance.url}/secure`, browserState: statePath }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "authentication", code: "state-invalid", target: "secure" });
      expect(parsed.cases[0]!.status).toBe("failed");
    }, CHECK_TIMEOUT);

    // ----------------------------------- typed execution failures (navigation/font/ready)

    test("navigation HTTP failure classifies navigation-http-status (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "http500", url: `${fixture.url}/status?code=500` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "navigation", code: "navigation-http-status", target: "http500" });
    }, CHECK_TIMEOUT);

    test("web-font load failure classifies font-load-failed (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "font", url: `${fixture.url}/font-error.html` }] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "web-font", code: "font-load-failed", target: "font" });
    }, CHECK_TIMEOUT);

    test("invalid ready selector classifies ready-invalid-selector (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
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
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "ready-condition", code: "ready-invalid-selector", target: "ready" });
    }, CHECK_TIMEOUT);

    // --------------- ad hoc URL bypasses a deliberately failing provider (R21)

    test("ad hoc --url bypasses failing command provider and applies config defaults/global rules", async () => {
      const cwd = await tempDir();
      // Deliberately failing provider: cat of a non-existent path exits nonzero.
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "command", executable: CAT, args: [join(cwd, "missing.json")] },
        devices: [{ ...TEST_DEVICE, viewport: { width: 800, height: 600 }, screen: { width: 800, height: 600 } }],
        rules: [{ name: "custom-tabs", type: "tab-label-single-line" }],
      });
      const adhocUrl = `${acceptance.url}/clean`;
      const result = await execBinary(["check", "--url", adhocUrl, "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("clean");
      expect(firstFailure(parsed)).toBeUndefined();
      // Ad hoc target name and exact URL.
      expect(parsed.cases[0]!.target.name).toBe("adhoc");
      expect(parsed.cases[0]!.target.url).toBe(adhocUrl);
      // Config device applied.
      expect(parsed.cases[0]!.device.viewport).toEqual({ width: 800, height: 600 });
      // Global rule from config applied.
      expect(parsed.cases[0]!.rules[0]!.name).toBe("custom-tabs");
      expect(parsed.cases[0]!.rules[0]!.status).toBe("clean");
    }, CHECK_TIMEOUT);

    // ------------------------- Command Provider parity and failure (R17-R20)

    test("Command Provider returns same verdict as Static for identical targets", async () => {
      const targetUrl = `${acceptance.url}/clean`;

      const staticCwd = await tempDir();
      await writeConfig(staticCwd, {
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "cmd-parity", url: targetUrl }] },
      });
      const staticResult = await execBinary(["check", "--format", "json"], staticCwd);

      const cmdCwd = await tempDir();
      const targetsFile = join(cmdCwd, "targets.json");
      await writeFile(targetsFile, JSON.stringify({ targets: [{ name: "cmd-parity", url: targetUrl }] }));
      await writeConfig(cmdCwd, {
        schemaVersion: 2,
        provider: { type: "command", executable: CAT, args: [targetsFile] },
      });
      const cmdResult = await execBinary(["check", "--format", "json"], cmdCwd);

      expect(cmdResult.exitCode).toBe(staticResult.exitCode);
      const cmdParsed = JSON.parse(cmdResult.stdout) as RunResultV2;
      const staticParsed = JSON.parse(staticResult.stdout) as RunResultV2;
      expect(cmdParsed.status).toBe(staticParsed.status);
      expect(cmdParsed.summary.violations).toBe(staticParsed.summary.violations);
      expect(cmdParsed.summary.matchedElements).toBe(staticParsed.summary.matchedElements);
      expect(cmdParsed.cases[0]!.target.name).toBe("cmd-parity");
      expect(cmdParsed.cases[0]!.rules[0]!.status).toBe("clean");
    }, CHECK_TIMEOUT);

    test("Command Provider nonzero exit classifies provider-exit-nonzero (exit 2)", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "command", executable: CAT, args: [join(cwd, "nonexistent")] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "provider", code: "provider-exit-nonzero" });
    }, CHECK_TIMEOUT);

    test("Command Provider invalid JSON classifies provider-output-invalid (exit 2)", async () => {
      const cwd = await tempDir();
      const badFile = join(cwd, "bad.json");
      await writeFile(badFile, "definitely not json");
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "command", executable: CAT, args: [badFile] },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(firstFailure(parsed)).toMatchObject({ stage: "provider", code: "provider-output-invalid" });
    }, CHECK_TIMEOUT);

    // --------------- terminal secret redaction, control escaping, JSON exactness

    test("terminal redacts query secrets and fragments, escapes control/bidi chars; JSON preserves exact data", async () => {
      const cwd = await tempDir();
      // Generated in test memory — never a persisted credential fixture.
      const secret = "S3CR3T-VALUE-9k2";
      const controlName = "t\u0001ab\u202e";
      const secretUrl = `${acceptance.url}/clean?token=${secret}#section`;
      await writeConfig(cwd, {
        schemaVersion: 2,
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
      const parsed = JSON.parse(jsonResult.stdout) as RunResultV2;
      // JSON preserves the exact configured URL (secret + fragment intact).
      expect(parsed.cases[0]!.target.url).toBe(secretUrl);
      // JSON preserves the exact target name with raw control/bidi code points.
      expect(parsed.cases[0]!.target.name).toBe(controlName);
    }, CHECK_TIMEOUT);

    // --------------------------------------- deterministic repeated JSON (R51, KTD11)

    test("repeated identical check produces byte-identical JSON", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
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
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "conc-a", url: `${acceptance.url}/clean` }] },
      });
      await writeConfig(cwdB, {
        schemaVersion: 2,
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
      const pa = JSON.parse(a.stdout) as RunResultV2;
      const pb = JSON.parse(b.stdout) as RunResultV2;
      expect(pa.status).toBe("clean");
      expect(pb.status).toBe("clean");
      expect(pa.cases[0]!.target.name).toBe("conc-a");
      expect(pb.cases[0]!.target.name).toBe("conc-b");
    }, CHECK_TIMEOUT);

    // --------------------- agent fix-and-rerun: exit 1 then corrected exit 0

    test("agent fix-and-rerun: wrapped page exit 1, corrected page exit 0", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        provider: { type: "static", targets: [{ name: "fix", url: `${acceptance.url}/settings` }] },
      });

      // Before fix: tab wraps → violation.
      acceptance.setSettingsWrapped(true);
      const before = await execBinary(["check", "--format", "json"], cwd);
      expect(before.exitCode, before.stderr).toBe(1);
      const beforeParsed = JSON.parse(before.stdout) as RunResultV2;
      expect(beforeParsed.status).toBe("violations");
      expect(beforeParsed.summary.violations).toBe(1);

      // Agent widens the tab → no wrap.
      acceptance.setSettingsWrapped(false);
      const after = await execBinary(["check", "--format", "json"], cwd);
      expect(after.exitCode, after.stderr).toBe(0);
      const afterParsed = JSON.parse(after.stdout) as RunResultV2;
      expect(afterParsed.status).toBe("clean");
      expect(afterParsed.summary.violations).toBe(0);
    }, CHECK_TIMEOUT);

    // ============================================================= Multi-device
    // AE1-AE8 and mobile-only regression: compiled binary proof for the
    // version 2 multi-device contract. These tests exercise the real init
    // command, the standard two-device config, cross-product ordering,
    // collect-all failure isolation, and the desktop-clean/mobile-violation
    // regression that motivated the feature.

    // -------------------------------------------------- AE1: new initialization

    test("AE1 init generates exact two-device config with no provider or url", async () => {
      const cwd = await tempDir();
      const result = await execBinary(["init"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("vlint init: created vlint.config.json\n");
      expect(result.stderr).toBe("");

      const config = await readConfigFile(cwd);
      expect(config.schemaVersion).toBe(2);
      // Device-only: no provider or url key at all.
      expect(config).not.toHaveProperty("provider");

      const devices = config.devices as readonly Record<string, unknown>[];
      expect(devices).toHaveLength(2);

      // MacBook Air 13" (M5): exact profile, no userAgent key.
      expect(devices[0]).toMatchObject({
        name: "macbook-air-13-m5",
        viewport: { width: 1470, height: 956 },
        screen: { width: 1470, height: 956 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: false,
      });
      expect(devices[0]).not.toHaveProperty("userAgent");

      // iPhone 17: exact profile from Playwright 1.61.1 registry.
      expect(devices[1]).toMatchObject({
        name: "iphone-17",
        viewport: { width: 402, height: 681 },
        screen: { width: 402, height: 874 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_UA,
      });

      // Standard rule pinned into the config.
      const rules = config.rules as readonly Record<string, unknown>[];
      expect(rules).toEqual([{ name: "tab-label-single-line", type: "tab-label-single-line" }]);
    });

    // ------------------------------------------- AE2: existing config protected

    test("AE2 init refuses to overwrite an existing config and preserves bytes", async () => {
      const cwd = await tempDir();
      const original = JSON.stringify({
        schemaVersion: 2,
        devices: [MACBOOK_DEVICE],
        rules: [{ name: "custom", type: "tab-label-single-line" }],
      });
      await writeFile(join(cwd, "vlint.config.json"), original);

      const result = await execBinary(["init"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stderr).toContain("config-already-exists");
      expect(result.stdout).toBe("");

      // File bytes are unchanged.
      const after = await readFile(join(cwd, "vlint.config.json"), "utf8");
      expect(after).toBe(original);
    });

    // --------------------- AE3: init → check --url audits both devices (exit 0)

    test("AE3 init then check --url audits the same URL on both standard devices", async () => {
      const cwd = await tempDir();
      await execBinary(["init"], cwd);

      const targetUrl = `${acceptance.url}/clean`;
      const result = await execBinary(["check", "--url", targetUrl, "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.status).toBe("clean");
      expect(parsed.summary.cases).toMatchObject({ resolved: 2, complete: 2, failed: 0, notExecuted: 0 });
      expect(parsed.summary.targets.resolved).toBe(1);

      // Both cases target the same ad hoc URL, ordered MacBook then iPhone.
      expect(parsed.cases).toHaveLength(2);
      expect(parsed.cases[0]!.target).toEqual({ name: "adhoc", url: targetUrl });
      expect(parsed.cases[0]!.device.name).toBe("macbook-air-13-m5");
      expect(parsed.cases[0]!.device.viewport).toEqual({ width: 1470, height: 956 });
      expect(parsed.cases[0]!.device.deviceScaleFactor).toBe(2);
      expect(parsed.cases[1]!.target).toEqual({ name: "adhoc", url: targetUrl });
      expect(parsed.cases[1]!.device.name).toBe("iphone-17");
      expect(parsed.cases[1]!.device.viewport).toEqual({ width: 402, height: 681 });
      expect(parsed.cases[1]!.device.isMobile).toBe(true);
      expect(parsed.cases[1]!.device.userAgent).toBe(IPHONE_UA);
      expect(firstFailure(parsed)).toBeUndefined();
    }, CHECK_TIMEOUT);

    // ------------------- AE4: device-only no --url fails targets-empty (exit 2)

    test("AE4 device-only config without --url fails targets-empty before browser launch", async () => {
      const cwd = await tempDir();
      await execBinary(["init"], cwd);

      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("incomplete");
      expect(parsed.summary.cases).toMatchObject({ resolved: 0, complete: 0, failed: 0, notExecuted: 0 });
      expect(firstFailure(parsed)).toMatchObject({ stage: "config", code: "targets-empty" });
    });

    // -------- AE5: 2 targets × 2 devices → 4 ordered cases with device viewports

    test("AE5 two targets and two devices produce four ordered cases with device-specific viewports", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        devices: STANDARD_DEVICES,
        provider: {
          type: "static",
          targets: [
            { name: "alpha", url: `${acceptance.url}/clean` },
            { name: "beta", url: `${acceptance.url}/clean` },
          ],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.summary.targets.resolved).toBe(2);
      expect(parsed.summary.cases).toMatchObject({ resolved: 4, complete: 4, failed: 0, notExecuted: 0 });
      expect(parsed.cases).toHaveLength(4);

      // Target-major / device-minor order, regardless of completion timing.
      const expected = [
        { target: "alpha", device: "macbook-air-13-m5" },
        { target: "alpha", device: "iphone-17" },
        { target: "beta", device: "macbook-air-13-m5" },
        { target: "beta", device: "iphone-17" },
      ];
      for (let i = 0; i < 4; i += 1) {
        expect(parsed.cases[i]!.target.name).toBe(expected[i]!.target);
        expect(parsed.cases[i]!.device.name).toBe(expected[i]!.device);
      }

      // Device-specific viewport confirmed for each case.
      expect(parsed.cases[0]!.device.viewport).toEqual({ width: 1470, height: 956 });
      expect(parsed.cases[1]!.device.viewport).toEqual({ width: 402, height: 681 });
      expect(parsed.cases[2]!.device.viewport).toEqual({ width: 1470, height: 956 });
      expect(parsed.cases[3]!.device.viewport).toEqual({ width: 402, height: 681 });
    }, CHECK_TIMEOUT);

    // -------- AE6: one navigation failure, remaining multi-device cases complete

    test("AE6 navigation failure on one target still completes remaining target×device cases", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        devices: STANDARD_DEVICES,
        provider: {
          type: "static",
          targets: [
            { name: "good-a", url: `${acceptance.url}/clean` },
            { name: "broken", url: `${fixture.url}/status?code=500` },
            { name: "good-b", url: `${acceptance.url}/clean` },
          ],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(2);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("incomplete");
      expect(parsed.summary.cases).toMatchObject({ resolved: 6, complete: 4, failed: 2, notExecuted: 0 });

      // Ordered: good-a×mac, good-a×iphone, broken×mac, broken×iphone, good-b×mac, good-b×iphone.
      expect(parsed.cases[0]!.target.name).toBe("good-a");
      expect(parsed.cases[0]!.device.name).toBe("macbook-air-13-m5");
      expect(parsed.cases[0]!.status).toBe("complete");

      expect(parsed.cases[1]!.target.name).toBe("good-a");
      expect(parsed.cases[1]!.device.name).toBe("iphone-17");
      expect(parsed.cases[1]!.status).toBe("complete");

      // The broken target fails on both devices, but other cases still ran.
      expect(parsed.cases[2]!.target.name).toBe("broken");
      expect(parsed.cases[2]!.status).toBe("failed");
      expect(parsed.cases[3]!.target.name).toBe("broken");
      expect(parsed.cases[3]!.status).toBe("failed");

      expect(parsed.cases[4]!.target.name).toBe("good-b");
      expect(parsed.cases[4]!.device.name).toBe("macbook-air-13-m5");
      expect(parsed.cases[4]!.status).toBe("complete");
      expect(parsed.cases[5]!.target.name).toBe("good-b");
      expect(parsed.cases[5]!.device.name).toBe("iphone-17");
      expect(parsed.cases[5]!.status).toBe("complete");

      expect(firstFailure(parsed)).toMatchObject({
        stage: "navigation",
        code: "navigation-http-status",
        target: "broken",
      });
    }, CHECK_TIMEOUT);

    // ------------------------------------- AE7: single-device config → 1 case

    test("AE7 editing devices to one produces exactly one case per target", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        devices: [IPHONE_DEVICE],
        provider: {
          type: "static",
          targets: [
            { name: "only", url: `${acceptance.url}/clean` },
          ],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(0);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.summary.targets.resolved).toBe(1);
      expect(parsed.summary.cases.resolved).toBe(1);
      expect(parsed.cases).toHaveLength(1);
      expect(parsed.cases[0]!.device.name).toBe("iphone-17");
      expect(parsed.cases[0]!.device.viewport).toEqual({ width: 402, height: 681 });
    }, CHECK_TIMEOUT);

    // ----------------------- AE8: no config file → check rejected pre-browser

    test("AE8 missing config rejects check with or without --url before browser launch", async () => {
      const cwd = await tempDir();

      // With --url: still requires a config (R8, no implicit fallback).
      const withUrl = await execBinary(["check", "--url", `${acceptance.url}/clean`, "--format", "json"], cwd);
      expect(withUrl.exitCode, withUrl.stderr).toBe(2);
      const withUrlParsed = JSON.parse(withUrl.stdout) as RunResultV2;
      expect(firstFailure(withUrlParsed)).toMatchObject({ stage: "config", code: "config-not-found" });

      // Without --url: same config-not-found (no browser launched in either path).
      const noUrl = await execBinary(["check", "--format", "json"], cwd);
      expect(noUrl.exitCode, noUrl.stderr).toBe(2);
      const noUrlParsed = JSON.parse(noUrl.stdout) as RunResultV2;
      expect(firstFailure(noUrlParsed)).toMatchObject({ stage: "config", code: "config-not-found" });
    });

    // ---- mobile-only regression: desktop clean, iPhone violation (real browser)

    test("mobile-only regression: MacBook clean, iPhone detects wrapped label that desktop misses", async () => {
      const cwd = await tempDir();
      await writeConfig(cwd, {
        schemaVersion: 2,
        devices: STANDARD_DEVICES,
        provider: {
          type: "static",
          targets: [{ name: "responsive", url: `${acceptance.url}/mobile-only` }],
        },
      });
      const result = await execBinary(["check", "--format", "json"], cwd);
      expect(result.exitCode, result.stderr).toBe(1);

      const parsed = JSON.parse(result.stdout) as RunResultV2;
      expect(parsed.status).toBe("violations");
      expect(parsed.cases).toHaveLength(2);

      // MacBook case: the wide label fits on one line → clean.
      const macbook = parsed.cases[0]!;
      expect(macbook.device.name).toBe("macbook-air-13-m5");
      expect(macbook.device.viewport).toEqual({ width: 1470, height: 956 });
      expect(macbook.status).toBe("complete");
      expect(macbook.rules[0]!.status).toBe("clean");
      expect(macbook.rules[0]!.violations).toHaveLength(0);

      // iPhone case: same label wraps at 402px → violation detected.
      const iphone = parsed.cases[1]!;
      expect(iphone.device.name).toBe("iphone-17");
      expect(iphone.device.viewport).toEqual({ width: 402, height: 681 });
      expect(iphone.status).toBe("complete");
      expect(iphone.rules[0]!.status).toBe("violations");
      expect(iphone.rules[0]!.violations.length).toBeGreaterThanOrEqual(1);
      expect(iphone.rules[0]!.violations[0]!.lineCount).toBeGreaterThanOrEqual(2);
    }, CHECK_TIMEOUT);
  },
);
