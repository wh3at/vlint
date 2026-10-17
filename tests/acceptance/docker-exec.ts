import { expect } from "bun:test";

export async function exec(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["docker", "exec", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

export async function readReport(container: string, reportPath: string) {
  expect(reportPath).toBeString();
  const { stdout, stderr, code } = await exec([container, "cat", reportPath]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}
