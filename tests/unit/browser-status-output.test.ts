import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("browser status escapes executable paths only for terminal output and recommends forced repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlint-status-output-"));
  try {
    const script = join(directory, "probe.ts");
    const executablePath = "/cache/\u001b[31m\n\r\t\u009b\u202ebrowser";
    await writeFile(script, `
import { expect, mock } from "bun:test";
const executablePath = ${JSON.stringify(executablePath)};
const status = { ready: false, engines: [{
  engine: "chromium", status: "unavailable", expectedVersion: null,
  obtainedVersion: null, versionSource: null, revision: "1", executablePath, diagnostic: null,
}] };
mock.module(${JSON.stringify(join(root, "src/browser/management.ts"))}, () => ({
  inspectManagedBrowsers: async () => status,
}));
const { runBrowserStatus } = await import(${JSON.stringify(join(root, "src/commands/browser-status.ts"))});
const terminal = await runBrowserStatus({ format: "terminal" });
expect(terminal.ok).toBe(true);
expect(terminal.value.output).toContain(${JSON.stringify("    executable: /cache/\\u{1b}[31m\\n\\r\\t\\u{9b}\\u{202e}browser")});
expect(terminal.value.output).not.toContain(executablePath);
expect(terminal.value.output).toContain("run 'vlint browser install --force' to repair");
const json = await runBrowserStatus({ format: "json" });
expect(json.ok).toBe(true);
expect(JSON.parse(json.value.output)).toEqual(status);
status.ready = true;
const ready = await runBrowserStatus({ format: "terminal" });
expect(ready.value.output).not.toContain("to repair");
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
