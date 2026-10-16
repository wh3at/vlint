import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled JSON presents concise planning failure without full execution details", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vlint-61-"));
  try {
    const process = Bun.spawn([resolve("dist/vlint-linux-x64"), "check", "--format", "json"], { cwd, stdout: "pipe" });
    const output = JSON.parse(await new Response(process.stdout).text());
    expect(await process.exited).toBe(2);
    expect(output.status).toBe("incomplete");
    expect(output.cases).toBeUndefined();
    expect(output.execution).toBeUndefined();
    expect(output.environmentRules).toEqual([]);
    expect(output.diagnostics).toEqual([]);
    expect(output.failures[0].code).toBe("config-not-found");
    expect(output.reportPath).toBeString();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
