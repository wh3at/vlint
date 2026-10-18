import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

for (const phase of ["already", "validation", "launch", "close"]) {
  test(`browser status promptly cancels during ${phase}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "vlint-cancellation-"));
    try {
      const script = join(directory, "probe.ts");
      await writeFile(script, `
import { expect, mock } from "bun:test";
import coreBundle from ${JSON.stringify(join(root, "node_modules/playwright-core/lib/coreBundle.js"))};
const registry = coreBundle.registry.registry;
const phase = ${JSON.stringify(phase)};
const controller = new AbortController();
let validations = 0;
let launches = 0;
let closes = 0;
let finish;
const pending = new Promise(resolve => { finish = resolve; });
registry.validateHostRequirementsForExecutablesIfNeeded = async () => {
  validations++;
  if (phase === "validation") { queueMicrotask(() => controller.abort()); await pending; }
};
const browser = {
  version: () => registry.findExecutable("chromium-headless-shell").browserVersion,
  newPage: async () => ({ close: async () => {} }),
  close: async () => {
    closes++;
    if (phase === "close") { queueMicrotask(() => controller.abort()); await pending; }
  },
};
mock.module(${JSON.stringify(join(root, "node_modules/playwright/index.mjs"))}, () => Object.fromEntries(
  ["chromium", "firefox", "webkit"].map(engine => [engine, {
    launch: async () => {
      launches++;
      if (phase === "launch") { queueMicrotask(() => controller.abort()); await pending; }
      return browser;
    },
  }]),
));
const { inspectManagedBrowsers } = await import(${JSON.stringify(join(root, "src/browser/management.ts"))});
if (phase === "already") {
  controller.abort();
  await expect(inspectManagedBrowsers(controller.signal)).rejects.toBe(controller.signal.reason);
}
const { runBrowserStatus } = await import(${JSON.stringify(join(root, "src/commands/browser-status.ts"))});
const result = await Promise.race([
  runBrowserStatus({ format: "json", signal: controller.signal }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation timed out")), 500)),
]);
expect(result.ok).toBe(false);
expect(result.failure.code).toBe("signal-interrupt");
expect(validations).toBe(phase === "already" ? 0 : 1);
expect(launches).toBe(phase === "launch" || phase === "close" ? 1 : 0);
finish();
await new Promise(resolve => setTimeout(resolve, 10));
expect(closes).toBe(phase === "launch" || phase === "close" ? 1 : 0);
expect(validations).toBe(phase === "already" ? 0 : 1);
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
