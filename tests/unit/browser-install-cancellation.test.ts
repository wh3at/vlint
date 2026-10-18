import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

for (const phase of ["before", "after"]) {
  for (const failure of ["abort", "custom-abort", "unrelated"]) {
    test(`browser install handles ${failure} during ${phase} probe`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "vlint-install-cancellation-"));
      try {
        const script = join(directory, "probe.ts");
        await writeFile(script, `
import { expect, mock } from "bun:test";
const controller = new AbortController();
const error = new Error("probe failed");
let probes = 0;
let installs = 0;
mock.module(${JSON.stringify(join(root, "src/browser/management.ts"))}, () => ({
  managedExecutable: () => {},
  prepareManagedBrowsers: async () => {},
  inspectManagedBrowsers: async () => {
    probes++;
    if (probes === ${phase === "before" ? 1 : 2}) {
      if (${JSON.stringify(failure)} === "unrelated") throw error;
      controller.abort(${failure === "custom-abort" ? '"custom reason"' : ""});
      throw controller.signal.reason;
    }
    return { ready: true };
  },
}));
Bun.spawn = () => { installs++; return { pid: 1, exited: Promise.resolve(0) }; };
const { installBrowser } = await import(${JSON.stringify(join(root, "src/browser/install.ts"))});
const result = installBrowser({ force: false, signal: controller.signal });
if (${JSON.stringify(failure)} === "unrelated") {
  await expect(result).rejects.toBe(error);
} else {
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  expect(outcome.failure.code).toBe("signal-interrupt");
}
expect(probes).toBe(${phase === "before" ? 1 : 2});
expect(installs).toBe(${phase === "before" ? 0 : 1});
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
}
