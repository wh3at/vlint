import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";
import { installBrowser, type EnvironmentView, type InstallOptions, type InstallOutcome } from "../browser/install";

export interface BrowserInstallCommandOptions {
  readonly args: readonly string[];
  readonly environment?: EnvironmentView;
  readonly signal?: AbortSignal;
  readonly browserInstaller?: (options: InstallOptions) => Promise<BoundaryResult<InstallOutcome>>;
}

export type BrowserInstallCommandResult =
  | { readonly ok: true; readonly outcome: InstallOutcome }
  | { readonly ok: false; readonly failure: Failure };

export function parseBrowserInstallArgs(args: readonly string[]): BoundaryResult<{ readonly force: boolean }> {
  let force = false;
  for (const argument of args) {
    if (argument !== "--force" || force) {
      return boundaryFailure({ stage: "config", code: "config-schema-invalid",
        message: argument === "--force" ? "duplicate option: --force" : `unknown argument to 'vlint browser install': ${argument}`,
        target: null, device: null, rule: null });
    }
    force = true;
  }
  return boundarySuccess({ force });
}

export async function runBrowserInstall(options: BrowserInstallCommandOptions): Promise<BrowserInstallCommandResult> {
  const parsed = parseBrowserInstallArgs(options.args);
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  const result = await (options.browserInstaller ?? installBrowser)({
    force: parsed.value.force,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  return { ok: true, outcome: result.value };
}
