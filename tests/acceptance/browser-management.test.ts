import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled browser status probes three engines without installing into an empty cache", async () => {
  const cache = mkdtempSync(join(tmpdir(), "vlint-56-status-"));
  try {
    const proc = Bun.spawn([resolve("dist/vlint-linux-x64"), "browser", "status", "--format", "json"], {
      cwd: cache,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, PLAYWRIGHT_SKIP_BROWSER_GC: "1", PLAYWRIGHT_DOWNLOAD_HOST: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(2);
    const status = JSON.parse(output);
    expect(status.engines.map((engine: { engine: string }) => engine.engine)).toEqual(["chromium", "firefox", "webkit"]);
    expect(status.engines.every((engine: { status: string }) => engine.status === "unavailable")).toBe(true);
    expect(await Array.fromAsync(new Bun.Glob("*").scan(cache))).toEqual([]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
