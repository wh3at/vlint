import { expect, test } from "bun:test";

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runValidation(): Promise<ProcessResult> {
  const process = Bun.spawn(["tests/release/validate.sh"], {
    cwd: import.meta.dir.replace(/\/tests\/smoke$/, ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test(
  "compiled artifact installs and launches Playwright in clean guests",
  async () => {
    const result = await runValidation();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("U1 compiled Playwright feasibility gate passed");
  },
  900_000,
);
