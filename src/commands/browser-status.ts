import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
} from "../contracts/failure";
import {
  inspectBrowserRequirements,
  type EnvironmentView,
} from "../browser/install";

export interface BrowserStatusOptions {
  readonly format: "terminal" | "json";
  readonly environment?: EnvironmentView;
  readonly signal?: AbortSignal;
}

export interface BrowserStatusOutput {
  readonly output: string;
  readonly ready: boolean;
}

export function runBrowserStatus(
  options: BrowserStatusOptions,
): BoundaryResult<BrowserStatusOutput> {
  if (options.signal?.aborted === true) {
    return boundaryFailure({
      stage: "interrupt",
      code: "signal-interrupt",
      message: "operation interrupted by signal",
      target: null,
      device: null,
      rule: null,
    });
  }

  const snapshot = inspectBrowserRequirements({
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
  });
  if (!snapshot.ok) return boundaryFailure(snapshot.failure);

  const info = snapshot.value;
  const ready = info.status === "ready";

  let output: string;
  if (options.format === "json") {
    output =
      JSON.stringify({
        status: info.status,
        requirements: {
          name: info.requirements.name,
          revision: info.requirements.revision,
          browserVersion: info.requirements.browserVersion,
          executablePath: info.requirements.executablePath,
          cacheRoot: info.requirements.cacheRoot,
        },
        environment: {
          xdgCacheHome: info.environment.xdgCacheHome,
          playwrightBrowsersPath: info.environment.playwrightBrowsersPath,
        },
        detectedRevisions: info.detectedRevisions,
        executablePresent: info.executablePresent,
        executableAccessible: info.executableAccessible,
      }) + "\n";
  } else {
    const lines = [
      `browser status: ${info.status}`,
      `  revision: ${info.requirements.revision}`,
      `  version: ${info.requirements.browserVersion}`,
      `  executable: ${info.requirements.executablePath}`,
      `  cache: ${info.requirements.cacheRoot}`,
    ];
    if (info.detectedRevisions.length > 0) {
      const revisions = info.detectedRevisions
        .map((e) => e.revision)
        .join(", ");
      lines.push(`  detected revisions: ${revisions}`);
    }
    if (!ready) {
      lines.push(`  run 'vlint browser install' to repair`);
    }
    lines.push("");
    output = lines.join("\n");
  }

  return boundarySuccess({ output, ready });
}
