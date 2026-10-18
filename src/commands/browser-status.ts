import { boundaryFailure, boundarySuccess, type BoundaryResult } from "../contracts/failure";
import { inspectManagedBrowsers } from "../browser/management";
import { escapeTerminal } from "../output/terminal";

export interface BrowserStatusOptions {
  readonly format: "terminal" | "json";
  readonly signal?: AbortSignal;
}

export interface BrowserStatusOutput {
  readonly output: string;
  readonly ready: boolean;
}

export async function runBrowserStatus(options: BrowserStatusOptions): Promise<BoundaryResult<BrowserStatusOutput>> {
  if (options.signal?.aborted) {
    return boundaryFailure({ stage: "interrupt", code: "signal-interrupt", message: "operation cancelled", target: null, device: null, rule: null });
  }
  let status: Awaited<ReturnType<typeof inspectManagedBrowsers>>;
  try {
    status = await inspectManagedBrowsers(options.signal);
  } catch (error) {
    if (!options.signal?.aborted) throw error;
    return boundaryFailure({ stage: "interrupt", code: "signal-interrupt", message: "operation cancelled", target: null, device: null, rule: null });
  }
  const output = options.format === "json" ? JSON.stringify(status) + "\n" : [
    `browser status: ${status.ready ? "ready" : "unavailable"}`,
    ...status.engines.flatMap((engine) => [
      `  ${engine.engine}: ${engine.status}`,
      `    expected version: ${engine.expectedVersion ?? "unknown"}`,
      `    obtained version: ${engine.obtainedVersion ?? "unavailable"} (${engine.versionSource ?? "unavailable"})`,
      `    revision: ${engine.revision}`,
      `    executable: ${escapeTerminal(engine.executablePath)}`,
      ...(engine.diagnostic === null ? [] : [`    diagnostic: ${engine.diagnostic}`]),
    ]),
    ...(status.ready ? [] : ["  run 'vlint browser install --force' to repair"]), "",
  ].join("\n");
  return boundarySuccess({ output, ready: status.ready });
}
