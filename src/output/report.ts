import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../contracts/result";

export async function persistReport(result: RunResult): Promise<RunResult & { readonly reportPath: string | null }> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "vlint-"));
    await chmod(directory, 0o700);
    const reportPath = join(directory, "report.json");
    await writeFile(reportPath, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" });
    return { ...result, reportPath };
  } catch {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...result,
      status: "incomplete",
      summary: { ...result.summary, executionFailures: result.summary.executionFailures + 1 },
      failures: [...result.failures, { stage: "report", code: "report-write-failed", message: "could not save complete report in the OS temporary directory; check temporary storage and permissions", target: null, device: null, rule: null }],
      reportPath: null,
    };
  }
}
