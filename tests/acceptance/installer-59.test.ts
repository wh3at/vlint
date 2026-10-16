import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("retired setup cannot mutate a project", async () => {
  const proc = Bun.spawn([resolve("dist/vlint-linux-x64"), "setup"], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stdout).not.toContain("vlint setup");
  expect(stderr).toContain("unknown command 'setup'");
});
