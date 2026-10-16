import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve("dist/vlint-linux-x64");
async function check(cwd: string, temp: string, format = "json") {
  const proc = Bun.spawn([binary, "check", "--format", format], { cwd, env: { ...process.env, TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("compiled planning failures retain the same run in unique private TMPDIR reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlint-60-"));
  try {
    const outputs = await Promise.all([check(directory, directory), check(directory, directory)]);
    const paths: string[] = [];
    for (const output of outputs) {
      expect(output.code).toBe(2);
      const result = JSON.parse(output.stdout);
      expect(typeof result.reportPath).toBe("string");
      paths.push(result.reportPath);
      expect(result.reportPath.startsWith(directory + "/")).toBe(true);
      const report = JSON.parse(await readFile(result.reportPath, "utf8"));
      expect(report.status).toBe("incomplete");
      expect(report.failures[0].code).toBe("config-not-found");
      expect(report.cases).toEqual([]);
      expect(report.tool).toEqual(result.tool);
      expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(result.reportPath, ".."))).mode & 0o777).toBe(0o700);
    }
    expect(paths[0]).not.toBe(paths[1]);
    const terminal = await check(directory, directory, "terminal");
    expect(terminal.stdout).toContain("reportPath:");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("compiled report storage failure is brief, incomplete and never advertises a missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vlint-60-failure-"));
  try {
    const output = await check(directory, join(directory, "missing", "temp"));
    expect(output.code).toBe(2);
    const result = JSON.parse(output.stdout);
    expect(result.status).toBe("incomplete");
    expect(result.reportPath).toBeNull();
    expect(result.failures.at(-1).code).toBe("report-write-failed");
    expect(result.failures.at(-1).message).not.toContain(directory);
    expect(output.stdout.length).toBeLessThan(2000);
    expect(result.cases).toBeUndefined();
    expect(result.execution).toBeUndefined();
    const terminal = await check(directory, join(directory, "missing"), "terminal");
    expect(terminal.stdout).toContain("report-write-failed");
    expect(terminal.stdout).not.toContain("reportPath:");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
