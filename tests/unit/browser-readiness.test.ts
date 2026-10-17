import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

for (const mismatch of [null, "chromium", "firefox", "webkit"]) {
  test(`browser status and preparation require managed versions: ${mismatch ?? "all match"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "vlint-readiness-"));
    try {
      const script = join(directory, "probe.ts");
      await writeFile(script, `
import { expect, mock } from "bun:test";
import coreBundle from ${JSON.stringify(join(root, "node_modules/playwright-core/lib/coreBundle.js"))};
const registry = coreBundle.registry.registry;
registry.validateHostRequirementsForExecutablesIfNeeded = async () => {};
const mismatch = ${JSON.stringify(mismatch)};
mock.module(${JSON.stringify(join(root, "node_modules/playwright/index.mjs"))}, () => Object.fromEntries(
  ["chromium", "firefox", "webkit"].map(engine => [engine, {
    launch: async () => ({
      version: () => engine === mismatch ? "0.0" : registry.findExecutable(engine === "chromium" ? "chromium-headless-shell" : engine).browserVersion,
      newPage: async () => ({ close: async () => {} }),
      close: async () => {},
    }),
  }]),
));
const { inspectManagedBrowsers } = await import(${JSON.stringify(join(root, "src/browser/management.ts"))});
const status = await inspectManagedBrowsers();
expect(status.ready).toBe(mismatch === null);
for (const engine of status.engines) {
  expect(engine.status).toBe(engine.engine === mismatch ? "unavailable" : "ready");
  expect(engine.versionSource).toBe(engine.engine === "webkit" ? "playwright-metadata" : "browser.version");
  if (engine.engine === mismatch) {
    expect(engine.expectedVersion).not.toBe(engine.obtainedVersion);
    expect(engine.diagnostic).toContain("version");
  }
}
const { runBrowserStatus } = await import(${JSON.stringify(join(root, "src/commands/browser-status.ts"))});
const rendered = await runBrowserStatus({ format: "json" });
expect(rendered.ok).toBe(true);
expect(rendered.value.ready).toBe(mismatch === null);
expect(JSON.parse(rendered.value.output).ready).toBe(mismatch === null);
Bun.spawn = () => ({ pid: 1, exited: Promise.resolve(0) });
const { installBrowser } = await import(${JSON.stringify(join(root, "src/browser/install.ts"))});
for (const force of [false, true]) {
  const installed = await installBrowser({ force });
  expect(installed.ok).toBe(mismatch === null);
  if (!installed.ok) expect(installed.failure.code).toBe("browser-install-failed");
}
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
}
