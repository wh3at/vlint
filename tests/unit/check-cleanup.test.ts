import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("check retains returned and thrown engine cleanup failures and closes remaining engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlint-cleanup-"));
  try {
    await writeFile(join(directory, "vlint.config.json"), JSON.stringify({
      devices: [{ name: "desk", viewport: { width: 1280, height: 720 }, screen: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }],
      environments: ["chromium", "firefox", "webkit"].map(browser => ({ name: `windows-${browser}`, platform: browser === "webkit" ? "macos" : "windows", browser, devices: ["desk"] })),
    }));
    const script = join(directory, "probe.ts");
    await writeFile(script, `
import { expect, mock } from "bun:test";
const closed = [];
const management = await import(${JSON.stringify(join(root, "src/browser/management.ts"))});
mock.module(${JSON.stringify(join(root, "src/browser/management.ts"))}, () => ({
  ...management,
  managedEngineExecution: engine => ({ engine, expectedVersion: null }),
}));
mock.module(${JSON.stringify(join(root, "src/browser/lifecycle.ts"))}, () => ({
  createBrowserRunScope: async ({ engine }) => ({ ok: true, value: {
    browserVersion: "test",
    acquireCase: async () => ({ ok: true, value: { page: {}, actualUrl: "https://example.com/", close: async () => ({ ok: true, value: undefined }) } }),
    close: async () => {
      closed.push(engine);
      if (engine === "firefox") throw new Error("thrown close failure");
      if (engine === "chromium") return { ok: false, failure: { stage: "browser-setup", code: "browser-cleanup-failed", message: "returned close failure", target: null, device: null, rule: null } };
      return { ok: true, value: undefined };
    },
  } }),
}));
mock.module(${JSON.stringify(join(root, "src/browser/measurement.ts"))}, () => ({
  measureRule: async () => ({ facts: { elementsInspected: 1, violations: [] }, failure: null }),
}));
const { runCheckCommand } = await import(${JSON.stringify(join(root, "src/commands/check.ts"))});
const result = await runCheckCommand(${JSON.stringify(directory)}, "https://example.com/", {}, "test");
expect(closed).toEqual(["chromium", "firefox", "webkit"]);
expect(result.status).toBe("incomplete");
expect(result.cases).toHaveLength(3);
expect(result.cases.every(item => item.status === "complete")).toBe(true);
expect(result.summary.cases.complete).toBe(3);
expect(result.failures).toHaveLength(2);
expect(result.failures.map(item => item.code)).toEqual(["browser-cleanup-failed", "browser-cleanup-failed"]);
expect(result.failures.map(item => item.message)).toEqual(["chromium: returned close failure", "firefox: thrown close failure"]);
expect(result.summary.executionFailures).toBe(2);
`);
    const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
